-- ============================================================
-- Transactional, concurrency-safe computation snapshot publication.
--
-- Problem: _shared/snapshot.ts's saveSnapshot() previously did a plain
-- select-then-supersede-then-insert with no surrounding transaction and no
-- unique constraint underneath it. Two concurrent identical requests (the
-- same series computed twice at once — a realistic scenario: a user
-- double-clicking "Compute CAM", or a retry racing the original call) could
-- both pass the "no existing completed row" check before either had
-- inserted, and both would successfully insert a 'completed' row. This is
-- empirically reproduced and retained as a test — see
-- _tests/snapshot-publish-concurrency.test.ts, "REGRESSION: two identical
-- concurrent requests for the same series never produce more than one
-- completed row" — which failed against the pre-this-migration code (5
-- concurrent identical calls produced 5 duplicate completed rows) and
-- passes against this fix.
--
-- Fix: move publication into one PL/pgSQL function that runs as a single
-- transaction, serialized per snapshot series by a transaction-level
-- advisory lock (pg_advisory_xact_lock — NOT pg_advisory_lock; the
-- transaction-scoped form releases automatically at COMMIT/ROLLBACK, so a
-- crashed or errored publish can never leave the lock held). A partial
-- unique index backstops the same guarantee at the storage layer,
-- independent of application discipline.
--
-- This migration does NOT change any calculation logic (CAM math, budget
-- scope, reconciliation accounting, cap/gross-up/base-year rules). It only
-- changes how a computed result gets written to computation_snapshots.
--
-- Revised per architecture/security review to also carry `month` (1-12,
-- nullable) through the series identity — see the "1. Duplicate preflight"
-- comment below for the per-engine audit that grounds this, and
-- _shared/snapshot-identity.ts's docblock for the full reasoning. No
-- engine_type in this repo populates month as of this review; every
-- existing and current row keeps month = NULL and behaves identically to
-- before this revision.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Duplicate preflight — must run and pass BEFORE the unique index can be
--    created. Aborts the migration (RAISE EXCEPTION, whole migration is one
--    transaction, nothing partially applied) and reports the affected
--    snapshot IDs if more than one 'completed' row already exists for any
--    (org_id, property_id, engine_type, scope_level, scope_id, fiscal_year,
--    month) series. Never deletes, merges, or supersedes anything
--    automatically — a real duplicate found here is a data decision for
--    whoever owns the environment, not something this migration will
--    resolve for you.
--
--    `month` is included in the series key here (and in the unique index,
--    advisory-lock key, and RPC match/insert below) even though every
--    engine_type in this repo as of this review (cam, budget, expense,
--    revenue, reconciliation, lease) is annual-only and always writes
--    month = NULL — see _shared/snapshot-identity.ts's docblock for the
--    full per-engine audit and the reasoning for including it now rather
--    than bolting it on with a second migration later. Because every
--    existing row has month IS NULL, this addition changes nothing about
--    which rows compare equal today; it only takes effect once/if an
--    engine starts populating month.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup_count INT;
  dup_report TEXT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month
    FROM public.computation_snapshots
    WHERE status = 'completed'
    GROUP BY org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    SELECT string_agg(
      format(
        'org=%s property=%s engine=%s scope=%s:%s year=%s month=%s -> snapshot_ids=%s',
        org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month, ids
      ),
      E'\n'
    ) INTO dup_report
    FROM (
      SELECT org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month,
             array_agg(id ORDER BY computed_at) AS ids
      FROM public.computation_snapshots
      WHERE status = 'completed'
      GROUP BY org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month
      HAVING COUNT(*) > 1
    ) d;

    RAISE EXCEPTION
      E'Aborting migration: % duplicate completed-snapshot series found in computation_snapshots:\n%\n\nThis migration will not delete, merge, or supersede any row for you. Resolve these manually (decide which row per series should remain the single completed one; mark the rest superseded via an explicit, reviewed statement) before re-running this migration.',
      dup_count, dup_report;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Partial unique index: at most one 'completed' row per snapshot series.
--    Superseded/other-status rows are unaffected — append-only history is
--    fully preserved; this only constrains what may be simultaneously
--    'completed'. NULLS NOT DISTINCT (same convention as
--    cam_calculations_org_property_scope_year_key in
--    20260901000000_cam_scope_columns.sql) so org-level snapshots (NULL
--    property_id/scope_level/scope_id) and annual snapshots (NULL month)
--    are still deduplicated correctly rather than every NULL comparing as
--    distinct — this is exactly what makes two annual (month IS NULL)
--    snapshots for the same year correctly collide with each other while
--    two DIFFERENT months (e.g. January vs February, both NOT NULL and
--    unequal) do not.
-- ─────────────────────────────────────────────────────────────────────────
-- DROP + CREATE, not CREATE ... IF NOT EXISTS: this index already existed
-- (without `month`) before this review revised it. "IF NOT EXISTS" only
-- checks the index NAME, not its column list — it would silently skip
-- recreating an existing same-named index with the wrong definition rather
-- than adding month, exactly as happened when this fix was first applied
-- and caught during review. DROP + CREATE is safe here: dropping an index
-- never touches row data, and the table is briefly unprotected by this
-- specific constraint only for the instant between the two statements
-- inside this migration's single transaction (nothing else in the same
-- transaction writes to computation_snapshots in a way that could race it).
DROP INDEX IF EXISTS public.idx_computation_snapshots_one_completed_per_series;
CREATE UNIQUE INDEX idx_computation_snapshots_one_completed_per_series
  ON public.computation_snapshots (org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, month)
  NULLS NOT DISTINCT
  WHERE status = 'completed';

-- ─────────────────────────────────────────────────────────────────────────
-- 3. publish_computation_snapshot — the one transactional entry point for
--    writing a completed snapshot. Mirrors the SECURITY DEFINER /
--    SET search_path / REVOKE-then-GRANT pattern established by
--    20260603110000_send_expense_classification_to_cam_workflow.sql.
--
--    SECURITY POSTURE — explicit, as required by review:
--
--    - Ownership / SECURITY DEFINER vs INVOKER: this function is
--      SECURITY DEFINER, owned by the migration-applying role (postgres /
--      supabase_admin locally; the Supabase project owner in a real
--      deployment). It therefore always executes with THAT owner's
--      privileges, regardless of which role calls it. This is a
--      deliberate choice, not a copy-paste default: `service_role` in a
--      standard Supabase project already carries BYPASSRLS, so this
--      function would work under SECURITY INVOKER too *today* — but
--      SECURITY DEFINER makes correctness independent of whatever
--      table-level grants/RLS-bypass status `service_role` happens to
--      have at any given time, which is the more robust contract for a
--      function meant to be reachable from exactly one trusted internal
--      caller. Every table/function reference inside the body is
--      explicitly schema-qualified (`public.computation_snapshots`,
--      `public.publish_computation_snapshot`) and `SET search_path =
--      public, pg_temp` is fixed at CREATE time — both required for
--      SECURITY DEFINER functions to resist search_path-hijacking
--      (a session that creates its own same-named object earlier in an
--      attacker-controlled schema cannot get this function to resolve to
--      it, because the path is pinned, not inherited from the caller).
--
--    - Execution grants: REVOKE ALL ... FROM PUBLIC, anon, authenticated
--      (below) removes Postgres's default implicit PUBLIC grant on new
--      functions, then explicitly removes the two PostgREST-facing roles.
--      GRANT EXECUTE ... TO service_role is the only grant. This is
--      intentionally MORE restrictive than
--      send_expense_classification_to_cam_workflow (which is also granted
--      to `authenticated`): that RPC validates the row it's
--      operating on belongs to p_org_id, but does not verify the CALLING
--      user is actually a member of p_org_id or that p_actor_user_id is
--      the caller's own auth.uid() — i.e. it trusts its arguments. Taking
--      the same shape here (arbitrary p_org_id, no internal caller-
--      identity check) and ALSO granting it to `authenticated` would let
--      any signed-in user of ANY organization publish/supersede snapshots
--      for a DIFFERENT organization simply by passing that org's UUID —
--      there is no PostgREST-level protection against that once a role
--      can call the function at all. This function closes that off at
--      the grant level instead: `anon` and `authenticated` cannot invoke
--      it — PostgREST returns 42501/permission-denied before the
--      function body ever runs — so a browser client (whether logged out
--      or logged in as any user, any role) cannot reach it under any
--      p_org_id, its own or anyone else's. See
--      _tests/snapshot-publish-security.test.ts for a real-database test
--      of exactly this: an authenticated session's own JWT, used to call
--      this RPC directly, is rejected.
--
--    - Given only `service_role` can call this function, and
--      `service_role` already has unconditional table access (BYPASSRLS)
--      independent of this function's existence, an internal
--      "does p_org_id belong to the caller" check inside the function
--      body would not add a real security boundary — it would be
--      re-implementing an authorization decision that must, and already
--      does, happen earlier: every edge function that reaches
--      _shared/snapshot.ts's saveSnapshot() has already called
--      assertPageAccess / assertPropertyAccess / assertValidScopeHierarchy
--      for the specific org/property/scope it is about to publish. This
--      function's contribution is CONCURRENCY safety for a request that
--      has already been authorized, not authorization itself.
--
--    - Update scope: the function's only UPDATE statement
--      (`SET status = 'superseded' ... WHERE cs.id = v_current.id`) can
--      only ever target the single row that was already found by the
--      fully-identity-filtered SELECT ... FOR UPDATE immediately above it
--      (org_id, property_id, engine_type, scope_level, scope_id,
--      fiscal_year, month, status='completed', all matched with IS NOT
--      DISTINCT FROM). There is no other UPDATE, no dynamic SQL, and no
--      path by which this function can modify a row outside that exact
--      identity — it cannot supersede a different series, a different
--      scope, or a different organization's row than the one the caller's
--      own parameters describe.
-- ─────────────────────────────────────────────────────────────────────────
-- Drop the pre-month-support 13-parameter overload explicitly. Postgres
-- identifies a function by name AND full parameter-type list, so
-- CREATE OR REPLACE with a changed signature (adding p_month, even as a
-- trailing DEFAULT) does NOT replace the old function — it silently
-- creates a SECOND overload alongside it. Caught during review: without
-- this DROP, both a 13-param (no month-matching, no month-in-lock-key) and
-- a 14-param version of publish_computation_snapshot would coexist, and
-- any caller that omitted p_month would resolve to the stale overload
-- instead of erroring. There is exactly one legitimate signature for this
-- function; this DROP is what makes CREATE OR REPLACE below actually mean
-- "replace."
DROP FUNCTION IF EXISTS public.publish_computation_snapshot(
  UUID, UUID, TEXT, TEXT, UUID, INT, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID
);

CREATE OR REPLACE FUNCTION public.publish_computation_snapshot(
  p_org_id UUID,
  p_property_id UUID,
  p_engine_type TEXT,
  p_scope_level TEXT,
  p_scope_id UUID,
  p_fiscal_year INT,
  p_engine_version TEXT,
  p_input_hash TEXT,
  p_inputs JSONB,
  p_outputs JSONB,
  p_computed_by TEXT,
  p_locked_at TIMESTAMPTZ DEFAULT NULL,
  p_locked_by UUID DEFAULT NULL,
  -- 1-12, or NULL for an annual series. Trailing (all Postgres parameters
  -- after the first DEFAULT must have one too) — added after p_locked_by
  -- rather than logically next to p_fiscal_year for exactly that reason.
  -- Every current caller (_shared/snapshot.ts) always passes this
  -- explicitly by name, so the default only matters for other callers
  -- (manual psql, future code) that omit it.
  p_month INT DEFAULT NULL
)
RETURNS TABLE (
  id UUID,
  org_id UUID,
  property_id UUID,
  engine_type TEXT,
  fiscal_year INT,
  month INT,
  input_hash TEXT,
  inputs JSONB,
  outputs JSONB,
  status TEXT,
  computed_at TIMESTAMPTZ,
  computed_by TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  engine_version TEXT,
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  scope_level TEXT,
  scope_id UUID,
  publish_action TEXT,
  superseded_snapshot_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_lock_key BIGINT;
  v_series_key TEXT;
  v_current public.computation_snapshots%ROWTYPE;
  v_new public.computation_snapshots%ROWTYPE;
  v_superseded_id UUID := NULL;
  v_now TIMESTAMPTZ := now();
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'publish_computation_snapshot: org_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_engine_type, '')), '') IS NULL THEN
    RAISE EXCEPTION 'publish_computation_snapshot: engine_type is required';
  END IF;
  IF p_fiscal_year IS NULL THEN
    RAISE EXCEPTION 'publish_computation_snapshot: fiscal_year is required';
  END IF;
  IF p_month IS NOT NULL AND (p_month < 1 OR p_month > 12) THEN
    RAISE EXCEPTION 'publish_computation_snapshot: month must be 1-12 or NULL, got %', p_month;
  END IF;

  -- Canonical series key string — must stay field-for-field consistent with
  -- _shared/snapshot-identity.ts's SnapshotSeriesIdentity
  -- (SNAPSHOT_SERIES_IDENTITY_COLUMNS: org_id, property_id, engine_type,
  -- scope_level, scope_id, fiscal_year, month). This string only feeds the
  -- advisory lock hash; the actual row match below uses proper typed
  -- equality, not this string. A distinct month value must change this
  -- key (so January and February publishers take independent locks and
  -- never block each other); a NULL month must produce the exact same key
  -- as before month existed (so annual engines are unaffected).
  v_series_key := coalesce(p_org_id::text, '') || '|' ||
                  coalesce(p_property_id::text, '') || '|' ||
                  p_engine_type || '|' ||
                  coalesce(p_scope_level, '') || '|' ||
                  coalesce(p_scope_id::text, '') || '|' ||
                  p_fiscal_year::text || '|' ||
                  coalesce(p_month::text, '');
  v_lock_key := hashtextextended(v_series_key, 0);

  -- Transaction-level advisory lock: serializes every publisher for this
  -- exact series against every other. Automatically released at this
  -- transaction's COMMIT or ROLLBACK — never needs (and must never use) an
  -- explicit unlock call, which is exactly why this must be
  -- pg_advisory_xact_lock and not the session-scoped pg_advisory_lock (a
  -- session-scoped lock left held by a crashed connection would wedge
  -- every future publish for this series).
  PERFORM pg_advisory_xact_lock(v_lock_key);

  -- Read + row-lock the current completed row for this series, if any.
  -- Belt-and-suspenders alongside the advisory lock: makes the intent
  -- explicit and still correct even if this function were ever called
  -- concurrently without going through the advisory lock for some reason.
  --
  -- Table alias (cs) and fully-qualified column references are required
  -- here, not stylistic: this function's RETURNS TABLE(...) declares
  -- output columns with the same names as computation_snapshots' own
  -- columns (id, org_id, status, etc.), and PL/pgSQL resolves an
  -- unqualified "org_id" inside the function body against THOSE OUT
  -- parameters first, making every bare column reference ambiguous
  -- ("column reference org_id is ambiguous").
  SELECT cs.*
    INTO v_current
    FROM public.computation_snapshots cs
   WHERE cs.org_id = p_org_id
     AND cs.property_id IS NOT DISTINCT FROM p_property_id
     AND cs.engine_type = p_engine_type
     AND cs.scope_level IS NOT DISTINCT FROM p_scope_level
     AND cs.scope_id IS NOT DISTINCT FROM p_scope_id
     AND cs.fiscal_year = p_fiscal_year
     AND cs.month IS NOT DISTINCT FROM p_month
     AND cs.status = 'completed'
   FOR UPDATE OF cs;

  IF FOUND
     AND v_current.input_hash IS NOT NULL
     AND v_current.input_hash = p_input_hash
     AND v_current.engine_version IS NOT DISTINCT FROM p_engine_version
  THEN
    RAISE LOG 'publish_computation_snapshot: reused snapshot % (series org=% property=% engine=% scope=%:% year=% month=%)',
      v_current.id, p_org_id, p_property_id, p_engine_type, p_scope_level, p_scope_id, p_fiscal_year, p_month;
    RETURN QUERY SELECT
      v_current.id, v_current.org_id, v_current.property_id, v_current.engine_type, v_current.fiscal_year,
      v_current.month, v_current.input_hash, v_current.inputs, v_current.outputs, v_current.status,
      v_current.computed_at, v_current.computed_by, v_current.created_at, v_current.updated_at,
      v_current.engine_version, v_current.locked_at, v_current.locked_by, v_current.scope_level, v_current.scope_id,
      'reused'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF FOUND THEN
    UPDATE public.computation_snapshots AS cs
       SET status = 'superseded', updated_at = v_now
     WHERE cs.id = v_current.id;
    v_superseded_id := v_current.id;
  END IF;

  BEGIN
    -- p_inputs/p_outputs are intentionally NOT coalesced to '{}' here: the
    -- column is NOT NULL, so a genuinely-null value fails loudly (as it
    -- should — a caller passing null indicates an upstream bug, not a
    -- legitimate "no data" case; _shared/snapshot.ts's saveSnapshot always
    -- sends a real object via enrichInputs/normalizeForSnapshot before
    -- calling this RPC). This is also what makes it possible to force and
    -- test the "failure after supersede, before insert" rollback guarantee
    -- deterministically — see _tests/snapshot-publish-concurrency.test.ts.
    INSERT INTO public.computation_snapshots (
      org_id, property_id, engine_type, fiscal_year, month, scope_level, scope_id,
      inputs, outputs, status, computed_at, computed_by, engine_version,
      input_hash, locked_at, locked_by
    ) VALUES (
      p_org_id, p_property_id, p_engine_type, p_fiscal_year, p_month, p_scope_level, p_scope_id,
      p_inputs, p_outputs, 'completed', v_now, p_computed_by, p_engine_version,
      p_input_hash, p_locked_at, p_locked_by
    )
    RETURNING * INTO v_new;
  EXCEPTION WHEN unique_violation THEN
    -- Should not be reachable given the advisory lock above — logged
    -- distinctly as a conflict signal in case it ever is (e.g. this
    -- function called in a way that bypasses the lock), then re-raised so
    -- the whole transaction still aborts and the supersede above is rolled
    -- back with it. Never swallow this.
    RAISE WARNING 'publish_computation_snapshot: unique_violation conflict for series org=% property=% engine=% scope=%:% year=% month=% (lock_key=%)',
      p_org_id, p_property_id, p_engine_type, p_scope_level, p_scope_id, p_fiscal_year, p_month, v_lock_key;
    RAISE;
  END;

  RAISE LOG 'publish_computation_snapshot: created snapshot % (superseded %) for series org=% property=% engine=% scope=%:% year=% month=%',
    v_new.id, COALESCE(v_superseded_id::text, 'none'), p_org_id, p_property_id, p_engine_type, p_scope_level, p_scope_id, p_fiscal_year, p_month;

  RETURN QUERY SELECT
    v_new.id, v_new.org_id, v_new.property_id, v_new.engine_type, v_new.fiscal_year,
    v_new.month, v_new.input_hash, v_new.inputs, v_new.outputs, v_new.status,
    v_new.computed_at, v_new.computed_by, v_new.created_at, v_new.updated_at,
    v_new.engine_version, v_new.locked_at, v_new.locked_by, v_new.scope_level, v_new.scope_id,
    'created'::TEXT, v_superseded_id;
END;
$$;

-- Signature must list every parameter type in declared order, including
-- the new trailing p_month, to unambiguously identify this overload — an
-- incomplete/stale signature here would silently REVOKE/GRANT nothing
-- (Postgres errors on a signature that doesn't resolve to an existing
-- function, so a mismatch is at least loud, not silent, but keep this
-- list in sync with the CREATE FUNCTION parameter list above regardless).
REVOKE ALL ON FUNCTION public.publish_computation_snapshot(
  UUID, UUID, TEXT, TEXT, UUID, INT, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID, INT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.publish_computation_snapshot(
  UUID, UUID, TEXT, TEXT, UUID, INT, TEXT, TEXT, JSONB, JSONB, TEXT, TIMESTAMPTZ, UUID, INT
) TO service_role;

-- ============================================================
-- ROLLBACK LIMITATIONS
--
-- Dropping the unique index (DROP INDEX idx_computation_snapshots_one_
-- completed_per_series) and the function (DROP FUNCTION
-- public.publish_computation_snapshot(...)) is always safe by itself —
-- neither one deletes or alters any row, so reverting them never loses
-- data. saveSnapshot() falling back to select-then-insert (i.e. reverting
-- the _shared/snapshot.ts change alongside this migration) restores
-- exactly the pre-this-PR behavior, race condition included — that is a
-- real regression to accept knowingly if this is ever rolled back, not a
-- side effect to overlook.
--
-- What is NOT safely reversible: if you roll back only the code
-- (_shared/snapshot.ts back to select-then-insert) while KEEPING this
-- migration's unique index in place, every publish attempt that would have
-- raced now fails outright with a unique_violation instead of silently
-- duplicating — arguably safer than the original bug, but a behavior
-- change nonetheless, and not what "rollback" usually implies. Roll back
-- code and schema together, or not at all.
-- ============================================================

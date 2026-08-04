-- ============================================================
-- CAM scope-awareness: add scope_level/scope_id to
-- computation_snapshots and cam_calculations.
--
-- Additive only. No column is dropped or renamed, no row is deleted or
-- merged, and no data type is narrowed. This migration:
--   1. Adds nullable scope_level/scope_id columns to both tables.
--   2. Backfills every existing row with a property_id to
--      scope_level='property', scope_id=property_id (the only scope that
--      existed before this migration — building/unit-scoped runs were not
--      previously representable at the database level).
--   3. Adds CHECK constraints: scope_level restricted to the three known
--      values (mirrors the app-level ScopeLevel type in _shared/scope.ts);
--      scope_level/scope_id must both be null or both be present; property
--      scope requires scope_id = property_id; CAM snapshots specifically
--      must always carry property_id + scope_level + scope_id. Also
--      conditionally tightens cam_calculations.scope_level/scope_id to
--      NOT NULL — only if the real data supports it (see step 3c).
--   4. Runs an explicit duplicate preflight on cam_calculations under the
--      new (org_id, property_id, scope_level, scope_id, fiscal_year) key
--      BEFORE touching its unique constraint, and ABORTS the migration
--      (RAISE EXCEPTION, no partial effect — the whole migration runs in
--      one transaction) if any duplicate group is found, rather than
--      silently deleting or merging rows. See the reasoning below for why
--      this is expected to always find zero duplicates, and why the check
--      is still run rather than assumed.
--   5. Only if the preflight passes, replaces cam_calculations' existing
--      3-column unique constraint with a 5-column one that includes scope,
--      so compute-cam's upsert can target the new key.
--   6. computation_snapshots does NOT get a new/changed unique constraint:
--      it has had none since 202604070146114_snapshot_history.sql
--      deliberately moved it to an append-only supersede+insert history
--      model (every run inserts a fresh row; the previous "current" row
--      for the same logical scope is marked status='superseded' by
--      _shared/snapshot.ts, not overwritten). No preflight is therefore
--      needed for that table.
--
-- Duplicate preflight reasoning (see also the standalone report script
-- scripts/cam-scope-duplicate-preflight.sql for a human-readable version
-- to run against staging/production before applying this migration):
--   cam_calculations already has UNIQUE NULLS NOT DISTINCT
--   (org_id, property_id, fiscal_year) (202604090146113_fix_cam_unique_constraints.sql).
--   Step 2 backfills scope_level='property', scope_id=property_id on every
--   existing row — i.e. scope_id is set to a value that is, by
--   construction, always equal to property_id for every pre-existing row.
--   Therefore the new 5-column key (..., scope_level, scope_id, ...)
--   reduces to exactly the old 3-column key for all pre-existing data, and
--   the existing constraint already guarantees that key is unique. No new
--   duplicates can mathematically arise from the backfill alone. The
--   preflight (step 4) verifies this holds against the actual data rather
--   than trusting the argument, and fails the migration loudly if it does
--   not.
-- ============================================================

-- ─────────────────────────────────────────────────────────────────────────
-- 1. Add nullable scope columns
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.computation_snapshots
  ADD COLUMN IF NOT EXISTS scope_level TEXT,
  ADD COLUMN IF NOT EXISTS scope_id UUID;

ALTER TABLE public.cam_calculations
  ADD COLUMN IF NOT EXISTS scope_level TEXT,
  ADD COLUMN IF NOT EXISTS scope_id UUID;

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Backfill: every existing row with a property_id becomes a
--    property-scoped row (the only scope that existed before this
--    migration). Rows with a NULL property_id (org-level snapshots — see
--    computation_snapshots' original design, e.g. idx_snapshots_unique_org)
--    have no property to derive a default scope from and are intentionally
--    left with NULL scope_level/scope_id.
-- ─────────────────────────────────────────────────────────────────────────
UPDATE public.computation_snapshots
  SET scope_level = 'property', scope_id = property_id
  WHERE scope_level IS NULL AND property_id IS NOT NULL;

UPDATE public.cam_calculations
  SET scope_level = 'property', scope_id = property_id
  WHERE scope_level IS NULL AND property_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- 3. Defense-in-depth CHECK constraints (mirror _shared/scope.ts's
--    ScopeLevel union). NULL remains allowed for org-level snapshot rows.
-- ─────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.computation_snapshots'::regclass
      AND conname = 'computation_snapshots_scope_level_check'
  ) THEN
    ALTER TABLE public.computation_snapshots
      ADD CONSTRAINT computation_snapshots_scope_level_check
      CHECK (scope_level IS NULL OR scope_level IN ('property', 'building', 'unit'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cam_calculations'::regclass
      AND conname = 'cam_calculations_scope_level_check'
  ) THEN
    ALTER TABLE public.cam_calculations
      ADD CONSTRAINT cam_calculations_scope_level_check
      CHECK (scope_level IS NULL OR scope_level IN ('property', 'building', 'unit'));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3b. Additional data-consistency CHECK constraints, mirroring the
--     application-level rules in _shared/snapshot.ts's resolveSnapshotScope
--     and _shared/scope.ts's assertValidScopeHierarchy so an insert that
--     bypasses the app layer (a script, a future engine, a bug) still
--     cannot create an incoherent scope at the database level:
--       - scope_level and scope_id must either both be null or both be
--         present — never one without the other.
--       - property scope requires scope_id = property_id exactly.
--       - CAM snapshots specifically must always carry property_id,
--         scope_level, AND scope_id (CAM is never org-level in this
--         schema — compute-cam requires property_id unconditionally).
-- ─────────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.computation_snapshots'::regclass
      AND conname = 'computation_snapshots_scope_pair_check'
  ) THEN
    ALTER TABLE public.computation_snapshots
      ADD CONSTRAINT computation_snapshots_scope_pair_check
      CHECK ((scope_level IS NULL) = (scope_id IS NULL));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cam_calculations'::regclass
      AND conname = 'cam_calculations_scope_pair_check'
  ) THEN
    ALTER TABLE public.cam_calculations
      ADD CONSTRAINT cam_calculations_scope_pair_check
      CHECK ((scope_level IS NULL) = (scope_id IS NULL));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.computation_snapshots'::regclass
      AND conname = 'computation_snapshots_property_scope_check'
  ) THEN
    ALTER TABLE public.computation_snapshots
      ADD CONSTRAINT computation_snapshots_property_scope_check
      CHECK (scope_level IS DISTINCT FROM 'property' OR scope_id = property_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cam_calculations'::regclass
      AND conname = 'cam_calculations_property_scope_check'
  ) THEN
    ALTER TABLE public.cam_calculations
      ADD CONSTRAINT cam_calculations_property_scope_check
      CHECK (scope_level IS DISTINCT FROM 'property' OR scope_id = property_id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.computation_snapshots'::regclass
      AND conname = 'computation_snapshots_cam_requires_scope_check'
  ) THEN
    ALTER TABLE public.computation_snapshots
      ADD CONSTRAINT computation_snapshots_cam_requires_scope_check
      CHECK (
        engine_type <> 'cam'
        OR (property_id IS NOT NULL AND scope_level IS NOT NULL AND scope_id IS NOT NULL)
      );
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 3c. cam_calculations.scope_level/scope_id -> NOT NULL, but only if the
--     backfilled data actually supports it. compute-cam always requires
--     property_id before writing to this table, so in principle every row
--     should now have a non-null scope_level/scope_id — but that is only
--     true if every existing row already had property_id set. Rather than
--     assume that, check the real data and only tighten the columns if it
--     holds; otherwise leave them nullable and say why, so a genuine
--     existing use case (a NULL-property_id row, if any exist) is never
--     silently blocked by a migration instead of being surfaced.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  null_scope_count INT;
BEGIN
  SELECT COUNT(*) INTO null_scope_count
  FROM public.cam_calculations
  WHERE scope_level IS NULL OR scope_id IS NULL;

  IF null_scope_count = 0 THEN
    ALTER TABLE public.cam_calculations
      ALTER COLUMN scope_level SET NOT NULL,
      ALTER COLUMN scope_id SET NOT NULL;
  ELSE
    RAISE NOTICE
      'Skipping NOT NULL on cam_calculations.scope_level/scope_id: % row(s) have property_id IS NULL (and therefore no scope after backfill). These represent a concrete existing use case (non-property-attributed CAM rows) rather than an oversight, so the columns are left nullable. Investigate these rows before deciding whether to tighten this in a future migration.',
      null_scope_count;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 4. Duplicate preflight on cam_calculations under the NEW key. Aborts the
--    whole migration (transactional — nothing above is left partially
--    applied) rather than deleting or merging any row. If this ever fires,
--    it means live data has already diverged from what every migration
--    file in this repo implies (see the "Remote schema drift" precedent in
--    this project) — investigate and resolve manually; do not remove this
--    guard to force the migration through.
-- ─────────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  dup_count INT;
  dup_report TEXT;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT org_id, property_id, scope_level, scope_id, fiscal_year
    FROM public.cam_calculations
    GROUP BY org_id, property_id, scope_level, scope_id, fiscal_year
    HAVING COUNT(*) > 1
  ) dups;

  IF dup_count > 0 THEN
    SELECT string_agg(
      format(
        'org=%s property=%s scope_level=%s scope_id=%s fiscal_year=%s (%s rows)',
        org_id, property_id, scope_level, scope_id, fiscal_year, cnt
      ),
      E'\n'
    ) INTO dup_report
    FROM (
      SELECT org_id, property_id, scope_level, scope_id, fiscal_year, COUNT(*) AS cnt
      FROM public.cam_calculations
      GROUP BY org_id, property_id, scope_level, scope_id, fiscal_year
      HAVING COUNT(*) > 1
    ) d;

    RAISE EXCEPTION
      E'Aborting migration: % duplicate (org_id, property_id, scope_level, scope_id, fiscal_year) group(s) found in cam_calculations after backfill:\n%\n\nThis should be mathematically impossible given the pre-existing UNIQUE(org_id, property_id, fiscal_year) constraint. If this fires, live data has diverged from the migration history this repo tracks — investigate and resolve manually (this migration will not delete or merge any row for you). Re-run this migration once resolved.',
      dup_count, dup_report;
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 5. Swap cam_calculations' unique constraint to include scope. Only
--    reached if the preflight above passed.
-- ─────────────────────────────────────────────────────────────────────────
ALTER TABLE public.cam_calculations
  DROP CONSTRAINT IF EXISTS cam_calculations_org_property_year_key;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.cam_calculations'::regclass
      AND conname = 'cam_calculations_org_property_scope_year_key'
  ) THEN
    ALTER TABLE public.cam_calculations
      ADD CONSTRAINT cam_calculations_org_property_scope_year_key
      UNIQUE NULLS NOT DISTINCT (org_id, property_id, scope_level, scope_id, fiscal_year);
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────────────────
-- 6. Indexes to support scope-filtered lookups (lock checks, historical
--    lookups, prior-year lookups, idempotency lookups).
-- ─────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_snapshots_scope
  ON public.computation_snapshots (org_id, property_id, engine_type, scope_level, scope_id, fiscal_year);

CREATE INDEX IF NOT EXISTS idx_cam_calculations_scope
  ON public.cam_calculations (org_id, property_id, scope_level, scope_id, fiscal_year);

-- ─────────────────────────────────────────────────────────────────────────
-- 7. Rebuild latest_snapshots to be scope-aware. This view is not currently
--    queried by any application code (confirmed via a repo-wide search),
--    but leaving its DISTINCT ON key silently missing scope after this
--    migration would make it actively misleading for whoever reaches for
--    it next — a "latest snapshot per (org, property, engine, year)" view
--    would conflate a building-scope run with a property-scope run for the
--    same year.
--
--    Uses DROP + CREATE (not CREATE OR REPLACE) with an explicit
--    WITH (security_invoker = true), matching
--    20260723000002_fix_security_definer_views.sql's fix — that migration
--    exists precisely because CREATE OR REPLACE VIEW silently drops the
--    security_invoker reloption, which had regressed this same view once
--    already (20260624000002_snapshot_versioning.sql omitted it). Do not
--    switch this back to CREATE OR REPLACE.
-- ─────────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.latest_snapshots;
CREATE VIEW public.latest_snapshots
WITH (security_invoker = true) AS
SELECT DISTINCT ON (org_id, property_id, engine_type, scope_level, scope_id, fiscal_year)
  id, org_id, property_id, engine_type, fiscal_year, month,
  inputs, outputs, status, computed_at, computed_by, created_at, updated_at,
  engine_version, input_hash, locked_at, locked_by, scope_level, scope_id
FROM public.computation_snapshots
WHERE status = 'completed'
ORDER BY org_id, property_id, engine_type, scope_level, scope_id, fiscal_year, computed_at DESC;

GRANT SELECT ON public.latest_snapshots TO authenticated;

-- ============================================================
-- ROLLBACK — read this before attempting to revert this migration.
--
-- This migration is cleanly reversible ONLY until real non-property-scoped
-- data exists. It is NOT a mechanical, always-safe rollback after that
-- point — see why below.
--
-- STEP 0 — always run this check first:
--
--   SELECT COUNT(*) AS non_property_scope_rows
--   FROM public.cam_calculations
--   WHERE scope_level IS DISTINCT FROM 'property';
--
-- CASE A — result is 0 (no building/unit-scoped CAM calculation has ever
-- been computed and stored): mechanical rollback is safe. Every
-- cam_calculations row still has scope_id = property_id, so the old
-- 3-column key and the new 5-column key are identical sets, and the old
-- constraint can be restored without conflict:
--
--   DROP INDEX IF EXISTS idx_snapshots_scope;
--   DROP INDEX IF EXISTS idx_cam_calculations_scope;
--   ALTER TABLE public.cam_calculations
--     DROP CONSTRAINT IF EXISTS cam_calculations_org_property_scope_year_key;
--   ALTER TABLE public.cam_calculations
--     ADD CONSTRAINT cam_calculations_org_property_year_key
--     UNIQUE NULLS NOT DISTINCT (org_id, property_id, fiscal_year);
--   ALTER TABLE public.cam_calculations
--     DROP CONSTRAINT IF EXISTS cam_calculations_scope_level_check,
--     DROP CONSTRAINT IF EXISTS cam_calculations_scope_pair_check,
--     DROP CONSTRAINT IF EXISTS cam_calculations_property_scope_check,
--     ALTER COLUMN scope_level DROP NOT NULL,
--     ALTER COLUMN scope_id DROP NOT NULL;
--   ALTER TABLE public.computation_snapshots
--     DROP CONSTRAINT IF EXISTS computation_snapshots_scope_level_check,
--     DROP CONSTRAINT IF EXISTS computation_snapshots_scope_pair_check,
--     DROP CONSTRAINT IF EXISTS computation_snapshots_property_scope_check,
--     DROP CONSTRAINT IF EXISTS computation_snapshots_cam_requires_scope_check;
--   -- Restore latest_snapshots to its pre-migration DISTINCT ON list (see
--   -- 20260624000002_snapshot_versioning.sql) if desired; optionally also
--   -- DROP COLUMN scope_level/scope_id on both tables at this point.
--   -- Also revert the application code (this PR's edge-function changes)
--   -- in the same deploy — leaving the columns/constraints dropped while
--   -- compute-cam still writes scope_level/scope_id would break inserts.
--
-- CASE B — result is greater than 0 (at least one building/unit-scoped CAM
-- calculation has been computed): DO NOT run the mechanical rollback
-- above. Re-adding UNIQUE NULLS NOT DISTINCT (org_id, property_id,
-- fiscal_year) will fail outright (duplicate key violation) as soon as a
-- property now legitimately has more than one cam_calculations row for the
-- same fiscal_year — one property-level plus one or more building/unit
-- rows. Forcing it through requires deciding what happens to the
-- non-property rows (delete them, merge them into the property row,
-- archive them elsewhere) — that is a data/business decision, not a
-- schema operation, and this repo's standing instruction is no destructive
-- migration or bulk data change without explicit, separate approval.
--
-- In CASE B, treat any problem as needing a FORWARD corrective migration,
-- not a rollback:
--   - If the scoping feature itself has a bug, fix the bug in a new PR and
--     re-run the affected computations (compute-cam is idempotent per
--     scope — see cam-scope-awareness.test.ts) rather than reverting the
--     schema underneath already-computed, possibly externally-referenced
--     data.
--   - If a genuine rollback is still required, that is its own reviewed
--     migration: first get explicit sign-off on what happens to existing
--     non-property-scoped rows, encode that decision explicitly (e.g. an
--     archive table + a documented cutover), and only then drop the
--     scope columns/constraints.
-- ============================================================

-- Budget hierarchy scope + period correctness (see supabase/functions/_shared/budget-scope.ts).
--
-- Problem: compute-budget/index.ts previously hardcoded scope:"property" and
-- period:"annual" on every budget it wrote, even though `budgets` already
-- had portfolio_id/building_id/unit_id/scope/period columns (added by two
-- earlier migrations) that CreateBudget.jsx's UI populated but the edge
-- function ignored. The unique constraint (org_id, property_id, budget_year)
-- also could not distinguish a portfolio-scoped budget (property_id NULL)
-- from any other portfolio-scoped budget in the same org/year, and
-- computation_snapshots.scope_level had no "portfolio" value at all.
--
-- This migration's forward application is additive/safe: one new
-- nullable-then-backfilled column, new CHECK constraints, a swapped unique
-- constraint, and a corrected RLS SELECT policy. No existing column's
-- meaning changes and no row's data is altered beyond populating the new
-- scope_id column.
--
-- ── ROLLBACK IS NOT PURELY ADDITIVE — CORRECTED 2026-08-03 ─────────────────
-- An earlier version of this comment claimed rollback was safe because it
-- was "structurally equivalent" to the old constraint. That is true ONLY at
-- the moment this migration is applied (when every row is still
-- scope='property'). It stops being true the moment ANY building/unit/
-- portfolio-scoped budget is created:
--   - This migration DROPS budgets_org_property_year_key (the old
--     UNIQUE(org_id, property_id, budget_year) constraint) and replaces it
--     with UNIQUE(org_id, scope, scope_id, budget_year). That is a real
--     drop, not merely an addition.
--   - A building-scoped budget row stores its PARENT property's id in
--     property_id (by design — see _shared/budget-scope.ts) alongside its
--     own building_id. So a property-scope budget and a building-scope
--     budget for the same property+year share an IDENTICAL
--     (org_id, property_id, budget_year) tuple. Once both exist,
--     re-applying the old constraint is not just "different" — it is
--     IMPOSSIBLE without first removing enough rows to make property_id
--     unique per (org_id, budget_year) again.
--   - Therefore: restoring the pre-migration schema after scoped
--     (non-property) budgets exist in production requires either (a) a
--     forward corrective migration that re-derives a compatible model
--     (e.g., relocating building/unit budgets to a separate table, or
--     redesigning the legacy constraint's shape) rather than a literal
--     down-migration, or (b) an explicit, human-reviewed data-disposition
--     decision about which rows to keep under the old shape. This
--     migration file — and no automated process — must NEVER delete or
--     merge non-property budget rows to force the old constraint to fit;
--     see supabase/functions/_shared/budget-identity.ts's module docblock
--     for the same fail-closed posture applied at the query layer.
--   - Practical implication: before this migration is applied to any
--     environment where rollback might realistically be needed, confirm
--     that reverting is acceptable to do BEFORE scoped budgets accumulate,
--     or accept that rollback becomes a forward-migration exercise, not a
--     `DROP`/`re-CREATE CONSTRAINT` pair.
--
-- Real-database preflight (see this PR's report, deliverable F) confirmed
-- before writing this migration: 202 pre-existing budgets rows, all
-- scope='property'/period='annual', zero collisions under the new
-- (org_id, scope, scope_id, budget_year) key.

-- ===========================================================================
-- 1. computation_snapshots: widen scope_level to allow 'portfolio'
--    (cam/lease untouched — computation_snapshots_cam_requires_scope_check
--    and _shared/scope.ts's SCOPE_LEVELS deliberately still only recognize
--    property/building/unit; "portfolio" is budget-only).
-- ===========================================================================
ALTER TABLE public.computation_snapshots DROP CONSTRAINT IF EXISTS computation_snapshots_scope_level_check;
ALTER TABLE public.computation_snapshots
  ADD CONSTRAINT computation_snapshots_scope_level_check
  CHECK (scope_level IS NULL OR scope_level = ANY (ARRAY['portfolio', 'property', 'building', 'unit']));

-- A portfolio-scoped snapshot has no single parent property — mirrors
-- _shared/snapshot.ts's resolveSnapshotScope, which throws if scope_level
-- "portfolio" is paired with a non-null property_id.
ALTER TABLE public.computation_snapshots DROP CONSTRAINT IF EXISTS computation_snapshots_portfolio_scope_check;
ALTER TABLE public.computation_snapshots
  ADD CONSTRAINT computation_snapshots_portfolio_scope_check
  CHECK (scope_level IS DISTINCT FROM 'portfolio' OR property_id IS NULL);

-- ===========================================================================
-- 2. budgets: add scope_id, the canonical "which node of the hierarchy"
--    column that unifies portfolio_id/property_id/building_id/unit_id into
--    one value matching whichever one `scope` names.
-- ===========================================================================
ALTER TABLE public.budgets ADD COLUMN IF NOT EXISTS scope_id UUID;

-- ---------------------------------------------------------------------------
-- 2a. Preflight: refuse to backfill scope_id ambiguously. Every existing
--     row must have a non-null value in the column its own `scope` names,
--     or deterministic backfill is impossible.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT count(*) INTO bad_count FROM public.budgets
  WHERE scope_id IS NULL
    AND (
      (scope = 'property' AND property_id IS NULL) OR
      (scope = 'building' AND building_id IS NULL) OR
      (scope = 'unit' AND unit_id IS NULL) OR
      (scope = 'portfolio' AND portfolio_id IS NULL) OR
      (scope NOT IN ('property', 'building', 'unit', 'portfolio'))
    );
  IF bad_count > 0 THEN
    RAISE EXCEPTION
      'Preflight failed: % budgets row(s) have a scope value with no matching hierarchy id to backfill scope_id from (or an unrecognized scope value). Investigate manually before re-running this migration.',
      bad_count;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2b. Deterministic backfill: scope_id = the id column matching each row's
--     own `scope`. All 202 pre-existing rows are scope='property' as of
--     this migration's authoring, so only the first UPDATE has any effect
--     today — all four are written for correctness, not just the observed
--     case.
-- ---------------------------------------------------------------------------
UPDATE public.budgets SET scope_id = property_id WHERE scope_id IS NULL AND scope = 'property';
UPDATE public.budgets SET scope_id = building_id WHERE scope_id IS NULL AND scope = 'building';
UPDATE public.budgets SET scope_id = unit_id WHERE scope_id IS NULL AND scope = 'unit';
UPDATE public.budgets SET scope_id = portfolio_id WHERE scope_id IS NULL AND scope = 'portfolio';

-- ---------------------------------------------------------------------------
-- 2c. Preflight: report (never auto-delete/merge) any duplicate group under
--     the new (org_id, scope, scope_id, budget_year) key before the unique
--     constraint swap below would fail on them.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dup RECORD;
  dup_groups INT := 0;
BEGIN
  FOR dup IN
    SELECT org_id, scope, scope_id, budget_year, array_agg(id ORDER BY id) AS ids, count(*) AS cnt
    FROM public.budgets
    GROUP BY org_id, scope, scope_id, budget_year
    HAVING count(*) > 1
  LOOP
    dup_groups := dup_groups + 1;
    RAISE WARNING 'Duplicate budgets rows under new key (org_id=%, scope=%, scope_id=%, budget_year=%): ids=%',
      dup.org_id, dup.scope, dup.scope_id, dup.budget_year, dup.ids;
  END LOOP;
  IF dup_groups > 0 THEN
    RAISE EXCEPTION
      'Preflight failed: % duplicate group(s) found under the new (org_id, scope, scope_id, budget_year) key — see WARNING lines above for the affected row ids. Resolve manually (this migration will not auto-delete or auto-merge) before re-running.',
      dup_groups;
  END IF;
END $$;

-- ===========================================================================
-- 3. CHECK constraints mirroring _shared/budget-scope.ts's per-level
--    required/forbidden id rules, enforced at the database layer as
--    defense-in-depth (the edge function already validates this
--    server-side via assertValidBudgetScopeHierarchy).
-- ===========================================================================
ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_scope_check;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_scope_check
  CHECK (scope = ANY (ARRAY['portfolio', 'property', 'building', 'unit']));

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_scope_id_required_check;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_scope_id_required_check
  CHECK (scope_id IS NOT NULL);

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_portfolio_scope_shape_check;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_portfolio_scope_shape_check
  CHECK (
    scope IS DISTINCT FROM 'portfolio'
    OR (portfolio_id IS NOT NULL AND property_id IS NULL AND building_id IS NULL AND unit_id IS NULL AND scope_id = portfolio_id)
  );

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_property_scope_shape_check;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_property_scope_shape_check
  CHECK (
    scope IS DISTINCT FROM 'property'
    OR (property_id IS NOT NULL AND building_id IS NULL AND unit_id IS NULL AND scope_id = property_id)
  );

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_building_scope_shape_check;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_building_scope_shape_check
  CHECK (
    scope IS DISTINCT FROM 'building'
    OR (property_id IS NOT NULL AND building_id IS NOT NULL AND unit_id IS NULL AND scope_id = building_id)
  );

ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_unit_scope_shape_check;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_unit_scope_shape_check
  CHECK (
    scope IS DISTINCT FROM 'unit'
    OR (property_id IS NOT NULL AND unit_id IS NOT NULL AND scope_id = unit_id)
  );

-- ===========================================================================
-- 4. Unique constraint swap: (org_id, property_id, budget_year) could never
--    distinguish two portfolio-scoped budgets (property_id NULL on both) or
--    a building/unit budget from its own parent property's budget in the
--    same year. (org_id, scope, scope_id, budget_year) can, since scope_id
--    is always populated (enforced by budgets_scope_id_required_check
--    above) and uniquely identifies the hierarchy node within its scope
--    level.
-- ===========================================================================
ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_org_property_year_key;
ALTER TABLE public.budgets DROP CONSTRAINT IF EXISTS budgets_org_scope_scope_id_year_key;
ALTER TABLE public.budgets
  ADD CONSTRAINT budgets_org_scope_scope_id_year_key UNIQUE (org_id, scope, scope_id, budget_year);

-- ===========================================================================
-- 5. RLS fix: budgets_select (20260707000000_budgets_rls_lockdown.sql left
--    this policy untouched, "must remain exactly as-is" — but this
--    migration changes the shape of what a NULL property_id means, so it
--    must be revisited here). The prior policy was
--    `USING (property_id IS NULL OR can_access_property(property_id))` —
--    i.e. ANY row with a NULL property_id was readable by ANY authenticated
--    user, regardless of org or portfolio membership. That was a latent gap
--    (every existing row has always had a non-null property_id, so it was
--    never actually exercised), but portfolio-scoped budgets legitimately
--    have property_id IS NULL, so this must be closed now, before that case
--    can occur, not after. Note: compute-budget/index.ts currently rejects
--    action=generate for scope="portfolio" (see handleGenerate's explicit,
--    documented refusal), so no portfolio-scoped row can be created by this
--    PR — this is a defense-in-depth fix for the schema capability, not a
--    response to an exploitable path introduced by this PR.
-- ===========================================================================
DROP POLICY IF EXISTS "budgets_select" ON public.budgets;
CREATE POLICY "budgets_select" ON public.budgets
  FOR SELECT USING (
    CASE
      WHEN property_id IS NOT NULL THEN public.can_access_property(property_id)
      WHEN portfolio_id IS NOT NULL THEN public.can_access_portfolio(portfolio_id)
      ELSE false
    END
  );

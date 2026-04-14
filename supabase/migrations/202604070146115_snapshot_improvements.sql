-- ============================================================
-- computation_snapshots improvements
-- 1. Unique indexes for upsert support (idempotent re-runs)
-- 2. latest_snapshot view — always returns the most recent
--    snapshot per (org, property, engine, fiscal_year)
-- 3. RLS fix: super_admin bypass on computation_snapshots
-- ============================================================

-- Unique index for property-scoped snapshots
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique_property
  ON public.computation_snapshots (org_id, property_id, engine_type, fiscal_year)
  WHERE property_id IS NOT NULL;

-- Unique index for org-level snapshots (property_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique_org
  ON public.computation_snapshots (org_id, engine_type, fiscal_year)
  WHERE property_id IS NULL;

-- ── latest_snapshot view ──────────────────────────────────────────────────
-- Returns the single most-recent snapshot per (org, property, engine, year).
-- Frontend and other functions can query this instead of doing ORDER BY + LIMIT.
DROP VIEW IF EXISTS public.latest_snapshots;
CREATE OR REPLACE VIEW public.latest_snapshots AS
SELECT DISTINCT ON (org_id, property_id, engine_type, fiscal_year)
  id,
  org_id,
  property_id,
  engine_type,
  fiscal_year,
  month,
  inputs,
  outputs,
  status,
  computed_at,
  computed_by,
  created_at
FROM public.computation_snapshots
ORDER BY org_id, property_id, engine_type, fiscal_year, computed_at DESC;

-- Grant select on the view to authenticated users (RLS on base table still applies)
GRANT SELECT ON public.latest_snapshots TO authenticated;

-- ── RLS fix: super_admin bypass on computation_snapshots ──────────────────
DROP POLICY IF EXISTS "computation_snapshots_select" ON public.computation_snapshots;
CREATE POLICY "computation_snapshots_select" ON public.computation_snapshots
  FOR SELECT USING (
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid() AND m.org_id = computation_snapshots.org_id
    )
  );

DROP POLICY IF EXISTS "computation_snapshots_insert" ON public.computation_snapshots;
CREATE POLICY "computation_snapshots_insert" ON public.computation_snapshots
  FOR INSERT WITH CHECK (public.can_write_org_data(org_id));

DROP POLICY IF EXISTS "computation_snapshots_update" ON public.computation_snapshots;
CREATE POLICY "computation_snapshots_update" ON public.computation_snapshots
  FOR UPDATE USING (public.can_write_org_data(org_id));

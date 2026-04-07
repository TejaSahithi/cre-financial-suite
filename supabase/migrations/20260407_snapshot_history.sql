-- ============================================================
-- Snapshot history — preserve previous computation runs
--
-- Previously we used a unique index + upsert which overwrote
-- the row in-place. Now we supersede old rows and insert fresh
-- ones, so every run is a separate immutable record.
--
-- Changes:
--   1. Drop the unique indexes (no longer needed — we INSERT, not UPSERT)
--   2. Add updated_at column (used by the supersede UPDATE)
--   3. Add index on (org_id, property_id, engine_type, fiscal_year, computed_at)
--      so ORDER BY computed_at DESC queries are fast
-- ============================================================

-- Drop unique indexes that were added for upsert support
DROP INDEX IF EXISTS idx_snapshots_unique_property;
DROP INDEX IF EXISTS idx_snapshots_unique_org;

-- Add updated_at column for the supersede UPDATE
ALTER TABLE public.computation_snapshots
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- Fast "latest per key" index
CREATE INDEX IF NOT EXISTS idx_snapshots_latest
  ON public.computation_snapshots (org_id, property_id, engine_type, fiscal_year, computed_at DESC);

-- Rebuild latest_snapshots view (unchanged logic, just re-declaring for clarity)
CREATE OR REPLACE VIEW public.latest_snapshots AS
SELECT DISTINCT ON (org_id, property_id, engine_type, fiscal_year)
  id, org_id, property_id, engine_type, fiscal_year, month,
  inputs, outputs, status, computed_at, computed_by, created_at, updated_at
FROM public.computation_snapshots
WHERE status = 'completed'
ORDER BY org_id, property_id, engine_type, fiscal_year, computed_at DESC;

GRANT SELECT ON public.latest_snapshots TO authenticated;

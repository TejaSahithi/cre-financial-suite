-- Add unique index on computation_snapshots for upsert support
-- This allows compute functions to upsert property-level aggregate snapshots
-- without creating duplicates.
--
-- NULL property_id is allowed (org-level snapshots), so we use a partial index
-- for the non-null case and handle null separately.

-- Unique index for property-scoped snapshots (most common case)
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique_property
  ON public.computation_snapshots (org_id, property_id, engine_type, fiscal_year)
  WHERE property_id IS NOT NULL;

-- Unique index for org-level snapshots (property_id IS NULL)
CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_unique_org
  ON public.computation_snapshots (org_id, engine_type, fiscal_year)
  WHERE property_id IS NULL;

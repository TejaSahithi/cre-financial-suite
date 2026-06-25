-- ============================================================
-- P0.7 — Computation snapshot versioning and locking
--
-- Adds three columns to computation_snapshots:
--   engine_version — identifies the code version that produced the result
--   locked_at      — set when a snapshot is locked; blocks recomputation
--   locked_by      — UUID of the user who locked it
--
-- NOTE: input_hash (TEXT) already exists in the table from the original
-- migration and was previously unpopulated. saveSnapshot() now writes to
-- it from inputs._compute.input_fingerprint (SHA-256). No new column needed.
-- ============================================================

ALTER TABLE public.computation_snapshots
  ADD COLUMN IF NOT EXISTS engine_version TEXT,
  ADD COLUMN IF NOT EXISTS locked_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- Indexes for lock-check queries (used in compute-cam and compute-reconciliation
-- to block recomputation when locked_at IS NOT NULL)
CREATE INDEX IF NOT EXISTS idx_snapshots_locked
  ON public.computation_snapshots (org_id, property_id, engine_type, fiscal_year)
  WHERE locked_at IS NOT NULL AND status = 'completed';

-- Rebuild latest_snapshots view to include the new columns.
-- DISTINCT ON with nullable property_id is safe in PostgreSQL: two rows where
-- property_id IS NULL are treated as equal by DISTINCT ON and only the first
-- (highest computed_at) is kept per (org, engine, fiscal_year) group.
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
  created_at,
  updated_at,
  engine_version,
  input_hash,
  locked_at,
  locked_by
FROM public.computation_snapshots
WHERE status = 'completed'
ORDER BY org_id, property_id, engine_type, fiscal_year, computed_at DESC;

GRANT SELECT ON public.latest_snapshots TO authenticated;

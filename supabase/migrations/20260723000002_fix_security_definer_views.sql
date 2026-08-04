-- ===========================================================================
-- FIX: Supabase Security Definer Views advisor warnings
-- Rebuilds view definitions with security_invoker = true so they are evaluated
-- under the client context instead of bypass privileges.
--
-- Workstream B.1 migration-history repair note (2026-08-03): this file
-- originally also (re)created extraction_runs_safe, extraction_stage_runs_safe,
-- and provider_invocations_safe here. Their underlying tables
-- (extraction_runs, extraction_stage_runs, provider_invocations) are not
-- created until migration 20260825000000_extraction_runs_provenance.sql, a
-- month later -- so those three CREATE VIEW statements have always failed
-- on a genuine from-scratch replay (confirmed via `supabase db reset
-- --local`), which is exactly what blocked a clean database build. They
-- were also entirely redundant even when they didn't error: migration
-- 20260825000000 recreates all three itself with DIFFERENT, deliberate
-- security semantics ("Deliberately NOT security_invoker = true", see that
-- file), so this migration's versions would have been immediately
-- superseded a month later regardless. Removed here rather than
-- reordered/moved, since nothing downstream depends on this specific
-- migration being the one that defines them. latest_snapshots is untouched
-- below -- its source table (computation_snapshots) already existed at
-- this point in history and this is its real, non-redundant definition.
-- ===========================================================================

-- latest_snapshots (rebuild with security_invoker = true and versioning columns)
DROP VIEW IF EXISTS public.latest_snapshots;
CREATE VIEW public.latest_snapshots 
WITH (security_invoker = true) AS
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

-- Re-apply grants
GRANT SELECT ON public.latest_snapshots TO authenticated;

-- Reload schema
NOTIFY pgrst, 'reload schema';

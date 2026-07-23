-- ===========================================================================
-- FIX: Supabase Security Definer Views advisor warnings
-- Rebuilds view definitions with security_invoker = true so they are evaluated
-- under the client context instead of bypass privileges.
-- ===========================================================================

-- 1. extraction_runs_safe
DROP VIEW IF EXISTS public.extraction_runs_safe;
CREATE VIEW public.extraction_runs_safe 
WITH (security_invoker = true) AS
SELECT id, org_id, uploaded_file_id, lease_id, generation_id, run_type,
       provider_pipeline, contract_version, status, error_code,
       started_at, completed_at, created_at, updated_at
FROM public.extraction_runs
WHERE public.is_member_of_org(org_id);

-- 2. extraction_stage_runs_safe
DROP VIEW IF EXISTS public.extraction_stage_runs_safe;
CREATE VIEW public.extraction_stage_runs_safe 
WITH (security_invoker = true) AS
SELECT id, org_id, run_id, stage, attempt, status, provider, error_code,
       started_at, finished_at, created_at, updated_at
FROM public.extraction_stage_runs
WHERE public.is_member_of_org(org_id);

-- 3. provider_invocations_safe
DROP VIEW IF EXISTS public.provider_invocations_safe;
CREATE VIEW public.provider_invocations_safe 
WITH (security_invoker = true) AS
SELECT id, org_id, run_id, stage_run_id, provider, operation, model, location,
       chunk_index, provider_attempt, status, success, failure_classification,
       input_tokens, output_tokens, latency_ms, requested_at, completed_at,
       request_artifact_status, response_artifact_status, created_at
FROM public.provider_invocations
WHERE public.is_member_of_org(org_id);

-- 4. latest_snapshots (rebuild with security_invoker = true and versioning columns)
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
GRANT SELECT ON public.extraction_runs_safe TO authenticated;
GRANT SELECT ON public.extraction_stage_runs_safe TO authenticated;
GRANT SELECT ON public.provider_invocations_safe TO authenticated;
GRANT SELECT ON public.latest_snapshots TO authenticated;

-- Reload schema
NOTIFY pgrst, 'reload schema';

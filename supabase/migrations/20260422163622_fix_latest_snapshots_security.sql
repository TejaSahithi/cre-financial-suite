-- Drop and recreate view with security_invoker enabled
DROP VIEW IF EXISTS public.latest_snapshots;

CREATE VIEW public.latest_snapshots 
WITH (security_invoker = true) 
AS
SELECT DISTINCT ON (org_id, property_id, engine_type, fiscal_year)
  id, org_id, property_id, engine_type, fiscal_year, month,
  inputs, outputs, status, computed_at, computed_by, created_at, updated_at
FROM public.computation_snapshots
WHERE status = 'completed'
ORDER BY org_id, property_id, engine_type, fiscal_year, computed_at DESC;

GRANT SELECT ON public.latest_snapshots TO authenticated;

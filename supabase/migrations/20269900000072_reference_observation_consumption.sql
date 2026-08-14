-- Priority 2 hardening: approved reference observations are the authority for
-- CPI/index-dependent calculations, and the charge read model must inherit base
-- table RLS for direct authenticated reads.

ALTER VIEW public.lease_charge_read_model SET (security_invoker = true);

ALTER TABLE public.reference_observations
  ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN public.reference_observations.evidence IS
  'Operational provenance for fetched reference values, including resolver source, lease field context, and approved series selection when applicable.';

-- Bounded Per-Domain Enrich Refactor: widens pipeline_jobs_stage_check to
-- allow the 10 new bounded enrich sub-stages (see FAILED_EXTRACTION_ROOT_CAUSE.md
-- and the "Bounded Per-Domain Enrich Refactor" plan). The single monolithic
-- "enrich" stage was crashing on complex documents (HTTP 546, Supabase
-- compute/memory exhaustion) because it tried to build the entire rich
-- review payload in one Edge Function invocation. These new stages let that
-- work happen across several smaller, bounded, independently-retryable
-- invocations instead. "enrich" itself is kept in the allowed list --
-- ENRICH_BOUNDED_STAGE_MODE defaults "off", so the existing single-stage
-- path remains the default and must keep working unchanged.

ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_stage_check;

ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_stage_check
    CHECK (stage IN (
      'parse', 'normalize', 'review_draft', 'rule_extraction', 'enrich',
      'enrich_clauses', 'enrich_fields', 'enrich_items', 'enrich_derivation',
      'enrich_evidence_core_terms', 'enrich_evidence_rent_and_charges',
      'enrich_evidence_expenses_and_cam', 'enrich_evidence_operating_obligations',
      'enrich_evidence_legal_rights_and_dates', 'enrich_truth_assembly'
    ));

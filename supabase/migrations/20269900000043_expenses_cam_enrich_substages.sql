-- Split the heavy Expenses/CAM evidence enrichment into smaller durable
-- pipeline_jobs stages. The canonical enrich_evidence_expenses_and_cam stage
-- remains in the sequence as a lightweight reducer over these sub-stage
-- outputs; downstream review/readiness code still sees the original domain
-- result while Edge Functions avoid one large resource-heavy invocation.

ALTER TABLE public.pipeline_jobs
  DROP CONSTRAINT IF EXISTS pipeline_jobs_stage_check;

ALTER TABLE public.pipeline_jobs
  ADD CONSTRAINT pipeline_jobs_stage_check
    CHECK (stage IN (
      'parse', 'normalize', 'review_draft', 'rule_extraction', 'enrich',
      'enrich_clauses', 'enrich_fields', 'enrich_items', 'enrich_derivation',
      'enrich_evidence_core_terms', 'enrich_evidence_rent_and_charges',
      'enrich_evidence_expenses_recoveries', 'enrich_evidence_cam_rules',
      'enrich_evidence_taxes', 'enrich_evidence_insurance',
      'enrich_evidence_utilities', 'enrich_evidence_expenses_and_cam',
      'enrich_evidence_operating_obligations', 'enrich_evidence_legal_rights_and_dates',
      'enrich_truth_assembly'
    ));
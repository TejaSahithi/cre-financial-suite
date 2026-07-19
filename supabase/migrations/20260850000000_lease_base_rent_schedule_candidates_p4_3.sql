-- P4.3 - immutable base-rent schedule candidates.
--
-- This migration stores explicit base-rent schedule evidence only. It does not
-- resolve dates, calculate monthly/annual/PSF equivalence, expand escalation
-- formulas, generate additional-charge/CAM/deposit/amortization schedules,
-- write extraction_data or workflow_output, modify finalizer/readiness, or add
-- runtime pipeline wiring. LEASE_FINANCIAL_SCHEDULE_MODE remains the only
-- financial schedule feature flag and defaults off in runtime code.

CREATE TABLE public.lease_base_rent_schedule_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID,
  package_id UUID,
  uploaded_file_id UUID NOT NULL,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  source_package_document_id UUID,
  source_package_effective_claim_id UUID,
  term_candidate_id UUID,
  schedule_key TEXT NOT NULL,
  instance_key TEXT NOT NULL DEFAULT 'default',
  schedule_status TEXT NOT NULL CHECK (schedule_status IN (
    'extracted', 'unresolved', 'ambiguous', 'needs_review', 'manual_required',
    'requires_related_document', 'not_present', 'not_applicable', 'unreadable',
    'extraction_failed'
  )),
  origin_type TEXT NOT NULL CHECK (origin_type IN (
    'extracted', 'reviewer', 'derived', 'calculated', 'legacy_adapter', 'system_projection'
  )),
  schedule_type TEXT NOT NULL CHECK (schedule_type IN (
    'stated_period_schedule', 'fixed_step_schedule', 'fixed_increase_schedule',
    'percentage_increase_schedule', 'cpi_linked_schedule', 'formula_schedule',
    'mixed_schedule', 'unresolved_schedule'
  )),
  currency_code TEXT,
  schedule_basis TEXT NOT NULL CHECK (schedule_basis IN (
    'explicit_periods', 'term_month_range', 'date_expression_range', 'free_rent',
    'abatement', 'escalation_instruction', 'mixed', 'unknown'
  )),
  sequence_policy TEXT,
  start_expression_id UUID,
  end_expression_id UUID,
  schedule_contract_version TEXT NOT NULL DEFAULT 'lease-base-rent-schedules-v1',
  confidence NUMERIC,
  producer_type TEXT NOT NULL CHECK (producer_type IN (
    'deterministic_mapper', 'semantic_extractor', 'validation_engine',
    'legacy_adapter', 'reviewer', 'system_projection'
  )),
  producer_name TEXT NOT NULL,
  producer_version TEXT,
  extraction_stage_run_id UUID,
  provider_invocation_id UUID,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, schedule_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_document_id, org_id) REFERENCES public.lease_package_documents (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (term_candidate_id, org_id) REFERENCES public.lease_term_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (end_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, uploaded_file_id, generation_id, org_id)
    REFERENCES public.extraction_runs (id, uploaded_file_id, generation_id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(schedule_key) BETWEEN 1 AND 600),
  CHECK (char_length(instance_key) BETWEEN 1 AND 200),
  CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CHECK (schedule_contract_version = 'lease-base-rent-schedules-v1'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (char_length(producer_name) BETWEEN 1 AND 200),
  CHECK (producer_version IS NULL OR char_length(producer_version) <= 200),
  CHECK (producer_type <> 'semantic_extractor' OR provider_invocation_id IS NOT NULL),
  CHECK (origin_type <> 'reviewer' OR (provider_invocation_id IS NULL AND extraction_stage_run_id IS NULL)),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK (NOT (metadata ? 'resolved_date')),
  CHECK (NOT (metadata ? 'calculated_monthly_rent')),
  CHECK (NOT (metadata ? 'calculated_annual_rent')),
  CHECK (NOT (metadata ? 'converted_psf_rent')),
  CHECK (NOT (metadata ? 'expanded_periods')),
  CHECK (NOT (metadata ? 'critical_dates'))
);

CREATE INDEX idx_base_rent_schedule_candidates_org_file ON public.lease_base_rent_schedule_candidates (org_id, uploaded_file_id);
CREATE INDEX idx_base_rent_schedule_candidates_package ON public.lease_base_rent_schedule_candidates (org_id, package_id) WHERE package_id IS NOT NULL;
CREATE INDEX idx_base_rent_schedule_candidates_term ON public.lease_base_rent_schedule_candidates (org_id, term_candidate_id) WHERE term_candidate_id IS NOT NULL;

ALTER TABLE public.lease_base_rent_schedule_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_schedule_candidates_org_select
  ON public.lease_base_rent_schedule_candidates
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_schedule_candidates FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_period_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schedule_candidate_id UUID NOT NULL,
  lease_id UUID,
  package_id UUID,
  generation_id UUID NOT NULL,
  period_key TEXT NOT NULL,
  sequence_number INT,
  period_status TEXT NOT NULL CHECK (period_status IN (
    'extracted', 'unresolved', 'ambiguous', 'needs_review', 'manual_required',
    'requires_related_document', 'not_present', 'not_applicable', 'unreadable',
    'extraction_failed'
  )),
  period_type TEXT NOT NULL CHECK (period_type IN (
    'standard_rent_period', 'free_rent_period', 'partial_period',
    'holdover_period', 'unresolved_period'
  )),
  start_expression_id UUID,
  end_expression_id UUID,
  start_term_month INT,
  end_term_month INT,
  term_candidate_id UUID,
  billing_status TEXT NOT NULL CHECK (billing_status IN (
    'billed', 'fully_abated', 'partially_abated', 'not_yet_determined', 'not_applicable'
  )),
  abatement_type TEXT CHECK (abatement_type IN ('full', 'partial', 'delayed_commencement', 'stated_credit', 'unknown')),
  partial_period_rule TEXT,
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  period_contract_version TEXT NOT NULL DEFAULT 'lease-base-rent-periods-v1',
  confidence NUMERIC,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, period_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (end_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (term_candidate_id, org_id) REFERENCES public.lease_term_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(period_key) BETWEEN 1 AND 600),
  CHECK (period_contract_version = 'lease-base-rent-periods-v1'),
  CHECK (sequence_number IS NULL OR sequence_number >= 1),
  CHECK (start_term_month IS NULL OR start_term_month >= 1),
  CHECK (end_term_month IS NULL OR end_term_month >= 1),
  CHECK (start_term_month IS NULL OR end_term_month IS NULL OR end_term_month >= start_term_month),
  CHECK (period_type <> 'free_rent_period' OR billing_status = 'fully_abated'),
  CHECK (period_type <> 'partial_period' OR NOT (metadata ? 'prorated_amount')),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK (NOT (metadata ? 'resolved_start_date')),
  CHECK (NOT (metadata ? 'resolved_end_date')),
  CHECK (NOT (metadata ? 'calculated_amount'))
);

CREATE INDEX idx_base_rent_period_candidates_schedule ON public.lease_base_rent_period_candidates (org_id, schedule_candidate_id);
CREATE INDEX idx_base_rent_period_candidates_term_months ON public.lease_base_rent_period_candidates (org_id, schedule_candidate_id, start_term_month, end_term_month);

ALTER TABLE public.lease_base_rent_period_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_period_candidates_org_select
  ON public.lease_base_rent_period_candidates
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_period_candidates FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_period_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schedule_candidate_id UUID NOT NULL,
  period_candidate_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  amount_key TEXT NOT NULL,
  amount_role TEXT NOT NULL CHECK (amount_role IN (
    'billed_base_rent', 'stated_monthly_rent', 'stated_annual_rent',
    'annualized_reference', 'stated_psf_rate', 'abatement_amount',
    'partial_period_amount', 'unresolved_amount'
  )),
  stated_amount NUMERIC,
  currency_code TEXT,
  frequency TEXT CHECK (frequency IN ('monthly', 'annually', 'quarterly', 'weekly', 'daily', 'one_time', 'irregular', 'unknown')),
  amount_basis TEXT NOT NULL CHECK (amount_basis IN (
    'fixed_amount', 'per_month', 'per_year', 'per_square_foot_per_year',
    'per_square_foot_per_month', 'per_day', 'percentage', 'formula_based', 'unknown'
  )),
  area_value NUMERIC,
  area_unit TEXT,
  rate_value NUMERIC,
  rate_unit TEXT,
  amount_status TEXT NOT NULL CHECK (amount_status IN (
    'extracted', 'unresolved', 'ambiguous', 'needs_review', 'manual_required',
    'requires_related_document', 'not_present', 'not_applicable', 'unreadable',
    'extraction_failed'
  )),
  origin_type TEXT NOT NULL CHECK (origin_type IN (
    'extracted', 'reviewer', 'derived', 'calculated', 'legacy_adapter', 'system_projection'
  )),
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  formula_candidate_id UUID,
  amount_contract_version TEXT NOT NULL DEFAULT 'lease-base-rent-amounts-v1',
  confidence NUMERIC,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, amount_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_base_rent_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(amount_key) BETWEEN 1 AND 600),
  CHECK (amount_contract_version = 'lease-base-rent-amounts-v1'),
  CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50),
  CHECK (amount_role <> 'annualized_reference' OR amount_basis = 'per_year'),
  CHECK (NOT (amount_role = 'billed_base_rent' AND amount_basis = 'per_year')),
  CHECK (amount_role <> 'stated_psf_rate' OR amount_basis IN ('per_square_foot_per_year', 'per_square_foot_per_month')),
  CHECK (amount_basis NOT IN ('per_square_foot_per_year', 'per_square_foot_per_month') OR amount_role = 'stated_psf_rate'),
  CHECK (stated_amount IS NOT NULL OR amount_role = 'unresolved_amount'),
  CHECK (stated_amount IS NULL OR stated_amount >= 0 OR amount_role IN ('abatement_amount', 'partial_period_amount'))
);

CREATE INDEX idx_base_rent_period_amounts_period ON public.lease_base_rent_period_amounts (org_id, period_candidate_id);
CREATE INDEX idx_base_rent_period_amounts_schedule ON public.lease_base_rent_period_amounts (org_id, schedule_candidate_id);

ALTER TABLE public.lease_base_rent_period_amounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_period_amounts_org_select
  ON public.lease_base_rent_period_amounts
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_period_amounts FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_escalation_candidates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schedule_candidate_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  escalation_key TEXT NOT NULL,
  escalation_type TEXT NOT NULL CHECK (escalation_type IN (
    'stated_next_amount', 'fixed_amount_increase', 'fixed_percentage_increase',
    'cpi_adjustment', 'periodic_step', 'custom_formula', 'unresolved_escalation'
  )),
  applies_after_period_id UUID,
  effective_expression_id UUID,
  effective_term_month INT,
  increase_amount NUMERIC,
  increase_percentage NUMERIC,
  index_name TEXT,
  floor_percentage NUMERIC,
  ceiling_percentage NUMERIC,
  frequency TEXT CHECK (frequency IN ('monthly', 'annually', 'quarterly', 'weekly', 'daily', 'one_time', 'irregular', 'unknown')),
  recurrence_definition JSONB,
  formula_definition JSONB,
  escalation_status TEXT NOT NULL CHECK (escalation_status IN (
    'extracted', 'unresolved', 'ambiguous', 'needs_review', 'manual_required',
    'requires_related_document', 'not_present', 'not_applicable', 'unreadable',
    'extraction_failed'
  )),
  source_claim_id UUID,
  source_package_effective_claim_id UUID,
  escalation_contract_version TEXT NOT NULL DEFAULT 'lease-base-rent-escalations-v1',
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  validation_errors TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, escalation_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (applies_after_period_id, org_id) REFERENCES public.lease_base_rent_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (effective_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,

  CHECK (char_length(escalation_key) BETWEEN 1 AND 600),
  CHECK (escalation_contract_version = 'lease-base-rent-escalations-v1'),
  CHECK (effective_term_month IS NULL OR effective_term_month >= 1),
  CHECK (octet_length(COALESCE(recurrence_definition, '{}'::jsonb)::text) <= 20000),
  CHECK (octet_length(COALESCE(formula_definition, '{}'::jsonb)::text) <= 20000),
  CHECK (NOT (COALESCE(recurrence_definition, '{}'::jsonb) ? 'expanded_periods')),
  CHECK (NOT (COALESCE(formula_definition, '{}'::jsonb) ? 'generated_periods')),
  CHECK (NOT (COALESCE(formula_definition, '{}'::jsonb) ? 'cpi_value')),
  CHECK (array_length(validation_errors, 1) IS NULL OR array_length(validation_errors, 1) <= 50)
);

ALTER TABLE public.lease_base_rent_escalation_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_escalation_candidates_org_select
  ON public.lease_base_rent_escalation_candidates
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_escalation_candidates FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_schedule_claim_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schedule_candidate_id UUID,
  period_candidate_id UUID,
  amount_candidate_id UUID,
  escalation_candidate_id UUID,
  source_claim_id UUID NOT NULL,
  source_package_effective_claim_id UUID,
  generation_id UUID NOT NULL,
  link_role TEXT NOT NULL CHECK (link_role IN (
    'schedule_source', 'period_boundary_source', 'amount_source', 'rate_source',
    'area_source', 'escalation_source', 'abatement_source', 'corroborating_source',
    'contradictory_source', 'contextual_source'
  )),
  link_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, link_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_base_rent_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amount_candidate_id, org_id) REFERENCES public.lease_base_rent_period_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (escalation_candidate_id, org_id) REFERENCES public.lease_base_rent_escalation_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_claim_id, org_id) REFERENCES public.lease_claims (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_package_effective_claim_id, org_id) REFERENCES public.lease_package_effective_claims (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(link_key) BETWEEN 1 AND 600),
  CHECK (num_nonnulls(schedule_candidate_id, period_candidate_id, amount_candidate_id, escalation_candidate_id) = 1)
);

ALTER TABLE public.lease_base_rent_schedule_claim_links ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_schedule_claim_links_org_select
  ON public.lease_base_rent_schedule_claim_links
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_schedule_claim_links FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_schedule_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  package_id UUID,
  uploaded_file_id UUID,
  generation_id UUID NOT NULL,
  schedule_candidate_id UUID,
  period_candidate_id UUID,
  amount_candidate_id UUID,
  conflict_key TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN (
    'overlapping_periods', 'conflicting_period_amounts', 'conflicting_period_boundaries',
    'multiple_schedule_candidates', 'amendment_sequence_ambiguous',
    'escalation_instruction_conflict', 'frequency_basis_conflict',
    'annualized_vs_billed_role_conflict', 'stale_generation_candidate',
    'missing_related_document'
  )),
  conflict_status TEXT NOT NULL DEFAULT 'open' CHECK (conflict_status IN ('open', 'resolved', 'rejected', 'superseded')),
  source_candidate_ids UUID[] NOT NULL DEFAULT '{}',
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  validation_status TEXT NOT NULL DEFAULT 'needs_review' CHECK (validation_status IN ('pending', 'valid', 'invalid', 'needs_review')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, conflict_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (uploaded_file_id, org_id) REFERENCES public.uploaded_files (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_base_rent_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amount_candidate_id, org_id) REFERENCES public.lease_base_rent_period_amounts (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(conflict_key) BETWEEN 1 AND 600),
  CHECK (octet_length(metadata::text) <= 20000),
  CHECK (NOT (metadata ? 'calculated_reconciliation'))
);

ALTER TABLE public.lease_base_rent_schedule_conflicts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_schedule_conflicts_org_select
  ON public.lease_base_rent_schedule_conflicts
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_schedule_conflicts FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_reviewer_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  schedule_candidate_id UUID,
  period_candidate_id UUID,
  amount_candidate_id UUID,
  conflict_id UUID,
  operation TEXT NOT NULL CHECK (operation IN (
    'accept_schedule', 'reject_schedule', 'replace_schedule',
    'accept_period', 'reject_period', 'correct_period_boundaries',
    'classify_annualized_vs_billed', 'select_conflicting_amount',
    'mark_schedule_incomplete', 'mark_requires_related_document', 'reopen'
  )),
  replacement_candidate JSONB,
  selected_amount_candidate_id UUID,
  related_document_requirement_id UUID,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (period_candidate_id, org_id) REFERENCES public.lease_base_rent_period_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amount_candidate_id, org_id) REFERENCES public.lease_base_rent_period_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (conflict_id, org_id) REFERENCES public.lease_base_rent_schedule_conflicts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (selected_amount_candidate_id, org_id) REFERENCES public.lease_base_rent_period_amounts (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (related_document_requirement_id, org_id) REFERENCES public.lease_related_document_requirements (id, org_id) ON DELETE RESTRICT,
  CHECK (num_nonnulls(schedule_candidate_id, period_candidate_id, amount_candidate_id, conflict_id) >= 1),
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 600),
  CHECK (reason IS NULL OR char_length(reason) <= 2000),
  CHECK (replacement_candidate IS NULL OR octet_length(replacement_candidate::text) <= 20000),
  CHECK (operation <> 'replace_schedule' OR replacement_candidate IS NOT NULL),
  CHECK (operation <> 'select_conflicting_amount' OR selected_amount_candidate_id IS NOT NULL),
  CHECK (operation <> 'mark_requires_related_document' OR related_document_requirement_id IS NOT NULL),
  CHECK (NOT (COALESCE(replacement_candidate, '{}'::jsonb) ? 'calculated_monthly_rent')),
  CHECK (NOT (COALESCE(replacement_candidate, '{}'::jsonb) ? 'resolved_date'))
);

ALTER TABLE public.lease_base_rent_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_reviewer_decisions_org_select
  ON public.lease_base_rent_reviewer_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_reviewer_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.validate_lease_base_rent_schedule_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_term public.lease_term_candidates%ROWTYPE;
  v_start_expression public.lease_date_expressions%ROWTYPE;
  v_end_expression public.lease_date_expressions%ROWTYPE;
BEGIN
  IF NEW.term_candidate_id IS NOT NULL THEN
    SELECT * INTO v_term FROM public.lease_term_candidates WHERE id = NEW.term_candidate_id AND org_id = NEW.org_id;
    IF NOT FOUND OR v_term.generation_id IS DISTINCT FROM NEW.generation_id
       OR v_term.package_id IS DISTINCT FROM NEW.package_id
       OR v_term.lease_id IS DISTINCT FROM NEW.lease_id THEN
      RAISE EXCEPTION 'RENT_SCHEDULE_CONTEXT_INVALID';
    END IF;
  END IF;
  IF NEW.start_expression_id IS NOT NULL THEN
    SELECT * INTO v_start_expression FROM public.lease_date_expressions
     WHERE id = NEW.start_expression_id AND org_id = NEW.org_id;
    IF NOT FOUND OR v_start_expression.uploaded_file_id IS DISTINCT FROM NEW.uploaded_file_id
       OR v_start_expression.extraction_run_id IS DISTINCT FROM NEW.extraction_run_id
       OR v_start_expression.generation_id IS DISTINCT FROM NEW.generation_id
       OR v_start_expression.package_id IS DISTINCT FROM NEW.package_id
       OR v_start_expression.lease_id IS DISTINCT FROM NEW.lease_id THEN
      RAISE EXCEPTION 'RENT_SCHEDULE_CONTEXT_INVALID';
    END IF;
  END IF;
  IF NEW.end_expression_id IS NOT NULL THEN
    SELECT * INTO v_end_expression FROM public.lease_date_expressions
     WHERE id = NEW.end_expression_id AND org_id = NEW.org_id;
    IF NOT FOUND OR v_end_expression.uploaded_file_id IS DISTINCT FROM NEW.uploaded_file_id
       OR v_end_expression.extraction_run_id IS DISTINCT FROM NEW.extraction_run_id
       OR v_end_expression.generation_id IS DISTINCT FROM NEW.generation_id
       OR v_end_expression.package_id IS DISTINCT FROM NEW.package_id
       OR v_end_expression.lease_id IS DISTINCT FROM NEW.lease_id THEN
      RAISE EXCEPTION 'RENT_SCHEDULE_CONTEXT_INVALID';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_lease_base_rent_schedule_insert
  BEFORE INSERT ON public.lease_base_rent_schedule_candidates
  FOR EACH ROW EXECUTE FUNCTION public.validate_lease_base_rent_schedule_insert();

CREATE OR REPLACE FUNCTION public.validate_lease_base_rent_period_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_schedule public.lease_base_rent_schedule_candidates%ROWTYPE;
BEGIN
  SELECT * INTO v_schedule FROM public.lease_base_rent_schedule_candidates
   WHERE id = NEW.schedule_candidate_id AND org_id = NEW.org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'RENT_SCHEDULE_CONTEXT_INVALID';
  END IF;
  IF v_schedule.generation_id IS DISTINCT FROM NEW.generation_id
     OR v_schedule.package_id IS DISTINCT FROM NEW.package_id
     OR v_schedule.lease_id IS DISTINCT FROM NEW.lease_id THEN
    RAISE EXCEPTION 'RENT_SCHEDULE_CONTEXT_INVALID';
  END IF;
  IF NEW.start_term_month IS NOT NULL AND NEW.end_term_month IS NOT NULL AND NEW.period_status <> 'ambiguous'
     AND EXISTS (
       SELECT 1 FROM public.lease_base_rent_period_candidates p
        WHERE p.org_id = NEW.org_id
          AND p.schedule_candidate_id = NEW.schedule_candidate_id
          AND p.period_status NOT IN ('not_present', 'not_applicable', 'unreadable', 'extraction_failed')
          AND p.start_term_month IS NOT NULL
          AND p.end_term_month IS NOT NULL
          AND int4range(p.start_term_month, p.end_term_month, '[]') && int4range(NEW.start_term_month, NEW.end_term_month, '[]')
     ) THEN
    RAISE EXCEPTION 'RENT_PERIOD_OVERLAP';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_lease_base_rent_period_insert
  BEFORE INSERT ON public.lease_base_rent_period_candidates
  FOR EACH ROW EXECUTE FUNCTION public.validate_lease_base_rent_period_insert();

CREATE OR REPLACE FUNCTION public.validate_lease_base_rent_amount_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period public.lease_base_rent_period_candidates%ROWTYPE;
BEGIN
  SELECT * INTO v_period FROM public.lease_base_rent_period_candidates
   WHERE id = NEW.period_candidate_id AND org_id = NEW.org_id;
  IF NOT FOUND OR v_period.schedule_candidate_id IS DISTINCT FROM NEW.schedule_candidate_id
     OR v_period.generation_id IS DISTINCT FROM NEW.generation_id THEN
    RAISE EXCEPTION 'RENT_SCHEDULE_CONTEXT_INVALID';
  END IF;
  IF NEW.amount_role = 'billed_base_rent'
     AND EXISTS (
       SELECT 1 FROM public.lease_base_rent_period_amounts a
        WHERE a.org_id = NEW.org_id
          AND a.period_candidate_id = NEW.period_candidate_id
          AND a.amount_role = 'billed_base_rent'
          AND a.amount_status NOT IN ('not_present', 'not_applicable', 'unreadable', 'extraction_failed')
     ) THEN
    RAISE EXCEPTION 'RENT_AMOUNT_ROLE_INVALID';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_validate_lease_base_rent_amount_insert
  BEFORE INSERT ON public.lease_base_rent_period_amounts
  FOR EACH ROW EXECUTE FUNCTION public.validate_lease_base_rent_amount_insert();

CREATE OR REPLACE FUNCTION public.enforce_base_rent_candidate_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'lease base-rent candidate rows are immutable';
  END IF;
  IF to_jsonb(NEW) - 'lease_id' = to_jsonb(OLD) - 'lease_id'
     AND NEW.lease_id IS NULL AND OLD.lease_id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'lease base-rent candidate rows are immutable; create a new candidate or reviewer decision instead';
END;
$$;

CREATE TRIGGER trg_base_rent_schedule_immutability
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_schedule_candidates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_base_rent_candidate_immutability();

CREATE TRIGGER trg_base_rent_period_immutability
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_period_candidates
  FOR EACH ROW EXECUTE FUNCTION public.enforce_base_rent_candidate_immutability();

CREATE OR REPLACE FUNCTION public.reject_base_rent_candidate_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'lease base-rent rows are immutable';
END;
$$;

CREATE TRIGGER trg_base_rent_amount_immutability
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_period_amounts
  FOR EACH ROW EXECUTE FUNCTION public.reject_base_rent_candidate_update();

CREATE TRIGGER trg_base_rent_escalation_immutability
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_escalation_candidates
  FOR EACH ROW EXECUTE FUNCTION public.reject_base_rent_candidate_update();

CREATE TRIGGER trg_base_rent_claim_link_immutability
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_schedule_claim_links
  FOR EACH ROW EXECUTE FUNCTION public.reject_base_rent_candidate_update();

CREATE TRIGGER trg_base_rent_conflict_immutability
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_schedule_conflicts
  FOR EACH ROW EXECUTE FUNCTION public.reject_base_rent_candidate_update();

CREATE TRIGGER trg_base_rent_review_decision_append_only
  BEFORE UPDATE OR DELETE ON public.lease_base_rent_reviewer_decisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_base_rent_candidate_update();

CREATE OR REPLACE FUNCTION public.p4_3_validate_file_generation(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_active_generation_id UUID;
BEGIN
  SELECT active_generation_id INTO v_active_generation_id
    FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id;
  IF v_active_generation_id IS NULL THEN
    RETURN 'FILE_NOT_FOUND_IN_ORG';
  END IF;
  IF v_active_generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN 'STALE_GENERATION';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_runs
     WHERE id = p_extraction_run_id
       AND uploaded_file_id = p_uploaded_file_id
       AND generation_id = p_generation_id
       AND org_id = p_org_id
  ) THEN
    RETURN 'EXTRACTION_RUN_NOT_FOUND';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.p4_3_validate_file_generation(UUID, UUID, UUID, UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.p4_3_validate_file_generation(UUID, UUID, UUID, UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_lease_base_rent_schedule_candidates(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_lease_id UUID,
  p_package_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_schedules JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_error TEXT;
  v_schedule JSONB;
  v_count INT;
  v_id UUID;
  v_key TEXT;
  v_inserted INT := 0;
  v_existing INT := 0;
  v_map JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF jsonb_typeof(COALESCE(p_schedules, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SCHEDULES_MUST_BE_ARRAY');
  END IF;
  v_count := jsonb_array_length(COALESCE(p_schedules, '[]'::jsonb));
  IF v_count > 100 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;
  v_error := public.p4_3_validate_file_generation(p_org_id, p_uploaded_file_id, p_extraction_run_id, p_generation_id);
  IF v_error IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', v_error);
  END IF;

  FOR v_schedule IN SELECT * FROM jsonb_array_elements(COALESCE(p_schedules, '[]'::jsonb))
  LOOP
    v_id := NULL;
    v_key := v_schedule->>'schedule_key';
    BEGIN
      INSERT INTO public.lease_base_rent_schedule_candidates (
        org_id, lease_id, package_id, uploaded_file_id, extraction_run_id, generation_id,
        source_package_document_id, source_package_effective_claim_id, term_candidate_id,
        schedule_key, instance_key, schedule_status, origin_type, schedule_type,
        currency_code, schedule_basis, sequence_policy, start_expression_id, end_expression_id,
        schedule_contract_version, confidence, producer_type, producer_name, producer_version,
        extraction_stage_run_id, provider_invocation_id, validation_status, validation_errors, metadata
      ) VALUES (
        p_org_id, p_lease_id, p_package_id, p_uploaded_file_id, p_extraction_run_id, p_generation_id,
        NULLIF(v_schedule->>'source_package_document_id', '')::uuid,
        NULLIF(v_schedule->>'source_package_effective_claim_id', '')::uuid,
        NULLIF(v_schedule->>'term_candidate_id', '')::uuid,
        v_key,
        COALESCE(NULLIF(v_schedule->>'instance_key', ''), 'default'),
        v_schedule->>'schedule_status',
        v_schedule->>'origin_type',
        v_schedule->>'schedule_type',
        NULLIF(v_schedule->>'currency_code', ''),
        v_schedule->>'schedule_basis',
        NULLIF(v_schedule->>'sequence_policy', ''),
        NULLIF(v_schedule->>'start_expression_id', '')::uuid,
        NULLIF(v_schedule->>'end_expression_id', '')::uuid,
        COALESCE(NULLIF(v_schedule->>'schedule_contract_version', ''), 'lease-base-rent-schedules-v1'),
        NULLIF(v_schedule->>'confidence', '')::numeric,
        v_schedule->>'producer_type',
        COALESCE(NULLIF(v_schedule->>'producer_name', ''), 'p4.3_base_rent_schedule_candidates'),
        NULLIF(v_schedule->>'producer_version', ''),
        NULLIF(v_schedule->>'extraction_stage_run_id', '')::uuid,
        NULLIF(v_schedule->>'provider_invocation_id', '')::uuid,
        COALESCE(NULLIF(v_schedule->>'validation_status', ''), 'pending'),
        CASE WHEN v_schedule ? 'validation_errors' AND jsonb_typeof(v_schedule->'validation_errors') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_schedule->'validation_errors'))
             ELSE '{}'::text[] END,
        COALESCE(v_schedule->'metadata', '{}'::jsonb)
      )
      ON CONFLICT (org_id, schedule_key) DO NOTHING
      RETURNING id INTO v_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', SQLERRM);
    END;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.lease_base_rent_schedule_candidates WHERE org_id = p_org_id AND schedule_key = v_key;
      v_existing := v_existing + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_map := v_map || jsonb_build_object(v_key, v_id::text);
  END LOOP;

  RETURN jsonb_build_object('success', true, 'schedules_inserted', v_inserted, 'schedules_already_existed', v_existing, 'schedule_id_map', v_map);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_base_rent_schedule_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_schedule_candidates(UUID, UUID, UUID, UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_lease_base_rent_period_candidates(
  p_org_id UUID,
  p_schedule_candidate_id UUID,
  p_generation_id UUID,
  p_periods JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_period JSONB;
  v_count INT;
  v_schedule public.lease_base_rent_schedule_candidates%ROWTYPE;
  v_id UUID;
  v_key TEXT;
  v_inserted INT := 0;
  v_existing INT := 0;
  v_map JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  SELECT * INTO v_schedule FROM public.lease_base_rent_schedule_candidates WHERE id = p_schedule_candidate_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SCHEDULE_NOT_FOUND');
  END IF;
  IF v_schedule.generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;
  IF jsonb_typeof(COALESCE(p_periods, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PERIODS_MUST_BE_ARRAY');
  END IF;
  v_count := jsonb_array_length(COALESCE(p_periods, '[]'::jsonb));
  IF v_count > 200 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;
  FOR v_period IN SELECT * FROM jsonb_array_elements(COALESCE(p_periods, '[]'::jsonb))
  LOOP
    v_id := NULL;
    v_key := v_period->>'period_key';
    BEGIN
      INSERT INTO public.lease_base_rent_period_candidates (
        org_id, schedule_candidate_id, lease_id, package_id, generation_id,
        period_key, sequence_number, period_status, period_type, start_expression_id,
        end_expression_id, start_term_month, end_term_month, term_candidate_id,
        billing_status, abatement_type, partial_period_rule, source_claim_id,
        source_package_effective_claim_id, period_contract_version, confidence,
        validation_status, validation_errors, metadata
      ) VALUES (
        p_org_id, p_schedule_candidate_id, v_schedule.lease_id, v_schedule.package_id, p_generation_id,
        v_key, NULLIF(v_period->>'sequence_number', '')::int,
        v_period->>'period_status', v_period->>'period_type',
        NULLIF(v_period->>'start_expression_id', '')::uuid,
        NULLIF(v_period->>'end_expression_id', '')::uuid,
        NULLIF(v_period->>'start_term_month', '')::int,
        NULLIF(v_period->>'end_term_month', '')::int,
        NULLIF(v_period->>'term_candidate_id', '')::uuid,
        v_period->>'billing_status',
        NULLIF(v_period->>'abatement_type', ''),
        NULLIF(v_period->>'partial_period_rule', ''),
        NULLIF(v_period->>'source_claim_id', '')::uuid,
        NULLIF(v_period->>'source_package_effective_claim_id', '')::uuid,
        COALESCE(NULLIF(v_period->>'period_contract_version', ''), 'lease-base-rent-periods-v1'),
        NULLIF(v_period->>'confidence', '')::numeric,
        COALESCE(NULLIF(v_period->>'validation_status', ''), 'pending'),
        CASE WHEN v_period ? 'validation_errors' AND jsonb_typeof(v_period->'validation_errors') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_period->'validation_errors'))
             ELSE '{}'::text[] END,
        COALESCE(v_period->'metadata', '{}'::jsonb)
      )
      ON CONFLICT (org_id, period_key) DO NOTHING
      RETURNING id INTO v_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', SQLERRM);
    END;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.lease_base_rent_period_candidates WHERE org_id = p_org_id AND period_key = v_key;
      v_existing := v_existing + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_map := v_map || jsonb_build_object(v_key, v_id::text);
  END LOOP;
  RETURN jsonb_build_object('success', true, 'periods_inserted', v_inserted, 'periods_already_existed', v_existing, 'period_id_map', v_map);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_base_rent_period_candidates(UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_period_candidates(UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_lease_base_rent_period_amounts(
  p_org_id UUID,
  p_period_candidate_id UUID,
  p_generation_id UUID,
  p_amounts JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amount JSONB;
  v_count INT;
  v_period public.lease_base_rent_period_candidates%ROWTYPE;
  v_id UUID;
  v_key TEXT;
  v_inserted INT := 0;
  v_existing INT := 0;
  v_map JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  SELECT * INTO v_period FROM public.lease_base_rent_period_candidates WHERE id = p_period_candidate_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PERIOD_NOT_FOUND');
  END IF;
  IF v_period.generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;
  IF jsonb_typeof(COALESCE(p_amounts, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'AMOUNTS_MUST_BE_ARRAY');
  END IF;
  v_count := jsonb_array_length(COALESCE(p_amounts, '[]'::jsonb));
  IF v_count > 200 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;
  FOR v_amount IN SELECT * FROM jsonb_array_elements(COALESCE(p_amounts, '[]'::jsonb))
  LOOP
    v_id := NULL;
    v_key := v_amount->>'amount_key';
    BEGIN
      INSERT INTO public.lease_base_rent_period_amounts (
        org_id, schedule_candidate_id, period_candidate_id, generation_id, amount_key,
        amount_role, stated_amount, currency_code, frequency, amount_basis,
        area_value, area_unit, rate_value, rate_unit, amount_status, origin_type,
        source_claim_id, source_package_effective_claim_id, formula_candidate_id,
        amount_contract_version, confidence, validation_status, validation_errors
      ) VALUES (
        p_org_id, v_period.schedule_candidate_id, p_period_candidate_id, p_generation_id, v_key,
        v_amount->>'amount_role', NULLIF(v_amount->>'stated_amount', '')::numeric,
        NULLIF(v_amount->>'currency_code', ''), NULLIF(v_amount->>'frequency', ''),
        v_amount->>'amount_basis', NULLIF(v_amount->>'area_value', '')::numeric,
        NULLIF(v_amount->>'area_unit', ''), NULLIF(v_amount->>'rate_value', '')::numeric,
        NULLIF(v_amount->>'rate_unit', ''), v_amount->>'amount_status',
        v_amount->>'origin_type', NULLIF(v_amount->>'source_claim_id', '')::uuid,
        NULLIF(v_amount->>'source_package_effective_claim_id', '')::uuid,
        NULLIF(v_amount->>'formula_candidate_id', '')::uuid,
        COALESCE(NULLIF(v_amount->>'amount_contract_version', ''), 'lease-base-rent-amounts-v1'),
        NULLIF(v_amount->>'confidence', '')::numeric,
        COALESCE(NULLIF(v_amount->>'validation_status', ''), 'pending'),
        CASE WHEN v_amount ? 'validation_errors' AND jsonb_typeof(v_amount->'validation_errors') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_amount->'validation_errors'))
             ELSE '{}'::text[] END
      )
      ON CONFLICT (org_id, amount_key) DO NOTHING
      RETURNING id INTO v_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', SQLERRM);
    END;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.lease_base_rent_period_amounts WHERE org_id = p_org_id AND amount_key = v_key;
      v_existing := v_existing + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_map := v_map || jsonb_build_object(v_key, v_id::text);
  END LOOP;
  RETURN jsonb_build_object('success', true, 'amounts_inserted', v_inserted, 'amounts_already_existed', v_existing, 'amount_id_map', v_map);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_base_rent_period_amounts(UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_period_amounts(UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.persist_lease_base_rent_escalation_candidates(
  p_org_id UUID,
  p_schedule_candidate_id UUID,
  p_generation_id UUID,
  p_escalations JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_escalation JSONB;
  v_count INT;
  v_schedule public.lease_base_rent_schedule_candidates%ROWTYPE;
  v_id UUID;
  v_key TEXT;
  v_inserted INT := 0;
  v_existing INT := 0;
  v_map JSONB := '{}'::jsonb;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  SELECT * INTO v_schedule FROM public.lease_base_rent_schedule_candidates WHERE id = p_schedule_candidate_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SCHEDULE_NOT_FOUND');
  END IF;
  IF v_schedule.generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;
  IF jsonb_typeof(COALESCE(p_escalations, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ESCALATIONS_MUST_BE_ARRAY');
  END IF;
  v_count := jsonb_array_length(COALESCE(p_escalations, '[]'::jsonb));
  IF v_count > 100 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'BATCH_TOO_LARGE');
  END IF;
  FOR v_escalation IN SELECT * FROM jsonb_array_elements(COALESCE(p_escalations, '[]'::jsonb))
  LOOP
    v_id := NULL;
    v_key := v_escalation->>'escalation_key';
    BEGIN
      INSERT INTO public.lease_base_rent_escalation_candidates (
        org_id, schedule_candidate_id, generation_id, escalation_key, escalation_type,
        applies_after_period_id, effective_expression_id, effective_term_month,
        increase_amount, increase_percentage, index_name, floor_percentage,
        ceiling_percentage, frequency, recurrence_definition, formula_definition,
        escalation_status, source_claim_id, source_package_effective_claim_id,
        escalation_contract_version, validation_status, validation_errors
      ) VALUES (
        p_org_id, p_schedule_candidate_id, p_generation_id, v_key,
        v_escalation->>'escalation_type',
        NULLIF(v_escalation->>'applies_after_period_id', '')::uuid,
        NULLIF(v_escalation->>'effective_expression_id', '')::uuid,
        NULLIF(v_escalation->>'effective_term_month', '')::int,
        NULLIF(v_escalation->>'increase_amount', '')::numeric,
        NULLIF(v_escalation->>'increase_percentage', '')::numeric,
        NULLIF(v_escalation->>'index_name', ''),
        NULLIF(v_escalation->>'floor_percentage', '')::numeric,
        NULLIF(v_escalation->>'ceiling_percentage', '')::numeric,
        NULLIF(v_escalation->>'frequency', ''),
        v_escalation->'recurrence_definition',
        v_escalation->'formula_definition',
        v_escalation->>'escalation_status',
        NULLIF(v_escalation->>'source_claim_id', '')::uuid,
        NULLIF(v_escalation->>'source_package_effective_claim_id', '')::uuid,
        COALESCE(NULLIF(v_escalation->>'escalation_contract_version', ''), 'lease-base-rent-escalations-v1'),
        COALESCE(NULLIF(v_escalation->>'validation_status', ''), 'pending'),
        CASE WHEN v_escalation ? 'validation_errors' AND jsonb_typeof(v_escalation->'validation_errors') = 'array'
             THEN ARRAY(SELECT jsonb_array_elements_text(v_escalation->'validation_errors'))
             ELSE '{}'::text[] END
      )
      ON CONFLICT (org_id, escalation_key) DO NOTHING
      RETURNING id INTO v_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', SQLERRM);
    END;
    IF v_id IS NULL THEN
      SELECT id INTO v_id FROM public.lease_base_rent_escalation_candidates WHERE org_id = p_org_id AND escalation_key = v_key;
      v_existing := v_existing + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;
    v_map := v_map || jsonb_build_object(v_key, v_id::text);
  END LOOP;
  RETURN jsonb_build_object('success', true, 'escalations_inserted', v_inserted, 'escalations_already_existed', v_existing, 'escalation_id_map', v_map);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_base_rent_escalation_candidates(UUID, UUID, UUID, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_base_rent_escalation_candidates(UUID, UUID, UUID, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.record_lease_base_rent_review_decision(
  p_org_id UUID,
  p_schedule_candidate_id UUID DEFAULT NULL,
  p_period_candidate_id UUID DEFAULT NULL,
  p_amount_candidate_id UUID DEFAULT NULL,
  p_conflict_id UUID DEFAULT NULL,
  p_operation TEXT DEFAULT NULL,
  p_replacement_candidate JSONB DEFAULT NULL,
  p_selected_amount_candidate_id UUID DEFAULT NULL,
  p_related_document_requirement_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_decision_id UUID;
  v_key TEXT := COALESCE(NULLIF(p_idempotency_key, ''), gen_random_uuid()::text);
  v_generation_id UUID;
  v_file_id UUID;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF p_operation NOT IN (
    'accept_schedule', 'reject_schedule', 'replace_schedule',
    'accept_period', 'reject_period', 'correct_period_boundaries',
    'classify_annualized_vs_billed', 'select_conflicting_amount',
    'mark_schedule_incomplete', 'mark_requires_related_document', 'reopen'
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;
  IF num_nonnulls(p_schedule_candidate_id, p_period_candidate_id, p_amount_candidate_id, p_conflict_id) < 1 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_REQUIRED');
  END IF;
  IF p_operation = 'replace_schedule' AND p_replacement_candidate IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REPLACEMENT_CANDIDATE_REQUIRED');
  END IF;
  IF p_operation = 'select_conflicting_amount' AND p_selected_amount_candidate_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_AMOUNT_REQUIRED');
  END IF;
  IF p_operation = 'mark_requires_related_document' AND p_related_document_requirement_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RELATED_DOCUMENT_REQUIREMENT_REQUIRED');
  END IF;
  IF p_schedule_candidate_id IS NOT NULL THEN
    SELECT generation_id, uploaded_file_id INTO v_generation_id, v_file_id
      FROM public.lease_base_rent_schedule_candidates
     WHERE id = p_schedule_candidate_id AND org_id = p_org_id;
  ELSIF p_period_candidate_id IS NOT NULL THEN
    SELECT p.generation_id, s.uploaded_file_id INTO v_generation_id, v_file_id
      FROM public.lease_base_rent_period_candidates p
      JOIN public.lease_base_rent_schedule_candidates s
        ON s.id = p.schedule_candidate_id AND s.org_id = p.org_id
     WHERE p.id = p_period_candidate_id AND p.org_id = p_org_id;
  ELSIF p_amount_candidate_id IS NOT NULL THEN
    SELECT a.generation_id, s.uploaded_file_id INTO v_generation_id, v_file_id
      FROM public.lease_base_rent_period_amounts a
      JOIN public.lease_base_rent_schedule_candidates s
        ON s.id = a.schedule_candidate_id AND s.org_id = a.org_id
     WHERE a.id = p_amount_candidate_id AND a.org_id = p_org_id;
  ELSE
    SELECT c.generation_id, c.uploaded_file_id INTO v_generation_id, v_file_id
      FROM public.lease_base_rent_schedule_conflicts c
     WHERE c.id = p_conflict_id AND c.org_id = p_org_id;
  END IF;
  IF v_generation_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_NOT_FOUND');
  END IF;
  IF v_file_id IS NOT NULL AND v_generation_id IS DISTINCT FROM (
    SELECT active_generation_id FROM public.uploaded_files WHERE id = v_file_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;
  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
  INSERT INTO public.lease_base_rent_reviewer_decisions (
    org_id, schedule_candidate_id, period_candidate_id, amount_candidate_id,
    conflict_id, operation, replacement_candidate, selected_amount_candidate_id,
    related_document_requirement_id, idempotency_key, actor_user_id, actor_email, reason
  ) VALUES (
    p_org_id, p_schedule_candidate_id, p_period_candidate_id, p_amount_candidate_id,
    p_conflict_id, p_operation, p_replacement_candidate, p_selected_amount_candidate_id,
    p_related_document_requirement_id, v_key, v_actor_user_id, v_actor_email, p_reason
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING
  RETURNING id INTO v_decision_id;
  IF v_decision_id IS NULL THEN
    SELECT id INTO v_decision_id FROM public.lease_base_rent_reviewer_decisions
     WHERE org_id = p_org_id AND idempotency_key = v_key;
  END IF;
  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (
    p_org_id, 'lease_base_rent_schedule_candidates',
    COALESCE(p_schedule_candidate_id::text, p_period_candidate_id::text, p_amount_candidate_id::text, p_conflict_id::text),
    'review', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
    jsonb_build_object('operation', p_operation, 'review_decision_id', v_decision_id),
    jsonb_build_object('idempotency_key', v_key, 'reason', p_reason)
  );
  RETURN jsonb_build_object('success', true, 'review_decision_id', v_decision_id);
END;
$$;

REVOKE ALL ON FUNCTION public.record_lease_base_rent_review_decision(UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_lease_base_rent_review_decision(UUID, UUID, UUID, UUID, UUID, TEXT, JSONB, UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

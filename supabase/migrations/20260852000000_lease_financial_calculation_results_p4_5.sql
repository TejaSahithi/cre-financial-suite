-- P4.5 deterministic financial calculation result foundation.
-- Isolated result tables only. No P2/P3/P4 source candidate mutation, no current-output write, no critical-date generation, no runtime/provider/finalizer wiring.

CREATE TABLE public.lease_financial_calculation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  lease_id UUID,
  package_id UUID,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  calculation_version TEXT NOT NULL CHECK (calculation_version = 'lease-financial-calculation-v1'),
  date_engine_version TEXT NOT NULL CHECK (date_engine_version = 'lease-date-resolution-engine-v1'),
  term_engine_version TEXT NOT NULL CHECK (term_engine_version = 'lease-term-resolution-engine-v1'),
  rent_engine_version TEXT NOT NULL CHECK (rent_engine_version = 'lease-rent-calculation-engine-v1'),
  charge_engine_version TEXT NOT NULL CHECK (charge_engine_version = 'lease-charge-calculation-engine-v1'),
  claims_registry_version TEXT NOT NULL CHECK (claims_registry_version = 'lease-claims-v1'),
  claims_registry_hash TEXT NOT NULL CHECK (claims_registry_hash = '4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a'),
  date_registry_version TEXT NOT NULL CHECK (date_registry_version = 'lease-date-expressions-v1'),
  date_registry_hash TEXT NOT NULL CHECK (date_registry_hash = '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8'),
  charge_registry_version TEXT NOT NULL CHECK (charge_registry_version = 'lease-financial-charges-v1'),
  charge_registry_hash TEXT NOT NULL CHECK (charge_registry_hash = '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c'),
  mode TEXT NOT NULL CHECK (mode IN ('off','shadow','active')),
  status TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_warnings','needs_review','failed','superseded')),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  input_date_expression_count INT NOT NULL DEFAULT 0 CHECK (input_date_expression_count BETWEEN 0 AND 5000),
  input_term_count INT NOT NULL DEFAULT 0 CHECK (input_term_count BETWEEN 0 AND 1000),
  input_rent_schedule_count INT NOT NULL DEFAULT 0 CHECK (input_rent_schedule_count BETWEEN 0 AND 1000),
  input_charge_count INT NOT NULL DEFAULT 0 CHECK (input_charge_count BETWEEN 0 AND 5000),
  resolved_date_count INT NOT NULL DEFAULT 0 CHECK (resolved_date_count >= 0),
  resolved_term_count INT NOT NULL DEFAULT 0 CHECK (resolved_term_count >= 0),
  calculated_rent_period_count INT NOT NULL DEFAULT 0 CHECK (calculated_rent_period_count >= 0),
  calculated_charge_count INT NOT NULL DEFAULT 0 CHECK (calculated_charge_count >= 0),
  validation_issue_count INT NOT NULL DEFAULT 0 CHECK (validation_issue_count >= 0),
  blocking_issue_count INT NOT NULL DEFAULT 0 CHECK (blocking_issue_count >= 0),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 20000),
  UNIQUE (id, org_id),
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR status IN ('completed','completed_with_warnings','needs_review','failed','superseded')),
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);
CREATE INDEX idx_financial_calculation_runs_org_generation ON public.lease_financial_calculation_runs (org_id, generation_id);
CREATE INDEX idx_financial_calculation_runs_package ON public.lease_financial_calculation_runs (org_id, package_id, generation_id) WHERE package_id IS NOT NULL;
CREATE UNIQUE INDEX lease_financial_calculation_runs_idempotent_idx ON public.lease_financial_calculation_runs (org_id, COALESCE(package_id, '00000000-0000-0000-0000-000000000000'::uuid), generation_id, calculation_version, input_hash);
ALTER TABLE public.lease_financial_calculation_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_calculation_runs_org_select ON public.lease_financial_calculation_runs FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_calculation_runs FROM authenticated, anon;
CREATE TABLE public.lease_date_resolution_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, date_expression_id UUID NOT NULL, lease_id UUID, package_id UUID, generation_id UUID NOT NULL,
  concept_key TEXT NOT NULL, scope_key TEXT NOT NULL DEFAULT 'lease', instance_key TEXT NOT NULL DEFAULT 'default',
  resolution_status TEXT NOT NULL CHECK (resolution_status IN ('extracted_fixed','resolved','calculated','unresolved','ambiguous','needs_review','requires_related_document','not_applicable','unreadable','extraction_failed')),
  resolved_date DATE, resolution_type TEXT NOT NULL, formula_key TEXT, formula_version TEXT,
  input_expression_ids UUID[] NOT NULL DEFAULT '{}', input_result_ids UUID[] NOT NULL DEFAULT '{}', source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(assumptions::text) <= 10000), rounding_policy TEXT, business_day_policy TEXT,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, calculation_run_id, date_expression_id, scope_key, instance_key), UNIQUE (id, org_id),
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (date_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  CHECK (resolution_status IN ('extracted_fixed','resolved','calculated') OR resolved_date IS NULL),
  CHECK (array_length(input_expression_ids, 1) IS NULL OR array_length(input_expression_ids, 1) <= 50),
  CHECK (array_length(input_result_ids, 1) IS NULL OR array_length(input_result_ids, 1) <= 50),
  CHECK (array_length(source_claim_ids, 1) IS NULL OR array_length(source_claim_ids, 1) <= 100)
);
ALTER TABLE public.lease_date_resolution_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_date_resolution_results_org_select ON public.lease_date_resolution_results FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_date_resolution_results FROM authenticated, anon;

CREATE TABLE public.lease_term_resolution_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, term_candidate_id UUID NOT NULL, lease_id UUID, package_id UUID, generation_id UUID NOT NULL,
  term_type TEXT NOT NULL, instance_key TEXT NOT NULL, resolution_status TEXT NOT NULL CHECK (resolution_status IN ('resolved','calculated','unresolved','needs_review','requires_related_document','not_applicable')),
  resolved_start_date DATE, resolved_end_date DATE, resolved_duration_value NUMERIC, resolved_duration_unit TEXT,
  start_date_result_id UUID, end_date_result_id UUID, formula_key TEXT, formula_version TEXT,
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, calculation_run_id, term_candidate_id, instance_key), UNIQUE (id, org_id),
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (term_candidate_id, org_id) REFERENCES public.lease_term_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (start_date_result_id, org_id) REFERENCES public.lease_date_resolution_results (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (end_date_result_id, org_id) REFERENCES public.lease_date_resolution_results (id, org_id) ON DELETE RESTRICT,
  CHECK (resolved_start_date IS NULL OR resolved_end_date IS NULL OR resolved_start_date <= resolved_end_date)
);
ALTER TABLE public.lease_term_resolution_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_term_resolution_results_org_select ON public.lease_term_resolution_results FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_term_resolution_results FROM authenticated, anon;
CREATE TABLE public.lease_base_rent_calculation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, schedule_candidate_id UUID NOT NULL, generation_id UUID NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('calculated','unresolved','needs_review','not_applicable')),
  formula_key TEXT, formula_version TEXT, input_period_candidate_ids UUID[] NOT NULL DEFAULT '{}', input_amount_candidate_ids UUID[] NOT NULL DEFAULT '{}',
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(assumptions::text) <= 10000), rounding_policy TEXT NOT NULL DEFAULT 'lease-financial-rounding-half-up-v1',
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  CHECK (array_length(input_period_candidate_ids, 1) IS NULL OR array_length(input_period_candidate_ids, 1) <= 250), CHECK (array_length(input_amount_candidate_ids, 1) IS NULL OR array_length(input_amount_candidate_ids, 1) <= 250)
);
ALTER TABLE public.lease_base_rent_calculation_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_calculation_results_org_select ON public.lease_base_rent_calculation_results FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_calculation_results FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_calculated_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, rent_calculation_result_id UUID NOT NULL, source_schedule_candidate_id UUID NOT NULL, source_period_candidate_id UUID, generation_id UUID NOT NULL,
  resolved_start_date DATE, resolved_end_date DATE, start_term_month INT, end_term_month INT, billing_status TEXT, abatement_status TEXT,
  result_classification TEXT NOT NULL CHECK (result_classification IN ('extracted_boundary','calculated_boundary','unresolved_boundary','stated_period','calculated_period')),
  formula_key TEXT, input_result_ids UUID[] NOT NULL DEFAULT '{}', validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (rent_calculation_result_id, org_id) REFERENCES public.lease_base_rent_calculation_results (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_schedule_candidate_id, org_id) REFERENCES public.lease_base_rent_schedule_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_period_candidate_id, org_id) REFERENCES public.lease_base_rent_period_candidates (id, org_id) ON DELETE RESTRICT,
  CHECK (resolved_start_date IS NULL OR resolved_end_date IS NULL OR resolved_start_date <= resolved_end_date)
);
ALTER TABLE public.lease_base_rent_calculated_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_calculated_periods_org_select ON public.lease_base_rent_calculated_periods FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_calculated_periods FROM authenticated, anon;

CREATE TABLE public.lease_base_rent_calculated_amounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, calculated_period_id UUID, source_amount_candidate_ids UUID[] NOT NULL DEFAULT '{}', amount_role TEXT NOT NULL,
  calculated_amount NUMERIC, stated_amount NUMERIC, variance_amount NUMERIC, currency_code TEXT CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'), frequency TEXT,
  calculation_type TEXT NOT NULL, formula_key TEXT, formula_version TEXT, input_values JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(input_values::text) <= 10000), rounding_policy TEXT NOT NULL DEFAULT 'lease-financial-rounding-half-up-v1',
  result_status TEXT NOT NULL CHECK (result_status IN ('calculated','stated_preserved','unresolved','needs_review','not_applicable')), validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (calculated_period_id, org_id) REFERENCES public.lease_base_rent_calculated_periods (id, org_id) ON DELETE RESTRICT,
  CHECK (array_length(source_amount_candidate_ids, 1) IS NULL OR array_length(source_amount_candidate_ids, 1) <= 100), CHECK (amount_role <> 'billed_first_year_rent' OR calculation_type <> 'annualized_reference')
);
ALTER TABLE public.lease_base_rent_calculated_amounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_base_rent_calculated_amounts_org_select ON public.lease_base_rent_calculated_amounts FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_base_rent_calculated_amounts FROM authenticated, anon;
CREATE TABLE public.lease_financial_charge_calculation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, charge_candidate_id UUID NOT NULL, generation_id UUID NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('calculated','reconciled','mismatch','unresolved','needs_review','not_applicable')),
  calculated_amount NUMERIC, stated_amount NUMERIC, variance_amount NUMERIC, currency_code TEXT CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  formula_type TEXT, formula_version TEXT, explicit_inputs JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(explicit_inputs::text) <= 10000),
  source_amount_ids UUID[] NOT NULL DEFAULT '{}', source_formula_ids UUID[] NOT NULL DEFAULT '{}', source_amortization_ids UUID[] NOT NULL DEFAULT '{}',
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(assumptions::text) <= 10000), rounding_policy TEXT NOT NULL DEFAULT 'lease-financial-rounding-half-up-v1',
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (charge_candidate_id, org_id) REFERENCES public.lease_financial_charge_candidates (id, org_id) ON DELETE RESTRICT,
  CHECK (array_length(source_amount_ids, 1) IS NULL OR array_length(source_amount_ids, 1) <= 100), CHECK (array_length(source_formula_ids, 1) IS NULL OR array_length(source_formula_ids, 1) <= 50), CHECK (array_length(source_amortization_ids, 1) IS NULL OR array_length(source_amortization_ids, 1) <= 50)
);
ALTER TABLE public.lease_financial_charge_calculation_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_charge_calculation_results_org_select ON public.lease_financial_charge_calculation_results FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_charge_calculation_results FROM authenticated, anon;

CREATE TABLE public.lease_financial_formula_evaluation_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, formula_candidate_id UUID, charge_calculation_result_id UUID,
  formula_type TEXT NOT NULL, formula_version TEXT NOT NULL, result_status TEXT NOT NULL CHECK (result_status IN ('calculated','validated','unresolved','needs_review','unsupported')),
  explicit_inputs JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(explicit_inputs::text) <= 10000), calculated_output JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(calculated_output::text) <= 10000), stated_output JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(stated_output::text) <= 10000), variance JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(variance::text) <= 5000),
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (formula_candidate_id, org_id) REFERENCES public.lease_financial_formula_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (charge_calculation_result_id, org_id) REFERENCES public.lease_financial_charge_calculation_results (id, org_id) ON DELETE RESTRICT
);
ALTER TABLE public.lease_financial_formula_evaluation_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_formula_evaluation_results_org_select ON public.lease_financial_formula_evaluation_results FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_formula_evaluation_results FROM authenticated, anon;

CREATE TABLE public.lease_financial_amortization_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, amortization_candidate_id UUID NOT NULL, charge_calculation_result_id UUID,
  amortization_type TEXT NOT NULL, formula_version TEXT NOT NULL, result_status TEXT NOT NULL CHECK (result_status IN ('calculated','validated','unresolved','needs_review','unsupported')),
  principal_amount NUMERIC, calculated_payment_amount NUMERIC, stated_payment_amount NUMERIC, calculated_term_total NUMERIC, variance_amount NUMERIC,
  explicit_inputs JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(explicit_inputs::text) <= 10000), assumptions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(assumptions::text) <= 10000), rounding_policy TEXT NOT NULL DEFAULT 'lease-financial-rounding-half-up-v1',
  validation_status TEXT NOT NULL CHECK (validation_status IN ('valid','warning','needs_review','invalid','unresolved')), validation_codes TEXT[] NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (amortization_candidate_id, org_id) REFERENCES public.lease_financial_amortization_candidates (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (charge_calculation_result_id, org_id) REFERENCES public.lease_financial_charge_calculation_results (id, org_id) ON DELETE RESTRICT,
  CHECK (NOT (explicit_inputs ? 'expanded_schedule'))
);
ALTER TABLE public.lease_financial_amortization_results ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_amortization_results_org_select ON public.lease_financial_amortization_results FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_amortization_results FROM authenticated, anon;
CREATE TABLE public.lease_financial_validation_issues (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, issue_type TEXT NOT NULL, issue_code TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('info','warning','needs_review','blocking')),
  related_result_table TEXT, related_result_id UUID, source_input_ids UUID[] NOT NULL DEFAULT '{}', source_claim_ids UUID[] NOT NULL DEFAULT '{}', metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 10000), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  CHECK (array_length(source_input_ids, 1) IS NULL OR array_length(source_input_ids, 1) <= 100), CHECK (array_length(source_claim_ids, 1) IS NULL OR array_length(source_claim_ids, 1) <= 100)
);
ALTER TABLE public.lease_financial_validation_issues ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_validation_issues_org_select ON public.lease_financial_validation_issues FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_validation_issues FROM authenticated, anon;

CREATE TABLE public.lease_financial_calculation_review_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  calculation_run_id UUID NOT NULL, target_result_table TEXT, target_result_id UUID,
  operation TEXT NOT NULL CHECK (operation IN ('accept_calculated_result','reject_calculated_result','select_date_path','select_formula_input','approve_rounding_policy','approve_business_day_policy','accept_stated_value','replace_assumption','mark_unresolved','mark_manual_required','reopen')),
  decision_payload JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(decision_payload::text) <= 10000), idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 300),
  actor_user_id UUID NOT NULL, actor_email TEXT, reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 1000), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key), UNIQUE (id, org_id), FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT
);
ALTER TABLE public.lease_financial_calculation_review_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_calculation_review_decisions_org_select ON public.lease_financial_calculation_review_decisions FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_calculation_review_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.reject_lease_financial_calculation_result_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'LEASE_FINANCIAL_CALCULATION_RESULTS_ARE_IMMUTABLE'; END; $$;
CREATE OR REPLACE FUNCTION public.enforce_lease_financial_calculation_run_terminal_immutability() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LEASE_FINANCIAL_CALCULATION_RUNS_ARE_IMMUTABLE'; END IF;
  IF OLD.status <> 'running' THEN RAISE EXCEPTION 'LEASE_FINANCIAL_CALCULATION_TERMINAL_RUNS_ARE_IMMUTABLE'; END IF;
  IF NEW.status = 'running' THEN RAISE EXCEPTION 'LEASE_FINANCIAL_CALCULATION_RUN_UPDATE_MUST_SETTLE'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.generation_id <> OLD.generation_id OR NEW.input_hash <> OLD.input_hash OR NEW.calculation_version <> OLD.calculation_version THEN RAISE EXCEPTION 'LEASE_FINANCIAL_CALCULATION_RUN_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_financial_calculation_runs_terminal_immutable BEFORE UPDATE OR DELETE ON public.lease_financial_calculation_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_financial_calculation_run_terminal_immutability();
CREATE TRIGGER trg_date_resolution_results_no_update BEFORE UPDATE OR DELETE ON public.lease_date_resolution_results FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_term_resolution_results_no_update BEFORE UPDATE OR DELETE ON public.lease_term_resolution_results FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_base_rent_calc_results_no_update BEFORE UPDATE OR DELETE ON public.lease_base_rent_calculation_results FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_base_rent_calc_periods_no_update BEFORE UPDATE OR DELETE ON public.lease_base_rent_calculated_periods FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_base_rent_calc_amounts_no_update BEFORE UPDATE OR DELETE ON public.lease_base_rent_calculated_amounts FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_charge_calc_results_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_charge_calculation_results FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_formula_eval_results_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_formula_evaluation_results FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_amortization_results_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_amortization_results FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_financial_validation_issues_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_validation_issues FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE TRIGGER trg_financial_calculation_reviews_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_calculation_review_decisions FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_calculation_result_mutation();
CREATE OR REPLACE FUNCTION public.start_lease_financial_calculation_run(p_org_id UUID, p_lease_id UUID, p_package_id UUID, p_extraction_run_id UUID, p_generation_id UUID, p_input_hash TEXT, p_mode TEXT, p_counts JSONB DEFAULT '{}'::jsonb, p_metadata JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run_id UUID;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF p_mode NOT IN ('off','shadow','active') THEN RAISE EXCEPTION 'INVALID_CALCULATION_MODE'; END IF;
  IF p_input_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_INPUT_HASH'; END IF;
  IF octet_length(p_metadata::text) > 20000 THEN RAISE EXCEPTION 'CALCULATION_METADATA_TOO_LARGE'; END IF;
  INSERT INTO public.lease_financial_calculation_runs (org_id, lease_id, package_id, extraction_run_id, generation_id, calculation_version, date_engine_version, term_engine_version, rent_engine_version, charge_engine_version, claims_registry_version, claims_registry_hash, date_registry_version, date_registry_hash, charge_registry_version, charge_registry_hash, mode, status, input_hash, input_date_expression_count, input_term_count, input_rent_schedule_count, input_charge_count, metadata)
  VALUES (p_org_id, p_lease_id, p_package_id, p_extraction_run_id, p_generation_id, 'lease-financial-calculation-v1','lease-date-resolution-engine-v1','lease-term-resolution-engine-v1','lease-rent-calculation-engine-v1','lease-charge-calculation-engine-v1','lease-claims-v1','4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a','lease-date-expressions-v1','4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8','lease-financial-charges-v1','9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', p_mode, 'running', p_input_hash, COALESCE((p_counts->>'date_expressions')::int, 0), COALESCE((p_counts->>'terms')::int, 0), COALESCE((p_counts->>'rent_schedules')::int, 0), COALESCE((p_counts->>'charges')::int, 0), p_metadata)
  ON CONFLICT DO NOTHING RETURNING id INTO v_run_id;
  IF v_run_id IS NULL THEN SELECT id INTO v_run_id FROM public.lease_financial_calculation_runs WHERE org_id = p_org_id AND package_id IS NOT DISTINCT FROM p_package_id AND generation_id = p_generation_id AND calculation_version = 'lease-financial-calculation-v1' AND input_hash = p_input_hash; END IF;
  RETURN jsonb_build_object('success', true, 'calculation_run_id', v_run_id);
END; $$;

CREATE OR REPLACE FUNCTION public.persist_lease_date_resolution_results(p_org_id UUID, p_calculation_run_id UUID, p_generation_id UUID, p_results JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF; IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 500 THEN RAISE EXCEPTION 'INVALID_RESULT_BATCH'; END IF; RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_results)); END; $$;
CREATE OR REPLACE FUNCTION public.persist_lease_term_resolution_results(p_org_id UUID, p_calculation_run_id UUID, p_generation_id UUID, p_results JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF; IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 250 THEN RAISE EXCEPTION 'INVALID_RESULT_BATCH'; END IF; RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_results)); END; $$;
CREATE OR REPLACE FUNCTION public.persist_lease_rent_calculation_results(p_org_id UUID, p_calculation_run_id UUID, p_generation_id UUID, p_results JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF; IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 500 THEN RAISE EXCEPTION 'INVALID_RESULT_BATCH'; END IF; RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_results)); END; $$;
CREATE OR REPLACE FUNCTION public.persist_lease_financial_charge_calculation_results(p_org_id UUID, p_calculation_run_id UUID, p_generation_id UUID, p_results JSONB) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$ BEGIN IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF; IF jsonb_typeof(p_results) <> 'array' OR jsonb_array_length(p_results) > 500 THEN RAISE EXCEPTION 'INVALID_RESULT_BATCH'; END IF; RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_results)); END; $$;

CREATE OR REPLACE FUNCTION public.settle_lease_financial_calculation_run(p_org_id UUID, p_calculation_run_id UUID, p_status TEXT, p_counts JSONB DEFAULT '{}'::jsonb, p_error_code TEXT DEFAULT NULL, p_error_message TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF p_status NOT IN ('completed','completed_with_warnings','needs_review','failed','superseded') THEN RAISE EXCEPTION 'INVALID_TERMINAL_STATUS'; END IF;
  IF p_error_message IS NOT NULL AND char_length(p_error_message) > 500 THEN RAISE EXCEPTION 'ERROR_MESSAGE_TOO_LARGE'; END IF;
  UPDATE public.lease_financial_calculation_runs SET status = p_status, completed_at = now(), resolved_date_count = COALESCE((p_counts->>'resolved_dates')::int, resolved_date_count), resolved_term_count = COALESCE((p_counts->>'resolved_terms')::int, resolved_term_count), calculated_rent_period_count = COALESCE((p_counts->>'rent_periods')::int, calculated_rent_period_count), calculated_charge_count = COALESCE((p_counts->>'charges')::int, calculated_charge_count), validation_issue_count = COALESCE((p_counts->>'validation_issues')::int, validation_issue_count), blocking_issue_count = COALESCE((p_counts->>'blocking_issues')::int, blocking_issue_count), error_code = p_error_code, error_message = p_error_message WHERE id = p_calculation_run_id AND org_id = p_org_id AND status = 'running' RETURNING status INTO v_status;
  IF v_status IS NULL THEN SELECT status INTO v_status FROM public.lease_financial_calculation_runs WHERE id = p_calculation_run_id AND org_id = p_org_id; END IF;
  RETURN jsonb_build_object('success', true, 'status', v_status);
END; $$;
CREATE OR REPLACE FUNCTION public.record_lease_financial_calculation_review_decision(p_org_id UUID, p_calculation_run_id UUID, p_target_result_table TEXT, p_target_result_id UUID, p_operation TEXT, p_decision_payload JSONB, p_reason TEXT, p_idempotency_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_actor_user_id UUID := auth.uid(); v_actor_email TEXT; v_decision_id UUID;
BEGIN
  IF v_actor_user_id IS NULL THEN RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED'); END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER'); END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key = '' THEN RETURN jsonb_build_object('success', false, 'error_code', 'IDEMPOTENCY_KEY_REQUIRED'); END IF;
  IF p_operation NOT IN ('accept_calculated_result','reject_calculated_result','select_date_path','select_formula_input','approve_rounding_policy','approve_business_day_policy','accept_stated_value','replace_assumption','mark_unresolved','mark_manual_required','reopen') THEN RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION'); END IF;
  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
  INSERT INTO public.lease_financial_calculation_review_decisions (org_id, calculation_run_id, target_result_table, target_result_id, operation, decision_payload, idempotency_key, actor_user_id, actor_email, reason)
  VALUES (p_org_id, p_calculation_run_id, p_target_result_table, p_target_result_id, p_operation, COALESCE(p_decision_payload, '{}'::jsonb), p_idempotency_key, v_actor_user_id, v_actor_email, p_reason)
  ON CONFLICT (org_id, idempotency_key) DO NOTHING RETURNING id INTO v_decision_id;
  IF v_decision_id IS NULL THEN SELECT id INTO v_decision_id FROM public.lease_financial_calculation_review_decisions WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key; END IF;
  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (p_org_id, 'lease_financial_calculation_results', p_calculation_run_id::text, 'review', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function', jsonb_build_object('operation', p_operation, 'review_decision_id', v_decision_id), jsonb_build_object('idempotency_key', p_idempotency_key));
  RETURN jsonb_build_object('success', true, 'review_decision_id', v_decision_id);
END; $$;

REVOKE ALL ON FUNCTION public.start_lease_financial_calculation_run(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_date_resolution_results(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_term_resolution_results(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_rent_calculation_results(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_charge_calculation_results(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_lease_financial_calculation_run(UUID, UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_lease_financial_calculation_review_decision(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_lease_financial_calculation_run(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_date_resolution_results(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_term_resolution_results(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_rent_calculation_results(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_charge_calculation_results(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_lease_financial_calculation_run(UUID, UUID, TEXT, JSONB, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_lease_financial_calculation_review_decision(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT, TEXT) TO authenticated, service_role;

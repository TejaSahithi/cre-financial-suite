-- P4.6 deterministic compatibility projection and shadow-diff foundation.
-- Additive immutable result tables only. No current-output write-back, no critical-date projection,
-- no finalizer/readiness change, and no runtime pipeline wiring.

CREATE TABLE public.lease_financial_projection_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  lease_id UUID,
  package_id UUID,
  calculation_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  projection_version TEXT NOT NULL CHECK (projection_version = 'lease-financial-projection-v1'),
  compatibility_contract_version TEXT NOT NULL CHECK (compatibility_contract_version = 'lease-claims-v1'),
  claims_registry_version TEXT NOT NULL CHECK (claims_registry_version = 'lease-claims-v1'),
  claims_registry_hash TEXT NOT NULL CHECK (claims_registry_hash = '4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a'),
  date_registry_version TEXT NOT NULL CHECK (date_registry_version = 'lease-date-expressions-v1'),
  date_registry_hash TEXT NOT NULL CHECK (date_registry_hash = '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8'),
  charge_registry_version TEXT NOT NULL CHECK (charge_registry_version = 'lease-financial-charges-v1'),
  charge_registry_hash TEXT NOT NULL CHECK (charge_registry_hash = '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c'),
  calculation_version TEXT NOT NULL CHECK (calculation_version = 'lease-financial-calculation-v1'),
  mode TEXT NOT NULL DEFAULT 'off' CHECK (mode IN ('off','shadow')),
  status TEXT NOT NULL CHECK (status IN ('running','completed','completed_with_warnings','needs_review','failed','superseded')),
  input_hash TEXT NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
  generation_identity TEXT NOT NULL CHECK (char_length(generation_identity) BETWEEN 1 AND 200),
  input_date_result_count INT NOT NULL DEFAULT 0 CHECK (input_date_result_count BETWEEN 0 AND 5000),
  input_term_result_count INT NOT NULL DEFAULT 0 CHECK (input_term_result_count BETWEEN 0 AND 1000),
  input_rent_result_count INT NOT NULL DEFAULT 0 CHECK (input_rent_result_count BETWEEN 0 AND 1000),
  input_charge_result_count INT NOT NULL DEFAULT 0 CHECK (input_charge_result_count BETWEEN 0 AND 5000),
  output_field_count INT NOT NULL DEFAULT 0 CHECK (output_field_count >= 0),
  output_schedule_count INT NOT NULL DEFAULT 0 CHECK (output_schedule_count >= 0),
  diff_count INT NOT NULL DEFAULT 0 CHECK (diff_count >= 0),
  validation_codes TEXT[] NOT NULL DEFAULT '{}',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT CHECK (error_message IS NULL OR char_length(error_message) <= 500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 20000),
  UNIQUE (id, org_id),
  UNIQUE (org_id, calculation_run_id, projection_version, input_hash),
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  CHECK (completed_at IS NULL OR status IN ('completed','completed_with_warnings','needs_review','failed','superseded')),
  CHECK (array_length(validation_codes, 1) IS NULL OR array_length(validation_codes, 1) <= 100),
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);

CREATE INDEX idx_financial_projection_runs_org_generation ON public.lease_financial_projection_runs (org_id, generation_id);
CREATE INDEX idx_financial_projection_runs_calculation ON public.lease_financial_projection_runs (org_id, calculation_run_id);
ALTER TABLE public.lease_financial_projection_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_projection_runs_org_select ON public.lease_financial_projection_runs FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_projection_runs FROM authenticated, anon;

CREATE TABLE public.lease_financial_field_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  projection_run_id UUID NOT NULL,
  calculation_run_id UUID NOT NULL,
  lease_id UUID,
  package_id UUID,
  generation_id UUID NOT NULL,
  field_key TEXT NOT NULL CHECK (char_length(field_key) BETWEEN 1 AND 120),
  concept_key TEXT NOT NULL CHECK (char_length(concept_key) BETWEEN 1 AND 160),
  instance_key TEXT NOT NULL DEFAULT 'default' CHECK (char_length(instance_key) BETWEEN 1 AND 160),
  projection_status TEXT NOT NULL CHECK (projection_status IN ('available','needs_review','manual_required','ambiguous','requires_related_document','not_present','not_applicable','unreadable','extraction_failed','unresolved')),
  value_origin TEXT NOT NULL CHECK (value_origin IN ('extracted','inherited','reviewer','derived','calculated','stated_and_validated','stated_calculated_mismatch','unresolved','requires_related_document')),
  value_type TEXT NOT NULL DEFAULT 'text' CHECK (char_length(value_type) BETWEEN 1 AND 40),
  value_json JSONB CHECK (value_json IS NULL OR octet_length(value_json::text) <= 2000),
  normalized_value_text TEXT CHECK (normalized_value_text IS NULL OR char_length(normalized_value_text) <= 500),
  display_value TEXT CHECK (display_value IS NULL OR char_length(display_value) <= 500),
  source_result_ids UUID[] NOT NULL DEFAULT '{}',
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  source_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (octet_length(source_evidence::text) <= 10000),
  formula_key TEXT CHECK (formula_key IS NULL OR char_length(formula_key) <= 120),
  formula_version TEXT CHECK (formula_version IS NULL OR char_length(formula_version) <= 80),
  rounding_policy TEXT CHECK (rounding_policy IS NULL OR char_length(rounding_policy) <= 120),
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(assumptions::text) <= 10000),
  validation_codes TEXT[] NOT NULL DEFAULT '{}',
  deterministic_sort_key TEXT NOT NULL CHECK (char_length(deterministic_sort_key) BETWEEN 1 AND 300),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, projection_run_id, field_key, instance_key),
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_financial_projection_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  CHECK (projection_status IN ('available','needs_review') OR value_json IS NULL),
  CHECK (array_length(source_result_ids, 1) IS NULL OR array_length(source_result_ids, 1) <= 100),
  CHECK (array_length(source_claim_ids, 1) IS NULL OR array_length(source_claim_ids, 1) <= 100),
  CHECK (array_length(validation_codes, 1) IS NULL OR array_length(validation_codes, 1) <= 100),
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);

CREATE INDEX idx_financial_field_projection_run ON public.lease_financial_field_projections (org_id, projection_run_id, deterministic_sort_key);
ALTER TABLE public.lease_financial_field_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_field_projections_org_select ON public.lease_financial_field_projections FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_field_projections FROM authenticated, anon;

CREATE TABLE public.lease_financial_schedule_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  projection_run_id UUID NOT NULL,
  calculation_run_id UUID NOT NULL,
  lease_id UUID,
  package_id UUID,
  generation_id UUID NOT NULL,
  schedule_key TEXT NOT NULL CHECK (char_length(schedule_key) BETWEEN 1 AND 160),
  schedule_type TEXT NOT NULL CHECK (char_length(schedule_type) BETWEEN 1 AND 80),
  concept_key TEXT NOT NULL CHECK (char_length(concept_key) BETWEEN 1 AND 160),
  instance_key TEXT NOT NULL DEFAULT 'default' CHECK (char_length(instance_key) BETWEEN 1 AND 160),
  projection_status TEXT NOT NULL CHECK (projection_status IN ('available','needs_review','manual_required','ambiguous','requires_related_document','not_present','not_applicable','unreadable','extraction_failed','unresolved')),
  value_origin TEXT NOT NULL CHECK (value_origin IN ('extracted','inherited','reviewer','derived','calculated','stated_and_validated','stated_calculated_mismatch','unresolved','requires_related_document')),
  start_date DATE,
  end_date DATE,
  start_term_month INT,
  end_term_month INT,
  amount_json JSONB CHECK (amount_json IS NULL OR octet_length(amount_json::text) <= 2000),
  amount_role TEXT CHECK (amount_role IS NULL OR char_length(amount_role) <= 80),
  billing_frequency TEXT CHECK (billing_frequency IS NULL OR char_length(billing_frequency) <= 80),
  source_result_ids UUID[] NOT NULL DEFAULT '{}',
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  source_evidence JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (octet_length(source_evidence::text) <= 10000),
  formula_key TEXT CHECK (formula_key IS NULL OR char_length(formula_key) <= 120),
  formula_version TEXT CHECK (formula_version IS NULL OR char_length(formula_version) <= 80),
  assumptions JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(assumptions::text) <= 10000),
  validation_codes TEXT[] NOT NULL DEFAULT '{}',
  deterministic_sort_key TEXT NOT NULL CHECK (char_length(deterministic_sort_key) BETWEEN 1 AND 300),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, projection_run_id, schedule_key, instance_key),
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_financial_projection_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE SET NULL (lease_id),
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date),
  CHECK (projection_status IN ('available','needs_review') OR amount_json IS NULL),
  CHECK (array_length(source_result_ids, 1) IS NULL OR array_length(source_result_ids, 1) <= 100),
  CHECK (array_length(source_claim_ids, 1) IS NULL OR array_length(source_claim_ids, 1) <= 100),
  CHECK (array_length(validation_codes, 1) IS NULL OR array_length(validation_codes, 1) <= 100),
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);

CREATE INDEX idx_financial_schedule_projection_run ON public.lease_financial_schedule_projections (org_id, projection_run_id, deterministic_sort_key);
ALTER TABLE public.lease_financial_schedule_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_schedule_projections_org_select ON public.lease_financial_schedule_projections FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_schedule_projections FROM authenticated, anon;

CREATE TABLE public.lease_financial_projection_diffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  projection_run_id UUID NOT NULL,
  calculation_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  diff_version TEXT NOT NULL CHECK (diff_version = 'lease-financial-projection-diff-v1'),
  comparison_target TEXT NOT NULL CHECK (comparison_target IN ('existing_lease_review','package_projection','claims_projection','none')),
  diff_classification TEXT NOT NULL CHECK (diff_classification IN ('equal','representation_only','extracted_value_added','calculated_value_added','date_resolved','date_remains_unresolved','term_resolved','rent_schedule_enriched','annualized_vs_billed_corrected','free_rent_applied','escalation_calculated','deposit_reconciled','amortization_validated','stated_calculated_match','stated_calculated_mismatch','formula_unresolved','related_document_required','financial_conflict','missing_in_p4_projection','extra_in_p4_projection','evidence_mismatch','status_mismatch','ordering_mismatch')),
  field_key TEXT CHECK (field_key IS NULL OR char_length(field_key) <= 120),
  schedule_key TEXT CHECK (schedule_key IS NULL OR char_length(schedule_key) <= 160),
  current_value JSONB CHECK (current_value IS NULL OR octet_length(current_value::text) <= 4000),
  projected_value JSONB CHECK (projected_value IS NULL OR octet_length(projected_value::text) <= 4000),
  summary JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(summary::text) <= 20000),
  artifact_version TEXT CHECK (artifact_version IS NULL OR artifact_version = 'lease-financial-projection-artifact-v1'),
  artifact_storage_path TEXT CHECK (artifact_storage_path IS NULL OR char_length(artifact_storage_path) <= 500),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 10000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_financial_projection_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);

CREATE INDEX idx_financial_projection_diffs_run ON public.lease_financial_projection_diffs (org_id, projection_run_id, diff_classification);
CREATE UNIQUE INDEX lease_financial_projection_diffs_identity_idx ON public.lease_financial_projection_diffs (org_id, projection_run_id, comparison_target, diff_classification, COALESCE(field_key, ''), COALESCE(schedule_key, ''));
ALTER TABLE public.lease_financial_projection_diffs ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_projection_diffs_org_select ON public.lease_financial_projection_diffs FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_projection_diffs FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.reject_lease_financial_projection_result_mutation() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'LEASE_FINANCIAL_PROJECTION_RESULTS_ARE_IMMUTABLE';
END; $$;

CREATE OR REPLACE FUNCTION public.enforce_lease_financial_projection_run_terminal_immutability() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'LEASE_FINANCIAL_PROJECTION_RUNS_ARE_IMMUTABLE'; END IF;
  IF OLD.status <> 'running' THEN RAISE EXCEPTION 'LEASE_FINANCIAL_PROJECTION_TERMINAL_RUNS_ARE_IMMUTABLE'; END IF;
  IF NEW.status = 'running' THEN RAISE EXCEPTION 'LEASE_FINANCIAL_PROJECTION_RUN_UPDATE_MUST_SETTLE'; END IF;
  IF NEW.org_id <> OLD.org_id OR NEW.calculation_run_id <> OLD.calculation_run_id OR NEW.generation_id <> OLD.generation_id OR NEW.input_hash <> OLD.input_hash OR NEW.projection_version <> OLD.projection_version THEN RAISE EXCEPTION 'LEASE_FINANCIAL_PROJECTION_RUN_IDENTITY_IMMUTABLE'; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_financial_projection_runs_terminal_immutable BEFORE UPDATE OR DELETE ON public.lease_financial_projection_runs FOR EACH ROW EXECUTE FUNCTION public.enforce_lease_financial_projection_run_terminal_immutability();
CREATE TRIGGER trg_financial_field_projections_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_field_projections FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_projection_result_mutation();
CREATE TRIGGER trg_financial_schedule_projections_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_schedule_projections FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_projection_result_mutation();
CREATE TRIGGER trg_financial_projection_diffs_no_update BEFORE UPDATE OR DELETE ON public.lease_financial_projection_diffs FOR EACH ROW EXECUTE FUNCTION public.reject_lease_financial_projection_result_mutation();

CREATE OR REPLACE FUNCTION public.start_lease_financial_projection_run(p_org_id UUID, p_calculation_run_id UUID, p_generation_id UUID, p_input_hash TEXT, p_mode TEXT DEFAULT 'off', p_counts JSONB DEFAULT '{}'::jsonb, p_metadata JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run_id UUID; v_calc RECORD;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF p_mode NOT IN ('off','shadow') THEN RAISE EXCEPTION 'INVALID_PROJECTION_MODE'; END IF;
  IF p_input_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'INVALID_INPUT_HASH'; END IF;
  IF octet_length(p_metadata::text) > 20000 THEN RAISE EXCEPTION 'PROJECTION_METADATA_TOO_LARGE'; END IF;
  SELECT * INTO v_calc FROM public.lease_financial_calculation_runs WHERE id = p_calculation_run_id AND org_id = p_org_id;
  IF v_calc.id IS NULL THEN RAISE EXCEPTION 'CALCULATION_RUN_NOT_FOUND'; END IF;
  IF v_calc.status NOT IN ('completed','completed_with_warnings') THEN RAISE EXCEPTION 'CALCULATION_RUN_NOT_PROJECTABLE'; END IF;
  IF v_calc.generation_id <> p_generation_id THEN RAISE EXCEPTION 'GENERATION_MISMATCH'; END IF;
  INSERT INTO public.lease_financial_projection_runs (org_id, lease_id, package_id, calculation_run_id, generation_id, projection_version, compatibility_contract_version, claims_registry_version, claims_registry_hash, date_registry_version, date_registry_hash, charge_registry_version, charge_registry_hash, calculation_version, mode, status, input_hash, generation_identity, input_date_result_count, input_term_result_count, input_rent_result_count, input_charge_result_count, metadata)
  VALUES (p_org_id, v_calc.lease_id, v_calc.package_id, p_calculation_run_id, p_generation_id, 'lease-financial-projection-v1', 'lease-claims-v1', 'lease-claims-v1', '4dd86ea371a473e68bb0930b3716740fffdfd3bbcf4979ba2643d9f8e2480a9a', 'lease-date-expressions-v1', '4fb01e689af22475cd4df1207847c37589cbfa90e56b31fbe0d30668a4c501a8', 'lease-financial-charges-v1', '9339d825b1656e60d311535e3a124218c961d5cb2af2509132f6d04c4550699c', 'lease-financial-calculation-v1', p_mode, 'running', p_input_hash, p_generation_id::text, COALESCE((p_counts->>'date_results')::int, 0), COALESCE((p_counts->>'term_results')::int, 0), COALESCE((p_counts->>'rent_results')::int, 0), COALESCE((p_counts->>'charge_results')::int, 0), p_metadata)
  ON CONFLICT DO NOTHING RETURNING id INTO v_run_id;
  IF v_run_id IS NULL THEN SELECT id INTO v_run_id FROM public.lease_financial_projection_runs WHERE org_id = p_org_id AND calculation_run_id = p_calculation_run_id AND projection_version = 'lease-financial-projection-v1' AND input_hash = p_input_hash; END IF;
  RETURN jsonb_build_object('success', true, 'projection_run_id', v_run_id);
END; $$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_field_projections(p_org_id UUID, p_projection_run_id UUID, p_generation_id UUID, p_fields JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run RECORD; v_inserted INT := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_fields) <> 'array' OR jsonb_array_length(p_fields) > 1000 THEN RAISE EXCEPTION 'INVALID_FIELD_PROJECTION_BATCH'; END IF;
  SELECT * INTO v_run FROM public.lease_financial_projection_runs WHERE id = p_projection_run_id AND org_id = p_org_id AND generation_id = p_generation_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'PROJECTION_RUN_NOT_WRITABLE'; END IF;
  WITH inserted AS (
    INSERT INTO public.lease_financial_field_projections (org_id, projection_run_id, calculation_run_id, lease_id, package_id, generation_id, field_key, concept_key, instance_key, projection_status, value_origin, value_type, value_json, normalized_value_text, display_value, source_result_ids, source_claim_ids, source_evidence, formula_key, formula_version, rounding_policy, assumptions, validation_codes, deterministic_sort_key, metadata)
    SELECT p_org_id, p_projection_run_id, v_run.calculation_run_id, v_run.lease_id, v_run.package_id, p_generation_id,
      elem->>'fieldKey', elem->>'conceptKey', COALESCE(NULLIF(elem->>'instanceKey', ''), 'default'), elem->>'projectionStatus', elem->>'valueOrigin', COALESCE(elem->>'valueType', 'text'), elem->'normalizedValue', elem->>'normalizedValue', elem->>'displayValue',
      COALESCE(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(elem->'sourceResultIds', jsonb_build_array(elem->>'sourceCalculationResultId', elem->>'sourceDateExpressionId', elem->>'statedSourceResultId', elem->>'calculatedSourceResultId'))) AS value WHERE value IS NOT NULL AND value <> ''), '{}'),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(elem->'sourceClaimIds', '[]'::jsonb))::uuid), '{}'),
      COALESCE(elem->'sourceEvidence', CASE WHEN elem ? 'evidenceSummary' THEN jsonb_build_array(elem->'evidenceSummary') ELSE '[]'::jsonb END), elem->>'formulaKey', elem->>'formulaVersion', elem->>'roundingPolicy', COALESCE(elem->'assumptions', '{}'::jsonb),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(elem->'validationCodes', '[]'::jsonb))), '{}'),
      COALESCE(elem->>'deterministicSortKey', elem->>'fieldKey', elem->>'conceptKey'), COALESCE(elem->'metadata', '{}'::jsonb)
    FROM jsonb_array_elements(p_fields) AS elem
    ON CONFLICT DO NOTHING RETURNING 1
  ) SELECT count(*) INTO v_inserted FROM inserted;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_fields), 'inserted', v_inserted);
END; $$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_schedule_projections(p_org_id UUID, p_projection_run_id UUID, p_generation_id UUID, p_schedules JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run RECORD; v_inserted INT := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_schedules) <> 'array' OR jsonb_array_length(p_schedules) > 1000 THEN RAISE EXCEPTION 'INVALID_SCHEDULE_PROJECTION_BATCH'; END IF;
  SELECT * INTO v_run FROM public.lease_financial_projection_runs WHERE id = p_projection_run_id AND org_id = p_org_id AND generation_id = p_generation_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'PROJECTION_RUN_NOT_WRITABLE'; END IF;
  WITH inserted AS (
    INSERT INTO public.lease_financial_schedule_projections (org_id, projection_run_id, calculation_run_id, lease_id, package_id, generation_id, schedule_key, schedule_type, concept_key, instance_key, projection_status, value_origin, start_date, end_date, start_term_month, end_term_month, amount_json, amount_role, billing_frequency, source_result_ids, source_claim_ids, source_evidence, formula_key, formula_version, assumptions, validation_codes, deterministic_sort_key, metadata)
    SELECT p_org_id, p_projection_run_id, v_run.calculation_run_id, v_run.lease_id, v_run.package_id, p_generation_id,
      elem->>'scheduleKey', elem->>'scheduleType', COALESCE(elem->>'conceptKey', elem->>'amountRole', elem->>'scheduleType'), COALESCE(NULLIF(elem->>'instanceKey', ''), 'default'), elem->>'scheduleStatus', elem->>'valueOrigin', NULLIF(elem->>'startDate', '')::date, NULLIF(elem->>'endDate', '')::date, NULLIF(elem->>'startTermMonth', '')::int, NULLIF(elem->>'endTermMonth', '')::int, elem->'amount', elem->>'amountRole', elem->>'billingFrequency',
      COALESCE(ARRAY(SELECT value::uuid FROM jsonb_array_elements_text(COALESCE(elem->'sourceResultIds', jsonb_build_array(elem->>'sourceCalculationResultId', elem->>'sourceDateExpressionId', elem->>'statedSourceResultId', elem->>'calculatedSourceResultId'))) AS value WHERE value IS NOT NULL AND value <> ''), '{}'),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(elem->'sourceClaimIds', '[]'::jsonb))::uuid), '{}'),
      COALESCE(elem->'sourceEvidence', CASE WHEN elem ? 'evidenceSummary' THEN jsonb_build_array(elem->'evidenceSummary') ELSE '[]'::jsonb END), elem->>'formulaKey', elem->>'formulaVersion', COALESCE(elem->'assumptions', '{}'::jsonb),
      COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(elem->'validationCodes', '[]'::jsonb))), '{}'),
      COALESCE(elem->>'deterministicSortKey', elem->>'scheduleKey', elem->>'scheduleType'), COALESCE(elem->'metadata', '{}'::jsonb)
    FROM jsonb_array_elements(p_schedules) AS elem
    ON CONFLICT DO NOTHING RETURNING 1
  ) SELECT count(*) INTO v_inserted FROM inserted;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_schedules), 'inserted', v_inserted);
END; $$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_projection_diff(p_org_id UUID, p_projection_run_id UUID, p_generation_id UUID, p_diffs JSONB)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_run RECORD; v_inserted INT := 0;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF jsonb_typeof(p_diffs) <> 'array' OR jsonb_array_length(p_diffs) > 1000 THEN RAISE EXCEPTION 'INVALID_PROJECTION_DIFF_BATCH'; END IF;
  SELECT * INTO v_run FROM public.lease_financial_projection_runs WHERE id = p_projection_run_id AND org_id = p_org_id AND generation_id = p_generation_id;
  IF v_run.id IS NULL OR v_run.status <> 'running' THEN RAISE EXCEPTION 'PROJECTION_RUN_NOT_WRITABLE'; END IF;
  WITH inserted AS (
    INSERT INTO public.lease_financial_projection_diffs (org_id, projection_run_id, calculation_run_id, generation_id, diff_version, comparison_target, diff_classification, field_key, schedule_key, current_value, projected_value, summary, artifact_version, artifact_storage_path, metadata)
    SELECT p_org_id, p_projection_run_id, v_run.calculation_run_id, p_generation_id, 'lease-financial-projection-diff-v1', COALESCE(elem->>'comparisonTarget', 'existing_lease_review'), elem->>'classification', elem->>'fieldKey', elem->>'scheduleKey', elem->'currentValue', COALESCE(elem->'projectedValue', elem->'p4Value'), COALESCE(elem->'summary', '{}'::jsonb), elem->>'artifactVersion', elem->>'artifactStoragePath', COALESCE(elem->'metadata', '{}'::jsonb)
    FROM jsonb_array_elements(p_diffs) AS elem
    ON CONFLICT DO NOTHING RETURNING 1
  ) SELECT count(*) INTO v_inserted FROM inserted;
  RETURN jsonb_build_object('success', true, 'accepted', jsonb_array_length(p_diffs), 'inserted', v_inserted);
END; $$;

CREATE OR REPLACE FUNCTION public.settle_lease_financial_projection_run(p_org_id UUID, p_projection_run_id UUID, p_status TEXT, p_counts JSONB DEFAULT '{}'::jsonb, p_validation_codes TEXT[] DEFAULT '{}', p_error_code TEXT DEFAULT NULL, p_error_message TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_status TEXT;
BEGIN
  IF auth.role() <> 'service_role' THEN RAISE EXCEPTION 'SERVICE_ROLE_ONLY'; END IF;
  IF p_status NOT IN ('completed','completed_with_warnings','needs_review','failed','superseded') THEN RAISE EXCEPTION 'INVALID_TERMINAL_STATUS'; END IF;
  IF array_length(p_validation_codes, 1) > 100 THEN RAISE EXCEPTION 'TOO_MANY_VALIDATION_CODES'; END IF;
  IF p_error_message IS NOT NULL AND char_length(p_error_message) > 500 THEN RAISE EXCEPTION 'ERROR_MESSAGE_TOO_LARGE'; END IF;
  UPDATE public.lease_financial_projection_runs
  SET status = p_status, completed_at = now(), output_field_count = COALESCE((p_counts->>'fields')::int, output_field_count), output_schedule_count = COALESCE((p_counts->>'schedules')::int, output_schedule_count), diff_count = COALESCE((p_counts->>'diffs')::int, diff_count), validation_codes = COALESCE(p_validation_codes, validation_codes), error_code = p_error_code, error_message = p_error_message
  WHERE id = p_projection_run_id AND org_id = p_org_id AND status = 'running' RETURNING status INTO v_status;
  IF v_status IS NULL THEN SELECT status INTO v_status FROM public.lease_financial_projection_runs WHERE id = p_projection_run_id AND org_id = p_org_id; END IF;
  RETURN jsonb_build_object('success', true, 'status', v_status);
END; $$;

REVOKE ALL ON FUNCTION public.start_lease_financial_projection_run(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_field_projections(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_schedule_projections(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_lease_financial_projection_diff(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.settle_lease_financial_projection_run(UUID, UUID, TEXT, JSONB, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_lease_financial_projection_run(UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_field_projections(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_schedule_projections(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_projection_diff(UUID, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_lease_financial_projection_run(UUID, UUID, TEXT, JSONB, TEXT[], TEXT, TEXT) TO service_role;
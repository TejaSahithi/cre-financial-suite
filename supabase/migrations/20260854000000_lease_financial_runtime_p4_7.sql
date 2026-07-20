-- P4.7 financial schedule runtime integration.
-- Additive runtime result tables, active compatibility write-back, critical-date projection
-- and finalizer/readiness integration behind LEASE_FINANCIAL_SCHEDULE_MODE.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE public.lease_financial_compatibility_writes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  lease_id UUID NOT NULL,
  uploaded_file_id UUID NOT NULL REFERENCES public.uploaded_files(id) ON DELETE RESTRICT,
  extraction_run_id UUID NOT NULL,
  generation_id UUID NOT NULL,
  package_id UUID,
  calculation_run_id UUID NOT NULL,
  projection_run_id UUID NOT NULL,
  projection_version TEXT NOT NULL CHECK (projection_version = 'lease-financial-projection-v1'),
  compatibility_hash TEXT NOT NULL CHECK (compatibility_hash ~ '^[a-f0-9]{64}$'),
  compatibility_patch JSONB NOT NULL CHECK (jsonb_typeof(compatibility_patch) = 'object' AND octet_length(compatibility_patch::text) <= 500000),
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','idempotent_replay')),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 300),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, idempotency_key),
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (extraction_run_id, org_id) REFERENCES public.extraction_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_financial_projection_runs (id, org_id) ON DELETE RESTRICT,
  CHECK (NOT (compatibility_patch ? 'workflow_output')),
  CHECK (NOT (compatibility_patch ? 'raw_claims')),
  CHECK (NOT (compatibility_patch ? 'provider_metadata')),
  CHECK (NOT (compatibility_patch ? 'artifact_path')),
  CHECK (NOT (compatibility_patch ? 'cam_profile')),
  CHECK (NOT (compatibility_patch ? 'expense_rules')),
  CHECK (NOT (compatibility_patch ? 'expenses')),
  CHECK (NOT (compatibility_patch ? 'budgets')),
  CHECK (NOT (compatibility_patch ? 'billing_rows')),
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);
CREATE INDEX idx_financial_compatibility_writes_generation ON public.lease_financial_compatibility_writes (org_id, uploaded_file_id, generation_id, created_at DESC);
ALTER TABLE public.lease_financial_compatibility_writes ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_compatibility_writes_org_select ON public.lease_financial_compatibility_writes FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_compatibility_writes FROM authenticated, anon;

CREATE TABLE public.lease_financial_critical_date_projections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  lease_id UUID NOT NULL,
  package_id UUID,
  generation_id UUID NOT NULL,
  calculation_run_id UUID NOT NULL,
  projection_run_id UUID NOT NULL,
  source_date_result_id UUID NOT NULL,
  source_date_expression_id UUID NOT NULL,
  critical_date_type TEXT NOT NULL CHECK (char_length(critical_date_type) BETWEEN 1 AND 120),
  resolved_date DATE NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('extracted_fixed','calculated','resolved')),
  formula_key TEXT CHECK (formula_key IS NULL OR char_length(formula_key) <= 120),
  formula_version TEXT CHECK (formula_version IS NULL OR char_length(formula_version) <= 80),
  source_claim_ids UUID[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('candidate','validated','needs_review','invalid','stale')),
  validation_codes TEXT[] NOT NULL DEFAULT '{}',
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 300),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (octet_length(metadata::text) <= 20000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (id, org_id),
  UNIQUE (org_id, idempotency_key, source_date_result_id, critical_date_type),
  FOREIGN KEY (lease_id, org_id) REFERENCES public.leases (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (package_id, org_id) REFERENCES public.lease_document_packages (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (calculation_run_id, org_id) REFERENCES public.lease_financial_calculation_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (projection_run_id, org_id) REFERENCES public.lease_financial_projection_runs (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_date_result_id, org_id) REFERENCES public.lease_date_resolution_results (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (source_date_expression_id, org_id) REFERENCES public.lease_date_expressions (id, org_id) ON DELETE RESTRICT,
  CHECK (array_length(source_claim_ids, 1) IS NULL OR array_length(source_claim_ids, 1) <= 100),
  CHECK (array_length(validation_codes, 1) IS NULL OR array_length(validation_codes, 1) <= 100),
  CHECK (NOT (metadata ? 'raw_document_text')),
  CHECK (NOT (metadata ? 'provider_payload'))
);
CREATE INDEX idx_financial_critical_date_projection_generation ON public.lease_financial_critical_date_projections (org_id, lease_id, generation_id, critical_date_type);
ALTER TABLE public.lease_financial_critical_date_projections ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_financial_critical_date_projections_org_select ON public.lease_financial_critical_date_projections FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_financial_critical_date_projections FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.lease_financial_p4_owned_field_keys()
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT ARRAY[
    'lease_date','start_date','end_date','commencement_date','expiration_date','rent_commencement_date',
    'monthly_rent','annual_rent','rent_per_sf','security_deposit','ti_allowance','lease_term_months',
    'late_fee_amount','assignment_consideration'
  ]::TEXT[];
$$;

CREATE OR REPLACE FUNCTION public.lease_financial_projection_blocker_code(p_field_key TEXT, p_concept_key TEXT, p_projection_status TEXT, p_value_origin TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_projection_status = 'requires_related_document' THEN
    RETURN 'FINANCIAL_REQUIRED_RELATED_DOCUMENT_MISSING';
  END IF;
  IF p_value_origin = 'stated_calculated_mismatch' THEN
    RETURN 'FINANCIAL_STATED_CALCULATED_MISMATCH';
  END IF;
  IF p_projection_status IN ('needs_review','manual_required','ambiguous') THEN
    RETURN 'FINANCIAL_REQUIRED_CONFLICT_OPEN';
  END IF;
  IF p_projection_status IN ('unresolved','extraction_failed','unreadable') THEN
    IF COALESCE(p_field_key, p_concept_key, '') ~ '(date)$' THEN
      RETURN 'FINANCIAL_REQUIRED_DATE_UNRESOLVED';
    END IF;
    IF COALESCE(p_field_key, p_concept_key, '') ~ '(term)' THEN
      RETURN 'FINANCIAL_REQUIRED_TERM_UNRESOLVED';
    END IF;
    RETURN 'FINANCIAL_REQUIRED_RENT_UNRESOLVED';
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.persist_lease_financial_projection(
  p_org_id UUID,
  p_lease_id UUID,
  p_uploaded_file_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_package_id UUID,
  p_calculation_run_id UUID,
  p_projection_run_id UUID,
  p_compatibility_patch JSONB,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_file public.uploaded_files%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_calc public.lease_financial_calculation_runs%ROWTYPE;
  v_projection public.lease_financial_projection_runs%ROWTYPE;
  v_existing public.lease_financial_compatibility_writes%ROWTYPE;
  v_patch_hash TEXT;
  v_allowed_keys TEXT[] := public.lease_financial_p4_owned_field_keys();
  v_next_extraction JSONB;
  v_fields JSONB := COALESCE(p_compatibility_patch->'fields', '{}'::jsonb);
  v_evidence JSONB := COALESCE(p_compatibility_patch->'field_evidence', '{}'::jsonb);
  v_confidence JSONB := COALESCE(p_compatibility_patch->'confidence_scores', '{}'::jsonb);
  v_invalid_key TEXT;
BEGIN
  IF auth.role() <> 'service_role' OR auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF p_org_id IS NULL OR p_uploaded_file_id IS NULL OR p_extraction_run_id IS NULL OR p_generation_id IS NULL OR p_calculation_run_id IS NULL OR p_projection_run_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF p_compatibility_patch IS NULL OR jsonb_typeof(p_compatibility_patch) <> 'object' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  IF octet_length(p_compatibility_patch::text) > 500000 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_TOO_LARGE');
  END IF;
  IF COALESCE(char_length(p_idempotency_key), 0) = 0 OR char_length(p_idempotency_key) > 300 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_compatibility_patch) AS key WHERE key NOT IN ('fields','field_evidence','confidence_scores')) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  IF p_compatibility_patch ?| ARRAY['workflow_output','raw_claims','claims','relationships','formula','formulas','relationship_graph','provider_metadata','artifact_path','cam_profile','expense_rules','expenses','budgets','billing_rows','rent_schedules','financial_schedules','raw_calculations','calculation_results'] THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  IF jsonb_typeof(v_fields) <> 'object' OR jsonb_typeof(v_evidence) <> 'object' OR jsonb_typeof(v_confidence) <> 'object' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_INVALID_PATCH');
  END IF;
  SELECT key INTO v_invalid_key FROM (
    SELECT jsonb_object_keys(v_fields) AS key
    UNION SELECT jsonb_object_keys(v_evidence) AS key
    UNION SELECT jsonb_object_keys(v_confidence) AS key
  ) keys WHERE NOT (key = ANY(v_allowed_keys)) LIMIT 1;
  IF v_invalid_key IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_INVALID_PATCH', 'field_key', v_invalid_key);
  END IF;

  v_patch_hash := encode(digest(p_compatibility_patch::text, 'sha256'), 'hex');
  SELECT * INTO v_existing FROM public.lease_financial_compatibility_writes WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.compatibility_hash = v_patch_hash
       AND v_existing.lease_id IS NOT DISTINCT FROM p_lease_id
       AND v_existing.uploaded_file_id = p_uploaded_file_id
       AND v_existing.extraction_run_id = p_extraction_run_id
       AND v_existing.generation_id = p_generation_id
       AND v_existing.calculation_run_id = p_calculation_run_id
       AND v_existing.projection_run_id = p_projection_run_id THEN
      RETURN jsonb_build_object('success', true, 'status', 'idempotent_replay', 'write_id', v_existing.id, 'compatibility_hash', v_existing.compatibility_hash);
    END IF;
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_IDEMPOTENCY_CONFLICT');
  END IF;

  SELECT * INTO v_file FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND OR v_file.active_generation_id IS DISTINCT FROM p_generation_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_STALE_GENERATION');
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = COALESCE(p_lease_id, (SELECT id FROM public.leases WHERE org_id = p_org_id AND source_file_id = p_uploaded_file_id LIMIT 1)) AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND OR v_lease.source_file_id IS DISTINCT FROM p_uploaded_file_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_APPROVED_LEASE');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.extraction_runs WHERE id = p_extraction_run_id AND org_id = p_org_id AND uploaded_file_id = p_uploaded_file_id AND generation_id = p_generation_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;

  SELECT * INTO v_calc FROM public.lease_financial_calculation_runs WHERE id = p_calculation_run_id AND org_id = p_org_id;
  IF NOT FOUND OR v_calc.generation_id IS DISTINCT FROM p_generation_id OR v_calc.lease_id IS DISTINCT FROM v_lease.id OR v_calc.package_id IS DISTINCT FROM p_package_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF v_calc.status = 'failed' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_NOT_COMPLETED');
  END IF;
  IF v_calc.status NOT IN ('completed','completed_with_warnings') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_NOT_COMPLETED');
  END IF;
  IF COALESCE(v_calc.blocking_issue_count, 0) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_REQUIRED_CONFLICT_OPEN');
  END IF;

  SELECT * INTO v_projection FROM public.lease_financial_projection_runs WHERE id = p_projection_run_id AND org_id = p_org_id;
  IF NOT FOUND OR v_projection.calculation_run_id IS DISTINCT FROM p_calculation_run_id OR v_projection.generation_id IS DISTINCT FROM p_generation_id OR v_projection.lease_id IS DISTINCT FROM v_lease.id OR v_projection.package_id IS DISTINCT FROM p_package_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF v_projection.projection_version <> 'lease-financial-projection-v1' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_RUN_MISMATCH');
  END IF;
  IF v_projection.status NOT IN ('completed','completed_with_warnings') OR cardinality(COALESCE(v_projection.validation_codes, '{}')) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_WRITE_NOT_COMPLETED');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.lease_financial_field_projections fp
    WHERE fp.org_id = p_org_id
      AND fp.projection_run_id = p_projection_run_id
      AND fp.field_key = ANY(v_allowed_keys)
      AND (fp.projection_status IN ('needs_review','manual_required','ambiguous','requires_related_document','unresolved','extraction_failed','unreadable') OR fp.value_origin = 'stated_calculated_mismatch' OR cardinality(COALESCE(fp.validation_codes, '{}')) > 0)
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_REQUIRED_CONFLICT_OPEN');
  END IF;

  v_next_extraction := COALESCE(v_lease.extraction_data, '{}'::jsonb);
  v_next_extraction := jsonb_set(
    v_next_extraction,
    '{fields}',
    COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(COALESCE(v_next_extraction->'fields', '{}'::jsonb)) WHERE NOT (key = ANY(v_allowed_keys))), '{}'::jsonb) || v_fields,
    true
  );
  v_next_extraction := jsonb_set(
    v_next_extraction,
    '{field_evidence}',
    COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(COALESCE(v_next_extraction->'field_evidence', '{}'::jsonb)) WHERE NOT (key = ANY(v_allowed_keys))), '{}'::jsonb) || v_evidence,
    true
  );
  v_next_extraction := jsonb_set(
    v_next_extraction,
    '{confidence_scores}',
    COALESCE((SELECT jsonb_object_agg(key, value) FROM jsonb_each(COALESCE(v_next_extraction->'confidence_scores', '{}'::jsonb)) WHERE NOT (key = ANY(v_allowed_keys))), '{}'::jsonb) || v_confidence,
    true
  );
  v_next_extraction := jsonb_set(
    v_next_extraction,
    '{extraction_debug,financial_projection}',
    jsonb_build_object(
      'mode', 'active',
      'calculation_run_id', p_calculation_run_id,
      'projection_run_id', p_projection_run_id,
      'projection_version', v_projection.projection_version,
      'compatibility_hash', v_patch_hash,
      'generation_id', p_generation_id,
      'written_at', now()
    ),
    true
  );

  UPDATE public.leases SET extraction_data = v_next_extraction, updated_at = now() WHERE id = v_lease.id AND org_id = p_org_id;

  INSERT INTO public.lease_financial_compatibility_writes (org_id, lease_id, uploaded_file_id, extraction_run_id, generation_id, package_id, calculation_run_id, projection_run_id, projection_version, compatibility_hash, compatibility_patch, idempotency_key, metadata)
  VALUES (p_org_id, v_lease.id, p_uploaded_file_id, p_extraction_run_id, p_generation_id, p_package_id, p_calculation_run_id, p_projection_run_id, v_projection.projection_version, v_patch_hash, p_compatibility_patch, p_idempotency_key, jsonb_build_object('field_count', (SELECT count(*) FROM jsonb_object_keys(v_fields))))
  RETURNING * INTO v_existing;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, field_changed, new_value, source, metadata)
  VALUES (p_org_id, 'lease', v_lease.id::text, 'lease_financial_projection_write_back', 'extraction_data.financial_projection', v_patch_hash, 'edge_function', jsonb_build_object('calculation_run_id', p_calculation_run_id, 'projection_run_id', p_projection_run_id, 'generation_id', p_generation_id));

  RETURN jsonb_build_object('success', true, 'status', 'completed', 'write_id', v_existing.id, 'compatibility_hash', v_patch_hash);
END;
$$;

CREATE OR REPLACE FUNCTION public.project_lease_financial_critical_dates(
  p_org_id UUID,
  p_lease_id UUID,
  p_package_id UUID,
  p_generation_id UUID,
  p_calculation_run_id UUID,
  p_projection_run_id UUID,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_calc public.lease_financial_calculation_runs%ROWTYPE;
  v_projection public.lease_financial_projection_runs%ROWTYPE;
  v_inserted INT := 0;
BEGIN
  IF auth.role() <> 'service_role' OR auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF p_org_id IS NULL OR p_lease_id IS NULL OR p_generation_id IS NULL OR p_calculation_run_id IS NULL OR p_projection_run_id IS NULL OR COALESCE(char_length(p_idempotency_key), 0) = 0 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CRITICAL_DATE_PROJECTION_INVALID');
  END IF;

  SELECT * INTO v_calc FROM public.lease_financial_calculation_runs WHERE id = p_calculation_run_id AND org_id = p_org_id;
  SELECT * INTO v_projection FROM public.lease_financial_projection_runs WHERE id = p_projection_run_id AND org_id = p_org_id;
  IF NOT FOUND OR v_calc.generation_id IS DISTINCT FROM p_generation_id OR v_projection.generation_id IS DISTINCT FROM p_generation_id OR v_projection.calculation_run_id IS DISTINCT FROM p_calculation_run_id OR v_calc.lease_id IS DISTINCT FROM p_lease_id OR v_calc.package_id IS DISTINCT FROM p_package_id THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_STALE_GENERATION');
  END IF;
  IF v_calc.status NOT IN ('completed','completed_with_warnings') OR v_projection.status NOT IN ('completed','completed_with_warnings') OR cardinality(COALESCE(v_projection.validation_codes, '{}')) > 0 THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CRITICAL_DATE_PROJECTION_INVALID');
  END IF;

  INSERT INTO public.lease_financial_critical_date_projections (org_id, lease_id, package_id, generation_id, calculation_run_id, projection_run_id, source_date_result_id, source_date_expression_id, critical_date_type, resolved_date, origin, formula_key, formula_version, source_claim_ids, status, validation_codes, idempotency_key, metadata)
  SELECT p_org_id, p_lease_id, p_package_id, p_generation_id, p_calculation_run_id, p_projection_run_id,
         r.id, r.date_expression_id,
         CASE
           WHEN r.concept_key IN ('commencement_date','start_date') THEN 'lease_commencement'
           WHEN r.concept_key IN ('expiration_date','end_date') THEN 'lease_expiration'
           WHEN r.concept_key = 'rent_commencement_date' THEN 'rent_commencement'
           WHEN r.concept_key = 'lease_date' THEN 'lease_execution'
           ELSE r.concept_key
         END,
         r.resolved_date,
         CASE WHEN r.resolution_status = 'extracted_fixed' THEN 'extracted_fixed' WHEN r.resolution_status = 'calculated' THEN 'calculated' ELSE 'resolved' END,
         r.formula_key,
         r.formula_version,
         COALESCE(r.source_claim_ids, '{}'),
         'candidate',
         COALESCE(r.validation_codes, '{}'),
         p_idempotency_key,
         jsonb_build_object('approval_lifecycle', 'candidate_only', 'calculation_version', v_calc.calculation_version, 'projection_version', v_projection.projection_version)
    FROM public.lease_date_resolution_results r
   WHERE r.org_id = p_org_id
     AND r.calculation_run_id = p_calculation_run_id
     AND r.generation_id = p_generation_id
     AND r.lease_id = p_lease_id
     AND r.resolved_date IS NOT NULL
     AND r.resolution_status IN ('extracted_fixed','resolved','calculated')
     AND r.validation_status IN ('valid','warning')
     AND r.concept_key IN ('lease_date','commencement_date','start_date','expiration_date','end_date','rent_commencement_date')
  ON CONFLICT (org_id, idempotency_key, source_date_result_id, critical_date_type) DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RETURN jsonb_build_object('success', true, 'status', 'completed', 'projected_count', v_inserted);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_financial_projection(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.project_lease_financial_critical_dates(UUID, UUID, UUID, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_lease_financial_projection(UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.project_lease_financial_critical_dates(UUID, UUID, UUID, UUID, UUID, UUID, TEXT) TO service_role;

ALTER FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) RENAME TO finalize_lease_extraction_for_review_p3_7;
REVOKE ALL ON FUNCTION public.finalize_lease_extraction_for_review_p3_7(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.finalize_lease_extraction_for_review(
  p_org_id UUID,
  p_uploaded_file_id UUID,
  p_generation_id UUID DEFAULT NULL,
  p_lease_id UUID DEFAULT NULL,
  p_actor_user_id UUID DEFAULT NULL,
  p_actor_email TEXT DEFAULT NULL,
  p_ledger_mode TEXT DEFAULT 'off',
  p_package_mode TEXT DEFAULT 'off',
  p_financial_mode TEXT DEFAULT 'off'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_file public.uploaded_files%ROWTYPE;
  v_generation_id UUID;
  v_lease public.leases%ROWTYPE;
  v_package_id UUID;
  v_package_membership_count INT;
  v_calc public.lease_financial_calculation_runs%ROWTYPE;
  v_projection public.lease_financial_projection_runs%ROWTYPE;
  v_write public.lease_financial_compatibility_writes%ROWTYPE;
  v_blocker_code TEXT;
BEGIN
  BEGIN
    IF COALESCE(p_ledger_mode, 'off') NOT IN ('off','shadow','active')
       OR COALESCE(p_package_mode, 'off') NOT IN ('off','shadow','active')
       OR COALESCE(p_financial_mode, 'off') NOT IN ('off','shadow','active') THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_MODE_CONFIGURATION_INVALID');
    END IF;
    IF p_financial_mode = 'shadow' AND p_ledger_mode = 'off' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER');
    END IF;
    IF p_financial_mode = 'active' AND p_ledger_mode <> 'active' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE');
    END IF;

    IF p_financial_mode <> 'active' THEN
      RETURN public.finalize_lease_extraction_for_review_p3_7(p_org_id, p_uploaded_file_id, p_generation_id, p_lease_id, p_actor_user_id, p_actor_email, p_ledger_mode, p_package_mode);
    END IF;

    SELECT * INTO v_file FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Uploaded file not found for this organization';
    END IF;
    v_generation_id := v_file.active_generation_id;
    IF p_generation_id IS NOT NULL AND p_generation_id IS DISTINCT FROM v_generation_id THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_STALE_GENERATION', 'active_generation_id', v_generation_id);
    END IF;

    SELECT * INTO v_lease FROM public.leases WHERE id = COALESCE(p_lease_id, (SELECT id FROM public.leases WHERE org_id = p_org_id AND source_file_id = p_uploaded_file_id LIMIT 1)) AND org_id = p_org_id;
    IF NOT FOUND OR v_lease.source_file_id IS DISTINCT FROM p_uploaded_file_id THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CALCULATION_MISSING');
    END IF;

    SELECT count(*), min(package_id) INTO v_package_membership_count, v_package_id
      FROM public.lease_package_documents
     WHERE org_id = p_org_id
       AND uploaded_file_id = p_uploaded_file_id
       AND generation_id = v_generation_id
       AND membership_status = 'confirmed';

    IF v_package_membership_count > 0 AND p_package_mode <> 'active' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE');
    END IF;

    SELECT * INTO v_calc
      FROM public.lease_financial_calculation_runs
     WHERE org_id = p_org_id
       AND lease_id = v_lease.id
       AND generation_id = v_generation_id
       AND package_id IS NOT DISTINCT FROM v_package_id
     ORDER BY completed_at DESC NULLS LAST, started_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CALCULATION_MISSING');
    END IF;
    IF v_calc.generation_id IS DISTINCT FROM v_generation_id THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CALCULATION_STALE_GENERATION');
    END IF;
    IF v_calc.status = 'failed' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CALCULATION_FAILED');
    END IF;
    IF v_calc.status NOT IN ('completed','completed_with_warnings') THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CALCULATION_MISSING');
    END IF;
    IF COALESCE(v_calc.blocking_issue_count, 0) > 0 THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_REQUIRED_CONFLICT_OPEN');
    END IF;

    SELECT * INTO v_projection
      FROM public.lease_financial_projection_runs
     WHERE org_id = p_org_id
       AND calculation_run_id = v_calc.id
       AND generation_id = v_generation_id
     ORDER BY completed_at DESC NULLS LAST, started_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_MISSING');
    END IF;
    IF v_projection.generation_id IS DISTINCT FROM v_generation_id THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_STALE_GENERATION');
    END IF;
    IF v_projection.status = 'failed' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_FAILED');
    END IF;
    IF v_projection.status NOT IN ('completed','completed_with_warnings') OR cardinality(COALESCE(v_projection.validation_codes, '{}')) > 0 THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_PROJECTION_FAILED');
    END IF;

    SELECT public.lease_financial_projection_blocker_code(fp.field_key, fp.concept_key, fp.projection_status, fp.value_origin)
      INTO v_blocker_code
      FROM public.lease_financial_field_projections fp
     WHERE fp.org_id = p_org_id
       AND fp.projection_run_id = v_projection.id
       AND fp.field_key = ANY(public.lease_financial_p4_owned_field_keys())
       AND public.lease_financial_projection_blocker_code(fp.field_key, fp.concept_key, fp.projection_status, fp.value_origin) IS NOT NULL
     LIMIT 1;
    IF v_blocker_code IS NOT NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', v_blocker_code);
    END IF;

    SELECT * INTO v_write
      FROM public.lease_financial_compatibility_writes
     WHERE org_id = p_org_id
       AND lease_id = v_lease.id
       AND uploaded_file_id = p_uploaded_file_id
       AND generation_id = v_generation_id
       AND package_id IS NOT DISTINCT FROM v_package_id
       AND calculation_run_id = v_calc.id
       AND projection_run_id = v_projection.id
       AND status = 'completed'
     ORDER BY created_at DESC
     LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_COMPATIBILITY_NOT_PERSISTED');
    END IF;

    IF EXISTS (
      SELECT 1 FROM public.lease_financial_critical_date_projections cdp
       WHERE cdp.org_id = p_org_id
         AND cdp.lease_id = v_lease.id
         AND cdp.generation_id = v_generation_id
         AND cdp.calculation_run_id = v_calc.id
         AND cdp.projection_run_id = v_projection.id
         AND cdp.status IN ('needs_review','invalid','stale')
    ) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FINANCIAL_CRITICAL_DATE_PROJECTION_INVALID');
    END IF;

    RETURN public.finalize_lease_extraction_for_review_p3_7(p_org_id, p_uploaded_file_id, v_generation_id, v_lease.id, p_actor_user_id, p_actor_email, p_ledger_mode, p_package_mode);
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FINALIZATION_FAILED', 'error_message', SQLERRM);
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_lease_extraction_for_review(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT) TO service_role;

-- P3.4 - deterministic, evidence-backed document relationship detection.
--
-- Adds bounded RPC write paths for detector-produced relationship candidates
-- and reviewer relationship decisions. No pipeline call site is added here;
-- LEASE_DOCUMENT_PACKAGE_MODE remains the runtime gate in application code.

CREATE TABLE public.lease_document_relationship_reviewer_decisions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  relationship_id UUID NOT NULL,
  operation       TEXT NOT NULL CHECK (operation IN (
    'confirm', 'reject', 'select_target', 'mark_requires_related_document',
    'reopen', 'confirm_supersedes', 'waive_related_document_requirement'
  )),
  resulting_relationship_id UUID,
  idempotency_key TEXT NOT NULL,
  actor_user_id UUID NOT NULL,
  actor_email TEXT,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (org_id, idempotency_key),
  UNIQUE (id, org_id),
  FOREIGN KEY (relationship_id, org_id) REFERENCES public.lease_document_relationships (id, org_id) ON DELETE RESTRICT,
  FOREIGN KEY (resulting_relationship_id, org_id) REFERENCES public.lease_document_relationships (id, org_id) ON DELETE RESTRICT,
  CHECK (char_length(idempotency_key) BETWEEN 1 AND 600),
  CHECK (reason IS NULL OR char_length(reason) <= 2000)
);

ALTER TABLE public.lease_document_relationship_reviewer_decisions ENABLE ROW LEVEL SECURITY;
CREATE POLICY lease_document_relationship_reviewer_decisions_org_select
  ON public.lease_document_relationship_reviewer_decisions
  FOR SELECT USING (public.is_member_of_org(org_id));
REVOKE ALL ON public.lease_document_relationship_reviewer_decisions FROM authenticated, anon;

CREATE OR REPLACE FUNCTION public.persist_lease_document_relationship_candidates(
  p_org_id UUID,
  p_package_id UUID,
  p_detector_contract_version TEXT,
  p_candidates JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_candidate JSONB;
  v_source RECORD;
  v_target RECORD;
  v_target_id UUID;
  v_target_segment_id UUID;
  v_stage_run_id UUID;
  v_claim RECORD;
  v_evidence_claim_ids JSONB;
  v_dynamic_evidence_claim_ids JSONB;
  v_relationship_id UUID;
  v_inserted INT := 0;
  v_already_existed INT := 0;
  v_relationship_ids JSONB := '[]'::jsonb;
  v_relationship_key TEXT;
  v_evidence_claim_id UUID;
  v_reason_codes JSONB;
BEGIN
  IF auth.uid() IS NOT NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'SERVICE_ROLE_ONLY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lease_document_packages WHERE id = p_package_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_NOT_FOUND_IN_ORG');
  END IF;
  IF jsonb_typeof(COALESCE(p_candidates, '[]'::jsonb)) <> 'array' THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'CANDIDATES_MUST_BE_ARRAY');
  END IF;

  FOR v_candidate IN SELECT * FROM jsonb_array_elements(COALESCE(p_candidates, '[]'::jsonb))
  LOOP
    SELECT * INTO v_source FROM public.lease_package_documents
     WHERE id = NULLIF(v_candidate->>'source_package_document_id', '')::uuid
       AND org_id = p_org_id AND package_id = p_package_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SOURCE_NOT_IN_PACKAGE');
    END IF;

    IF v_source.generation_id IS DISTINCT FROM (
      SELECT active_generation_id FROM public.uploaded_files WHERE id = v_source.uploaded_file_id AND org_id = p_org_id
    ) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SOURCE_GENERATION_STALE');
    END IF;

    v_target := NULL;
    v_target_id := NULL;
    v_target_segment_id := NULL;
    v_stage_run_id := NULL;
    IF NULLIF(v_candidate->>'target_package_document_id', '') IS NOT NULL THEN
      SELECT * INTO v_target FROM public.lease_package_documents
       WHERE id = NULLIF(v_candidate->>'target_package_document_id', '')::uuid
         AND org_id = p_org_id AND package_id = p_package_id;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_NOT_IN_PACKAGE');
      END IF;
      IF v_target.id = v_source.id THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'SELF_RELATIONSHIP');
      END IF;
      IF v_target.membership_status NOT IN ('confirmed', 'proposed') THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_MEMBERSHIP_INVALID');
      END IF;
      IF v_target.generation_id IS DISTINCT FROM (
        SELECT active_generation_id FROM public.uploaded_files WHERE id = v_target.uploaded_file_id AND org_id = p_org_id
      ) THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_GENERATION_STALE');
      END IF;
      v_target_id := v_target.id;
      v_target_segment_id := v_target.full_file_segment_id;
    END IF;

    SELECT extraction_stage_run_id INTO v_stage_run_id
      FROM public.lease_document_profile_records
     WHERE id = v_source.canonical_profile_record_id
       AND org_id = p_org_id
       AND uploaded_file_id = v_source.uploaded_file_id
       AND extraction_run_id = v_source.extraction_run_id
       AND generation_id = v_source.generation_id;
    IF v_stage_run_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SOURCE_STAGE_RUN_REQUIRED');
    END IF;

    v_evidence_claim_ids := COALESCE(v_candidate->'evidence_claim_ids', '[]'::jsonb);
    v_dynamic_evidence_claim_ids := COALESCE(v_candidate->'dynamic_evidence_claim_ids', '[]'::jsonb);
    IF jsonb_typeof(v_evidence_claim_ids) <> 'array' OR jsonb_typeof(v_dynamic_evidence_claim_ids) <> 'array' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'EVIDENCE_IDS_MUST_BE_ARRAYS');
    END IF;

    v_evidence_claim_id := NULL;
    FOR v_claim IN
      SELECT * FROM public.lease_claims
       WHERE org_id = p_org_id
         AND id IN (
           SELECT jsonb_array_elements_text(v_evidence_claim_ids)::uuid
           UNION
           SELECT jsonb_array_elements_text(v_dynamic_evidence_claim_ids)::uuid
         )
    LOOP
      IF v_claim.uploaded_file_id IS DISTINCT FROM v_source.uploaded_file_id
         OR v_claim.extraction_run_id IS DISTINCT FROM v_source.extraction_run_id
         OR v_claim.generation_id IS DISTINCT FROM v_source.generation_id
      THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'EVIDENCE_GENERATION_MISMATCH');
      END IF;
      IF v_evidence_claim_id IS NULL AND v_claim.id::text IN (SELECT jsonb_array_elements_text(v_evidence_claim_ids)) THEN
        v_evidence_claim_id := v_claim.id;
      END IF;
    END LOOP;

    IF jsonb_array_length(v_evidence_claim_ids) + jsonb_array_length(v_dynamic_evidence_claim_ids) > 0 THEN
      IF (
        SELECT count(*) FROM public.lease_claims
         WHERE org_id = p_org_id
           AND id IN (
             SELECT jsonb_array_elements_text(v_evidence_claim_ids)::uuid
             UNION
             SELECT jsonb_array_elements_text(v_dynamic_evidence_claim_ids)::uuid
           )
      ) <> jsonb_array_length(v_evidence_claim_ids) + jsonb_array_length(v_dynamic_evidence_claim_ids) THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'EVIDENCE_CLAIM_NOT_FOUND');
      END IF;
    END IF;

    v_reason_codes := COALESCE(v_candidate->'reason_codes', '[]'::jsonb);
    v_relationship_key := COALESCE(
      NULLIF(v_candidate->>'relationship_key', ''),
      'relationship:' || p_org_id::text || ':' || p_package_id::text || ':' ||
      v_source.id::text || ':' || COALESCE(v_target_id::text, 'missing-target') || ':' ||
      (v_candidate->>'relationship_type') || ':' || COALESCE(p_detector_contract_version, 'lease-document-relationships-v1')
    );

    INSERT INTO public.lease_document_relationships (
      org_id, package_id, source_package_document_id, target_package_document_id,
      source_segment_id, target_segment_id, relationship_type, relationship_status,
      validation_status, relationship_key, confidence, producer_type, producer_name,
      producer_version, extraction_run_id, extraction_stage_run_id, generation_id,
      evidence_claim_id, evidence_summary
    ) VALUES (
      p_org_id, p_package_id, v_source.id, v_target_id,
      COALESCE(NULLIF(v_candidate->>'source_segment_id', '')::uuid, v_source.full_file_segment_id),
      COALESCE(NULLIF(v_candidate->>'target_segment_id', '')::uuid, v_target_segment_id),
      v_candidate->>'relationship_type',
      COALESCE(NULLIF(v_candidate->>'relationship_status', ''), 'proposed'),
      COALESCE(NULLIF(v_candidate->>'validation_status', ''), 'pending'),
      v_relationship_key,
      NULLIF(v_candidate->>'confidence', '')::numeric,
      'deterministic_relationship_detector',
      'document-package-relationship-detector',
      COALESCE(p_detector_contract_version, 'lease-document-relationships-v1'),
      v_source.extraction_run_id,
      v_stage_run_id,
      v_source.generation_id,
      v_evidence_claim_id,
      jsonb_build_object(
        'detector_contract_version', COALESCE(p_detector_contract_version, 'lease-document-relationships-v1'),
        'reason_codes', v_reason_codes,
        'evidence_claim_ids', v_evidence_claim_ids,
        'dynamic_evidence_claim_ids', v_dynamic_evidence_claim_ids,
        'candidate_target_document_ids', COALESCE(v_candidate->'candidate_target_document_ids', '[]'::jsonb),
        'explicit_reference', COALESCE((v_candidate->>'explicit_reference')::boolean, false),
        'reviewer_confirmation_required', COALESCE((v_candidate->>'reviewer_confirmation_required')::boolean, true),
        'requires_related_document', v_candidate->'requires_related_document'
      )
    )
    ON CONFLICT (org_id, relationship_key) DO NOTHING
    RETURNING id INTO v_relationship_id;

    IF v_relationship_id IS NULL THEN
      SELECT id INTO v_relationship_id FROM public.lease_document_relationships
       WHERE org_id = p_org_id AND relationship_key = v_relationship_key;
      v_already_existed := v_already_existed + 1;
    ELSE
      v_inserted := v_inserted + 1;
    END IF;

    v_relationship_ids := v_relationship_ids || to_jsonb(v_relationship_id::text);
  END LOOP;

  RETURN jsonb_build_object(
    'success', true,
    'relationships_inserted', v_inserted,
    'relationships_already_existed', v_already_existed,
    'relationship_ids', v_relationship_ids
  );
END;
$$;

REVOKE ALL ON FUNCTION public.persist_lease_document_relationship_candidates(UUID, UUID, TEXT, JSONB) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.persist_lease_document_relationship_candidates(UUID, UUID, TEXT, JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_lease_document_relationship_decision(
  p_org_id UUID,
  p_operation TEXT,
  p_idempotency_key TEXT,
  p_relationship_id UUID,
  p_selected_target_package_document_id UUID DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_existing_decision RECORD;
  v_relationship RECORD;
  v_target RECORD;
  v_resulting_relationship_id UUID;
  v_new_status TEXT;
  v_new_validation TEXT;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF p_operation NOT IN ('confirm', 'reject', 'select_target', 'mark_requires_related_document', 'reopen', 'confirm_supersedes', 'waive_related_document_requirement') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;

  SELECT * INTO v_existing_decision FROM public.lease_document_relationship_reviewer_decisions
   WHERE org_id = p_org_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true,
      'idempotent_replay', true,
      'decision_id', v_existing_decision.id,
      'relationship_id', v_existing_decision.relationship_id,
      'resulting_relationship_id', v_existing_decision.resulting_relationship_id,
      'operation', v_existing_decision.operation
    );
  END IF;

  SELECT * INTO v_relationship FROM public.lease_document_relationships
   WHERE id = p_relationship_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RELATIONSHIP_NOT_FOUND');
  END IF;

  IF v_relationship.generation_id IS DISTINCT FROM (
    SELECT uf.active_generation_id
      FROM public.lease_package_documents lpd
      JOIN public.uploaded_files uf
        ON uf.id = lpd.uploaded_file_id
       AND uf.org_id = lpd.org_id
     WHERE lpd.id = v_relationship.source_package_document_id
       AND lpd.org_id = p_org_id
       AND lpd.package_id = v_relationship.package_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'STALE_GENERATION');
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
  v_resulting_relationship_id := p_relationship_id;

  IF p_operation IN ('confirm', 'confirm_supersedes', 'reject', 'mark_requires_related_document', 'waive_related_document_requirement') THEN
    IF p_operation = 'confirm_supersedes' AND v_relationship.relationship_type <> 'supersedes' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'NOT_SUPERSEDES_RELATIONSHIP');
    END IF;
    v_new_status := CASE
      WHEN p_operation IN ('confirm', 'confirm_supersedes', 'waive_related_document_requirement') THEN 'confirmed'
      WHEN p_operation = 'reject' THEN 'rejected'
      ELSE 'requires_related_document'
    END;
    v_new_validation := CASE WHEN v_new_status = 'confirmed' THEN 'valid' WHEN v_new_status = 'rejected' THEN 'invalid' ELSE 'needs_review' END;
    BEGIN
      UPDATE public.lease_document_relationships
         SET relationship_status = v_new_status,
             validation_status = v_new_validation,
             resolution_reason = p_reason
       WHERE id = p_relationship_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
    END;
  ELSIF p_operation = 'select_target' THEN
    IF p_selected_target_package_document_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_TARGET_REQUIRED');
    END IF;
    SELECT * INTO v_target FROM public.lease_package_documents
     WHERE id = p_selected_target_package_document_id
       AND org_id = p_org_id
       AND package_id = v_relationship.package_id
       AND id <> v_relationship.source_package_document_id
       FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'SELECTED_TARGET_NOT_IN_PACKAGE');
    END IF;
    BEGIN
      UPDATE public.lease_document_relationships
         SET relationship_status = 'superseded',
             validation_status = 'needs_review',
             resolution_reason = COALESCE(p_reason, 'reviewer_selected_target')
       WHERE id = p_relationship_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
    END;
    INSERT INTO public.lease_document_relationships (
      org_id, package_id, source_package_document_id, target_package_document_id,
      source_segment_id, target_segment_id, relationship_type, relationship_status,
      validation_status, relationship_key, confidence, producer_type, producer_name,
      producer_version, extraction_run_id, generation_id, evidence_claim_id,
      evidence_summary, resolution_reason
    ) VALUES (
      p_org_id, v_relationship.package_id, v_relationship.source_package_document_id, v_target.id,
      v_relationship.source_segment_id, v_target.full_file_segment_id,
      v_relationship.relationship_type, 'confirmed', 'valid',
      'reviewer:' || p_idempotency_key,
      v_relationship.confidence, 'reviewer', 'relationship-reviewer',
      v_relationship.producer_version, v_relationship.extraction_run_id,
      v_relationship.generation_id, v_relationship.evidence_claim_id,
      v_relationship.evidence_summary || jsonb_build_object('reviewer_selected_from_relationship_id', p_relationship_id),
      p_reason
    ) RETURNING id INTO v_resulting_relationship_id;
  ELSIF p_operation = 'reopen' THEN
    INSERT INTO public.lease_document_relationships (
      org_id, package_id, source_package_document_id, target_package_document_id,
      source_segment_id, target_segment_id, relationship_type, relationship_status,
      validation_status, relationship_key, confidence, producer_type, producer_name,
      producer_version, extraction_run_id, generation_id, evidence_claim_id,
      evidence_summary, resolution_reason
    ) VALUES (
      p_org_id, v_relationship.package_id, v_relationship.source_package_document_id, v_relationship.target_package_document_id,
      v_relationship.source_segment_id, v_relationship.target_segment_id,
      v_relationship.relationship_type, 'proposed', 'pending',
      'reviewer:' || p_idempotency_key,
      v_relationship.confidence, 'reviewer', 'relationship-reviewer',
      v_relationship.producer_version, v_relationship.extraction_run_id,
      v_relationship.generation_id, v_relationship.evidence_claim_id,
      v_relationship.evidence_summary || jsonb_build_object('reopened_from_relationship_id', p_relationship_id),
      p_reason
    ) RETURNING id INTO v_resulting_relationship_id;
  END IF;

  INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
  VALUES (
    p_org_id, 'lease_document_relationships', v_resulting_relationship_id::text, 'update',
    v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
    jsonb_build_object('operation', p_operation, 'resulting_relationship_id', v_resulting_relationship_id),
    jsonb_build_object('idempotency_key', p_idempotency_key, 'reason', p_reason)
  );

  INSERT INTO public.lease_document_relationship_reviewer_decisions (
    org_id, relationship_id, operation, resulting_relationship_id,
    idempotency_key, actor_user_id, actor_email, reason
  ) VALUES (
    p_org_id, p_relationship_id, p_operation, v_resulting_relationship_id,
    p_idempotency_key, v_actor_user_id, v_actor_email, p_reason
  );

  RETURN jsonb_build_object(
    'success', true,
    'operation', p_operation,
    'relationship_id', p_relationship_id,
    'resulting_relationship_id', v_resulting_relationship_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_lease_document_relationship_decision(UUID, TEXT, TEXT, UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_lease_document_relationship_decision(UUID, TEXT, TEXT, UUID, UUID, TEXT) TO authenticated, service_role;

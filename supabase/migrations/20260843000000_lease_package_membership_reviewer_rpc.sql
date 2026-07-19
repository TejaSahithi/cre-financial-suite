-- P3.3 — resolve_package_membership_decision: the single controlled RPC for
-- every reviewer-initiated package-membership operation (mirrors P2.3's
-- record_claim_review_decision precedent -- one RPC, operation-dispatched,
-- one transaction, one audit row -- rather than five separate RPCs).
--
-- Operations: confirm, reject, move_to_package, create_package_and_confirm,
-- reopen_ambiguous. Actor identity is derived from auth.uid() ONLY -- never
-- a caller-supplied id (the get_extraction_artifact_authorization fix,
-- reapplied). Idempotent via a caller-supplied p_idempotency_key, stored as
-- the resulting lease_package_membership_decisions row's decision_key --
-- replaying the same key returns the original outcome without redoing work.
--
-- 'reopen_ambiguous' does NOT resurrect the ambiguous row (P3.2's transition
-- graph has no ambiguous -> proposed edge, by design) -- it transitions the
-- old row to 'rejected' and inserts a FRESH 'proposed' membership row in the
-- same package, preserving the ambiguous row as immutable history.

CREATE OR REPLACE FUNCTION public.resolve_package_membership_decision(
  p_org_id UUID,
  p_operation TEXT,
  p_idempotency_key TEXT,
  p_membership_id UUID DEFAULT NULL,
  p_target_package_id UUID DEFAULT NULL,
  p_new_package_key TEXT DEFAULT NULL,
  p_new_package_lease_id UUID DEFAULT NULL,
  p_uploaded_file_id UUID DEFAULT NULL,
  p_extraction_run_id UUID DEFAULT NULL,
  p_generation_id UUID DEFAULT NULL,
  p_membership_role TEXT DEFAULT NULL,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email   TEXT;
  v_decision_key  TEXT;
  v_existing_decision RECORD;
  v_membership    RECORD;
  v_target_package RECORD;
  v_new_membership_id UUID;
  v_new_package_id UUID;
  v_decision_id UUID;
  v_decision_type TEXT;
  v_final_status TEXT;
  v_final_role TEXT;
BEGIN
  IF v_actor_user_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AUTHENTICATED');
  END IF;
  IF NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;
  IF p_operation NOT IN ('confirm', 'reject', 'move_to_package', 'create_package_and_confirm', 'reopen_ambiguous') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_OPERATION');
  END IF;

  v_decision_key := 'reviewer:' || p_idempotency_key;

  SELECT * INTO v_existing_decision FROM public.lease_package_membership_decisions
   WHERE org_id = p_org_id AND decision_key = v_decision_key;
  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'idempotent_replay', true,
      'membership_id', v_existing_decision.membership_id,
      'package_id', v_existing_decision.package_id,
      'decision', v_existing_decision.decision,
      'membership_status', v_existing_decision.membership_status
    );
  END IF;

  SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;

  -- ---------------------------------------------------------------------
  -- confirm / reject: transition an existing membership row in place.
  -- ---------------------------------------------------------------------
  IF p_operation IN ('confirm', 'reject') THEN
    IF p_membership_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_ID_REQUIRED');
    END IF;

    SELECT * INTO v_membership FROM public.lease_package_documents
     WHERE id = p_membership_id AND org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_NOT_FOUND');
    END IF;

    v_final_status := CASE WHEN p_operation = 'confirm' THEN 'confirmed' ELSE 'rejected' END;
    BEGIN
      UPDATE public.lease_package_documents SET membership_status = v_final_status WHERE id = p_membership_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
    END;

    v_new_membership_id := p_membership_id;
    v_new_package_id := v_membership.package_id;
    v_decision_type := CASE WHEN p_operation = 'confirm' THEN 'join_existing_package' ELSE 'propose_existing_package' END;
    v_final_role := v_membership.membership_role;

    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_package_documents', p_membership_id::text, 'update', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('membership_status', v_final_status), jsonb_build_object('operation', p_operation, 'reason', p_reason));

    INSERT INTO public.lease_package_membership_decisions (
      org_id, uploaded_file_id, extraction_run_id, generation_id, package_id, membership_id,
      decision, membership_role, membership_status, membership_source, reason_codes, decision_key
    ) VALUES (
      p_org_id, v_membership.uploaded_file_id, v_membership.extraction_run_id, v_membership.generation_id,
      v_new_package_id, v_new_membership_id, v_decision_type, v_final_role, v_final_status, 'reviewer',
      CASE WHEN p_reason IS NOT NULL THEN jsonb_build_array(p_reason) ELSE '[]'::jsonb END, v_decision_key
    ) RETURNING id INTO v_decision_id;

  -- ---------------------------------------------------------------------
  -- move_to_package: supersede the old membership, create a fresh proposed
  -- row in the target package.
  -- ---------------------------------------------------------------------
  ELSIF p_operation = 'move_to_package' THEN
    IF p_membership_id IS NULL OR p_target_package_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_AND_TARGET_PACKAGE_REQUIRED');
    END IF;

    SELECT * INTO v_membership FROM public.lease_package_documents
     WHERE id = p_membership_id AND org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_NOT_FOUND');
    END IF;

    SELECT * INTO v_target_package FROM public.lease_document_packages
     WHERE id = p_target_package_id AND org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'TARGET_PACKAGE_NOT_FOUND');
    END IF;

    BEGIN
      UPDATE public.lease_package_documents SET membership_status = 'superseded' WHERE id = p_membership_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
    END;

    v_final_role := COALESCE(p_membership_role, v_membership.membership_role);
    BEGIN
      INSERT INTO public.lease_package_documents (
        org_id, package_id, uploaded_file_id, extraction_run_id, generation_id,
        full_file_segment_id, canonical_profile_record_id, membership_role,
        membership_source, membership_key
      ) VALUES (
        p_org_id, p_target_package_id, v_membership.uploaded_file_id, v_membership.extraction_run_id, v_membership.generation_id,
        v_membership.full_file_segment_id, v_membership.canonical_profile_record_id, v_final_role,
        'reviewer', v_membership.membership_key || ':moved:' || gen_random_uuid()::text
      ) RETURNING id INTO v_new_membership_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MOVE_TARGET_REJECTED', 'detail', SQLERRM);
    END;

    v_new_package_id := p_target_package_id;
    v_decision_type := 'join_existing_package';
    v_final_status := 'proposed';

    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_package_documents', v_new_membership_id::text, 'update', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('moved_from_membership_id', p_membership_id, 'target_package_id', p_target_package_id), jsonb_build_object('operation', p_operation, 'reason', p_reason));

    INSERT INTO public.lease_package_membership_decisions (
      org_id, uploaded_file_id, extraction_run_id, generation_id, package_id, membership_id,
      decision, membership_role, membership_status, membership_source, reason_codes, decision_key
    ) VALUES (
      p_org_id, v_membership.uploaded_file_id, v_membership.extraction_run_id, v_membership.generation_id,
      v_new_package_id, v_new_membership_id, v_decision_type, v_final_role, v_final_status, 'reviewer',
      CASE WHEN p_reason IS NOT NULL THEN jsonb_build_array(p_reason) ELSE '[]'::jsonb END, v_decision_key
    ) RETURNING id INTO v_decision_id;

  -- ---------------------------------------------------------------------
  -- create_package_and_confirm: create a new package, add and confirm the
  -- membership in one transaction.
  -- ---------------------------------------------------------------------
  ELSIF p_operation = 'create_package_and_confirm' THEN
    IF p_uploaded_file_id IS NULL OR p_extraction_run_id IS NULL OR p_generation_id IS NULL OR p_membership_role IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FILE_RUN_GENERATION_ROLE_REQUIRED');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'FILE_NOT_FOUND_IN_ORG');
    END IF;

    INSERT INTO public.lease_document_packages (org_id, lease_id, package_key, created_by_type)
    VALUES (p_org_id, p_new_package_lease_id, COALESCE(NULLIF(p_new_package_key, ''), 'pkg:' || gen_random_uuid()::text), 'reviewer')
    ON CONFLICT (org_id, package_key) DO NOTHING
    RETURNING id INTO v_new_package_id;

    IF v_new_package_id IS NULL THEN
      SELECT id INTO v_new_package_id FROM public.lease_document_packages
       WHERE org_id = p_org_id AND package_key = COALESCE(NULLIF(p_new_package_key, ''), '');
      IF v_new_package_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_KEY_CONFLICT');
      END IF;
    END IF;

    BEGIN
      INSERT INTO public.lease_package_documents (
        org_id, package_id, uploaded_file_id, extraction_run_id, generation_id,
        membership_role, membership_source, membership_key, membership_status
      ) VALUES (
        p_org_id, v_new_package_id, p_uploaded_file_id, p_extraction_run_id, p_generation_id,
        p_membership_role, 'reviewer',
        p_org_id::text || ':' || v_new_package_id::text || ':' || p_uploaded_file_id::text || ':' || p_generation_id::text || ':' || p_membership_role,
        'confirmed'
      ) RETURNING id INTO v_new_membership_id;
    EXCEPTION WHEN OTHERS THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_CREATE_REJECTED', 'detail', SQLERRM);
    END;

    v_decision_type := 'create_package';
    v_final_status := 'confirmed';
    v_final_role := p_membership_role;

    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_document_packages', v_new_package_id::text, 'create', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('membership_id', v_new_membership_id), jsonb_build_object('operation', p_operation, 'reason', p_reason));

    INSERT INTO public.lease_package_membership_decisions (
      org_id, uploaded_file_id, extraction_run_id, generation_id, package_id, membership_id,
      decision, membership_role, membership_status, membership_source, reason_codes, decision_key
    ) VALUES (
      p_org_id, p_uploaded_file_id, p_extraction_run_id, p_generation_id,
      v_new_package_id, v_new_membership_id, v_decision_type, v_final_role, v_final_status, 'reviewer',
      CASE WHEN p_reason IS NOT NULL THEN jsonb_build_array(p_reason) ELSE '[]'::jsonb END, v_decision_key
    ) RETURNING id INTO v_decision_id;

  -- ---------------------------------------------------------------------
  -- reopen_ambiguous: reject the ambiguous row, insert a fresh proposed row
  -- in the SAME package -- never resurrects the old row (no ambiguous ->
  -- proposed edge exists in P3.2's transition graph, by design).
  -- ---------------------------------------------------------------------
  ELSIF p_operation = 'reopen_ambiguous' THEN
    IF p_membership_id IS NULL THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_ID_REQUIRED');
    END IF;

    SELECT * INTO v_membership FROM public.lease_package_documents
     WHERE id = p_membership_id AND org_id = p_org_id FOR UPDATE;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_NOT_FOUND');
    END IF;
    IF v_membership.membership_status <> 'ambiguous' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'NOT_AMBIGUOUS');
    END IF;

    UPDATE public.lease_package_documents SET membership_status = 'rejected' WHERE id = p_membership_id;

    v_final_role := COALESCE(p_membership_role, v_membership.membership_role);
    INSERT INTO public.lease_package_documents (
      org_id, package_id, uploaded_file_id, extraction_run_id, generation_id,
      full_file_segment_id, canonical_profile_record_id, membership_role,
      membership_source, membership_key
    ) VALUES (
      p_org_id, v_membership.package_id, v_membership.uploaded_file_id, v_membership.extraction_run_id, v_membership.generation_id,
      v_membership.full_file_segment_id, v_membership.canonical_profile_record_id, v_final_role,
      'reviewer', v_membership.membership_key || ':reopen:' || gen_random_uuid()::text
    ) RETURNING id INTO v_new_membership_id;

    v_new_package_id := v_membership.package_id;
    v_decision_type := 'propose_existing_package';
    v_final_status := 'proposed';

    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_package_documents', v_new_membership_id::text, 'update', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('reopened_from_membership_id', p_membership_id), jsonb_build_object('operation', p_operation, 'reason', p_reason));

    INSERT INTO public.lease_package_membership_decisions (
      org_id, uploaded_file_id, extraction_run_id, generation_id, package_id, membership_id,
      decision, membership_role, membership_status, membership_source, reason_codes, decision_key
    ) VALUES (
      p_org_id, v_membership.uploaded_file_id, v_membership.extraction_run_id, v_membership.generation_id,
      v_new_package_id, v_new_membership_id, v_decision_type, v_final_role, v_final_status, 'reviewer',
      CASE WHEN p_reason IS NOT NULL THEN jsonb_build_array(p_reason) ELSE '[]'::jsonb END, v_decision_key
    ) RETURNING id INTO v_decision_id;
  END IF;

  RETURN jsonb_build_object(
    'success', true, 'operation', p_operation, 'decision_id', v_decision_id,
    'membership_id', v_new_membership_id, 'package_id', v_new_package_id,
    'membership_status', v_final_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_package_membership_decision(UUID, TEXT, TEXT, UUID, UUID, TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_package_membership_decision(UUID, TEXT, TEXT, UUID, UUID, TEXT, UUID, UUID, UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

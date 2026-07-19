-- P3.2 — the 7 server-owned RPCs that are the sole write path into the
-- package graph. Same template as P1's 6 recorder RPCs / P2.3's claims
-- persistence RPCs: SECURITY DEFINER, fixed search_path, structured
-- {success, error_code} JSON returns, no raw exceptions surfaced for
-- expected conflicts, actor identity derived from auth.uid() only (never a
-- caller-supplied id).
--
-- Trust model: a reviewer-initiated call always has auth.uid() IS NOT NULL
-- (an authenticated Supabase session always carries a JWT 'sub' claim) and
-- is additionally checked against org membership. A pipeline/system call
-- runs as service_role, which has no JWT and so auth.uid() IS NULL --
-- service_role bypasses the org-membership/actor checks entirely, exactly
-- like every P1/P2 system-facing RPC. Any RPC that accepts a
-- system-attributed producer_type/membership_source (deterministic,
-- semantic, system, legacy_link) REJECTS that value when auth.uid() IS NOT
-- NULL, so an ordinary authenticated user can never claim a
-- system-attributed provenance for their own write -- only 'reviewer' is
-- reachable from an authenticated session.

-- ---------------------------------------------------------------------------
-- create_lease_document_package
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_lease_document_package(
  p_org_id UUID,
  p_lease_id UUID DEFAULT NULL,
  p_package_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_created_by_type TEXT;
  v_package_key TEXT;
  v_package_id UUID;
BEGIN
  IF v_actor_user_id IS NOT NULL THEN
    IF NOT public.is_member_of_org(p_org_id) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
    END IF;
    v_created_by_type := 'reviewer';
  ELSE
    v_created_by_type := 'system';
  END IF;

  IF p_lease_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leases WHERE id = p_lease_id AND org_id = p_org_id
  ) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'LEASE_NOT_FOUND_IN_ORG');
  END IF;

  v_package_key := COALESCE(NULLIF(p_package_key, ''), 'pkg:' || gen_random_uuid()::text);

  INSERT INTO public.lease_document_packages (org_id, lease_id, package_key, created_by_type)
  VALUES (p_org_id, p_lease_id, v_package_key, v_created_by_type)
  ON CONFLICT (org_id, package_key) DO NOTHING
  RETURNING id INTO v_package_id;

  IF v_package_id IS NULL THEN
    SELECT id INTO v_package_id FROM public.lease_document_packages WHERE org_id = p_org_id AND package_key = v_package_key;
    RETURN jsonb_build_object('success', true, 'package_id', v_package_id, 'created', false);
  END IF;

  RETURN jsonb_build_object('success', true, 'package_id', v_package_id, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.create_lease_document_package(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_lease_document_package(UUID, UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- add_document_to_lease_package
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.add_document_to_lease_package(
  p_org_id UUID,
  p_package_id UUID,
  p_uploaded_file_id UUID,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_membership_role TEXT,
  p_membership_source TEXT,
  p_full_file_segment_id UUID DEFAULT NULL,
  p_canonical_profile_record_id UUID DEFAULT NULL,
  p_confidence NUMERIC DEFAULT NULL,
  p_membership_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_membership_key TEXT;
  v_membership_id UUID;
BEGIN
  IF v_actor_user_id IS NOT NULL THEN
    IF NOT public.is_member_of_org(p_org_id) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
    END IF;
    IF p_membership_source <> 'reviewer' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATED_CALLER_MUST_USE_REVIEWER_SOURCE');
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.lease_document_packages WHERE id = p_package_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_NOT_FOUND_IN_ORG');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.uploaded_files WHERE id = p_uploaded_file_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'FILE_NOT_FOUND_IN_ORG');
  END IF;

  v_membership_key := COALESCE(
    NULLIF(p_membership_key, ''),
    p_org_id::text || ':' || p_package_id::text || ':' || p_uploaded_file_id::text || ':' || p_generation_id::text || ':' || p_membership_role
  );

  BEGIN
    INSERT INTO public.lease_package_documents (
      org_id, package_id, uploaded_file_id, extraction_run_id, generation_id,
      full_file_segment_id, canonical_profile_record_id, membership_role,
      membership_source, membership_key, confidence
    ) VALUES (
      p_org_id, p_package_id, p_uploaded_file_id, p_extraction_run_id, p_generation_id,
      p_full_file_segment_id, p_canonical_profile_record_id, p_membership_role,
      p_membership_source, v_membership_key, p_confidence
    )
    RETURNING id INTO v_membership_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_membership_id FROM public.lease_package_documents WHERE org_id = p_org_id AND membership_key = v_membership_key;
    RETURN jsonb_build_object('success', true, 'membership_id', v_membership_id, 'created', false);
  END;

  RETURN jsonb_build_object('success', true, 'membership_id', v_membership_id, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.add_document_to_lease_package(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, UUID, NUMERIC, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_document_to_lease_package(UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, UUID, UUID, NUMERIC, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- transition_package_document_membership
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_package_document_membership(
  p_org_id UUID,
  p_membership_id UUID,
  p_new_status TEXT,
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
  v_membership RECORD;
BEGIN
  IF v_actor_user_id IS NOT NULL AND NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  SELECT * INTO v_membership FROM public.lease_package_documents WHERE id = p_membership_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'MEMBERSHIP_NOT_FOUND');
  END IF;

  BEGIN
    UPDATE public.lease_package_documents SET membership_status = p_new_status WHERE id = p_membership_id;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
  END;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_package_documents', p_membership_id::text, 'update', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('membership_status', p_new_status), jsonb_build_object('reason', p_reason));
  END IF;

  RETURN jsonb_build_object('success', true, 'membership_id', p_membership_id, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_package_document_membership(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_package_document_membership(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- propose_lease_document_relationship
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.propose_lease_document_relationship(
  p_org_id UUID,
  p_package_id UUID,
  p_source_package_document_id UUID,
  p_relationship_type TEXT,
  p_producer_type TEXT,
  p_extraction_run_id UUID,
  p_generation_id UUID,
  p_target_package_document_id UUID DEFAULT NULL,
  p_extraction_stage_run_id UUID DEFAULT NULL,
  p_provider_invocation_id UUID DEFAULT NULL,
  p_evidence_claim_id UUID DEFAULT NULL,
  p_confidence NUMERIC DEFAULT NULL,
  p_effective_date DATE DEFAULT NULL,
  p_relationship_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_relationship_key TEXT;
  v_relationship_id UUID;
BEGIN
  IF v_actor_user_id IS NOT NULL THEN
    IF NOT public.is_member_of_org(p_org_id) THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
    END IF;
    IF p_producer_type <> 'reviewer' THEN
      RETURN jsonb_build_object('success', false, 'error_code', 'AUTHENTICATED_CALLER_MUST_USE_REVIEWER_PRODUCER');
    END IF;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.lease_document_packages WHERE id = p_package_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_NOT_FOUND_IN_ORG');
  END IF;

  v_relationship_key := COALESCE(
    NULLIF(p_relationship_key, ''),
    p_org_id::text || ':' || p_package_id::text || ':' || p_source_package_document_id::text || ':' ||
      COALESCE(p_target_package_document_id::text, 'none') || ':' || p_relationship_type
  );

  BEGIN
    INSERT INTO public.lease_document_relationships (
      org_id, package_id, source_package_document_id, target_package_document_id,
      relationship_type, relationship_key, effective_date, confidence,
      producer_type, extraction_run_id, extraction_stage_run_id, provider_invocation_id,
      generation_id, evidence_claim_id
    ) VALUES (
      p_org_id, p_package_id, p_source_package_document_id, p_target_package_document_id,
      p_relationship_type, v_relationship_key, p_effective_date, p_confidence,
      p_producer_type, p_extraction_run_id, p_extraction_stage_run_id, p_provider_invocation_id,
      p_generation_id, p_evidence_claim_id
    )
    RETURNING id INTO v_relationship_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_relationship_id FROM public.lease_document_relationships WHERE org_id = p_org_id AND relationship_key = v_relationship_key;
    RETURN jsonb_build_object('success', true, 'relationship_id', v_relationship_id, 'created', false);
  END;

  RETURN jsonb_build_object('success', true, 'relationship_id', v_relationship_id, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.propose_lease_document_relationship(UUID, UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, NUMERIC, DATE, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.propose_lease_document_relationship(UUID, UUID, UUID, TEXT, TEXT, UUID, UUID, UUID, UUID, UUID, UUID, NUMERIC, DATE, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- transition_lease_document_relationship
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.transition_lease_document_relationship(
  p_org_id UUID,
  p_relationship_id UUID,
  p_new_status TEXT,
  p_validation_status TEXT DEFAULT NULL,
  p_resolution_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_relationship RECORD;
BEGIN
  IF v_actor_user_id IS NOT NULL AND NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  SELECT * INTO v_relationship FROM public.lease_document_relationships WHERE id = p_relationship_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RELATIONSHIP_NOT_FOUND');
  END IF;

  BEGIN
    UPDATE public.lease_document_relationships
       SET relationship_status = p_new_status,
           validation_status = COALESCE(p_validation_status, validation_status),
           resolution_reason = COALESCE(p_resolution_reason, resolution_reason)
     WHERE id = p_relationship_id;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
  END;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_document_relationships', p_relationship_id::text, 'update', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('relationship_status', p_new_status, 'validation_status', p_validation_status), jsonb_build_object('resolution_reason', p_resolution_reason));
  END IF;

  RETURN jsonb_build_object('success', true, 'relationship_id', p_relationship_id, 'status', p_new_status);
END;
$$;

REVOKE ALL ON FUNCTION public.transition_lease_document_relationship(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.transition_lease_document_relationship(UUID, UUID, TEXT, TEXT, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- record_related_document_requirement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_related_document_requirement(
  p_org_id UUID,
  p_package_id UUID,
  p_requesting_package_document_id UUID,
  p_requirement_type TEXT,
  p_reason_code TEXT,
  p_required_profile_key TEXT DEFAULT NULL,
  p_referenced_document_date DATE DEFAULT NULL,
  p_referenced_party_names JSONB DEFAULT '[]'::jsonb,
  p_referenced_identifier TEXT DEFAULT NULL,
  p_evidence_claim_id UUID DEFAULT NULL,
  p_requirement_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_requirement_key TEXT;
  v_requirement_id UUID;
BEGIN
  IF v_actor_user_id IS NOT NULL AND NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.lease_document_packages WHERE id = p_package_id AND org_id = p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'PACKAGE_NOT_FOUND_IN_ORG');
  END IF;

  v_requirement_key := COALESCE(
    NULLIF(p_requirement_key, ''),
    p_org_id::text || ':' || p_package_id::text || ':' || p_requesting_package_document_id::text || ':' || p_requirement_type
  );

  BEGIN
    INSERT INTO public.lease_related_document_requirements (
      org_id, package_id, requesting_package_document_id, requirement_type, reason_code,
      required_profile_key, referenced_document_date, referenced_party_names,
      referenced_identifier, evidence_claim_id, requirement_key
    ) VALUES (
      p_org_id, p_package_id, p_requesting_package_document_id, p_requirement_type, p_reason_code,
      p_required_profile_key, p_referenced_document_date, COALESCE(p_referenced_party_names, '[]'::jsonb),
      p_referenced_identifier, p_evidence_claim_id, v_requirement_key
    )
    RETURNING id INTO v_requirement_id;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_requirement_id FROM public.lease_related_document_requirements WHERE org_id = p_org_id AND requirement_key = v_requirement_key;
    RETURN jsonb_build_object('success', true, 'requirement_id', v_requirement_id, 'created', false);
  END;

  RETURN jsonb_build_object('success', true, 'requirement_id', v_requirement_id, 'created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.record_related_document_requirement(UUID, UUID, UUID, TEXT, TEXT, TEXT, DATE, JSONB, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_related_document_requirement(UUID, UUID, UUID, TEXT, TEXT, TEXT, DATE, JSONB, TEXT, UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- resolve_related_document_requirement
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_related_document_requirement(
  p_org_id UUID,
  p_requirement_id UUID,
  p_resolution TEXT,
  p_resolved_by_package_document_id UUID DEFAULT NULL,
  p_reason_code TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_actor_user_id UUID := auth.uid();
  v_actor_email TEXT;
  v_requirement RECORD;
BEGIN
  IF v_actor_user_id IS NOT NULL AND NOT public.is_member_of_org(p_org_id) THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'NOT_ORG_MEMBER');
  END IF;

  IF p_resolution NOT IN ('resolved', 'waived', 'rejected', 'ambiguous') THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'INVALID_RESOLUTION');
  END IF;

  SELECT * INTO v_requirement FROM public.lease_related_document_requirements WHERE id = p_requirement_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'REQUIREMENT_NOT_FOUND');
  END IF;

  IF p_resolution = 'resolved' AND p_resolved_by_package_document_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'RESOLVED_REQUIRES_PACKAGE_DOCUMENT');
  END IF;

  BEGIN
    UPDATE public.lease_related_document_requirements
       SET requirement_status = p_resolution,
           resolved_at = CASE WHEN p_resolution IN ('resolved', 'waived') THEN now() ELSE NULL END,
           resolved_by_package_document_id = CASE WHEN p_resolution = 'resolved' THEN p_resolved_by_package_document_id ELSE NULL END,
           reason_code = COALESCE(p_reason_code, reason_code)
     WHERE id = p_requirement_id;
  EXCEPTION WHEN OTHERS THEN
    RETURN jsonb_build_object('success', false, 'error_code', 'ILLEGAL_TRANSITION', 'detail', SQLERRM);
  END;

  IF v_actor_user_id IS NOT NULL THEN
    SELECT email INTO v_actor_email FROM auth.users WHERE id = v_actor_user_id;
    INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, actor_user_id, actor_email, actor_role, severity, source, after, metadata)
    VALUES (p_org_id, 'lease_related_document_requirements', p_requirement_id::text, 'update', v_actor_user_id, v_actor_email, 'reviewer', 'info', 'edge_function',
            jsonb_build_object('requirement_status', p_resolution), jsonb_build_object('reason_code', p_reason_code));
  END IF;

  RETURN jsonb_build_object('success', true, 'requirement_id', p_requirement_id, 'status', p_resolution);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_related_document_requirement(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_related_document_requirement(UUID, UUID, TEXT, UUID, TEXT) TO authenticated, service_role;

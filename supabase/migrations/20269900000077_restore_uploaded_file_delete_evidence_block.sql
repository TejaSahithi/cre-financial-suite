-- Restore fail-closed upload deletion semantics for files already consumed as
-- lease/document/financial evidence. Pipeline job rows remain non-blocking and
-- cascade normally; authoritative downstream evidence must force the operator
-- through the owning workflow instead of silently deleting source material.

CREATE OR REPLACE FUNCTION public.delete_uploaded_file_workflow(
  p_org_id UUID,
  p_file_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_file public.uploaded_files%ROWTYPE;
  v_blocked BOOLEAN := FALSE;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_file_id IS NULL THEN
    RAISE EXCEPTION 'file_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.memberships
     WHERE user_id = p_actor_user_id
       AND (role = 'super_admin' OR (role = 'org_admin' AND org_id = p_org_id))
  ) THEN
    RAISE EXCEPTION 'Only organization admins can delete uploaded files';
  END IF;

  SELECT * INTO v_file
    FROM public.uploaded_files
   WHERE id = p_file_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.leases l
     WHERE l.org_id = p_org_id
       AND (l.source_file_id = p_file_id OR l.extraction_data->>'source_file_id' = p_file_id::TEXT)
    UNION ALL
    SELECT 1 FROM public.lease_amendments la
     WHERE la.org_id = p_org_id AND la.source_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_assignments las
     WHERE las.org_id = p_org_id AND las.source_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.compute_runs cr
     WHERE cr.org_id = p_org_id AND cr.source_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.document_links dl
     WHERE dl.org_id = p_org_id AND dl.file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.extraction_runs er
     WHERE er.org_id = p_org_id AND er.uploaded_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_package_documents lpd
     WHERE lpd.org_id = p_org_id AND lpd.uploaded_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_document_segments lds
     WHERE lds.org_id = p_org_id AND lds.uploaded_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_document_profile_records ldpr
     WHERE ldpr.org_id = p_org_id AND ldpr.uploaded_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_claims lc
     WHERE lc.org_id = p_org_id AND lc.uploaded_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_claim_evidence lce
     WHERE lce.org_id = p_org_id AND lce.uploaded_file_id = p_file_id
  ) INTO v_blocked;

  IF v_blocked THEN
    RAISE EXCEPTION 'This upload is already linked to lease evidence and cannot be deleted.';
  END IF;

  DELETE FROM public.uploaded_files
   WHERE id = p_file_id
     AND org_id = p_org_id;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_file.property_id,
    'UploadedFile',
    p_file_id::TEXT,
    'uploaded_file_deleted',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_file),
    NULL,
    jsonb_build_object(
      'file_name', v_file.file_name,
      'module_type', v_file.module_type,
      'status', v_file.status
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'deleted_id', p_file_id,
    'deleted_count', 1
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_uploaded_file_workflow(
  UUID, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.delete_uploaded_file_workflow(
  UUID, UUID, UUID, TEXT
) TO service_role;

-- Migration: 20260868000000_fix_delete_uploaded_file_dependencies.sql
-- Description: Re-define delete_uploaded_file_workflow to clean up all new enterprise restrict-delete child records before deleting the uploaded_files row.

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

  -- Re-derive the same authorization bar as the current
  -- uploaded_files_delete RLS policy (org-admin/super-admin only), not the
  -- broader can_write_org_data used by insert/update on this table. Checked
  -- against the explicit actor parameter, not auth.uid() (see header note).
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships
     WHERE user_id = p_actor_user_id
       AND (role = 'super_admin' OR (role = 'org_admin' AND org_id = p_org_id))
  ) THEN
    RAISE EXCEPTION 'Only organization admins can delete uploaded files';
  END IF;

  -- Lock the row before validating/deleting so a concurrent writer can't
  -- slip in between the existence check and the delete.
  SELECT *
    INTO v_file
    FROM public.uploaded_files
   WHERE id = p_file_id
     AND org_id = p_org_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Uploaded file not found for this organization';
  END IF;

  -- Clean up all restrict-delete dependencies added in later enterprise migrations
  DELETE FROM public.lease_package_documents WHERE uploaded_file_id = p_file_id AND org_id = p_org_id;
  DELETE FROM public.lease_document_segments WHERE uploaded_file_id = p_file_id AND org_id = p_org_id;
  DELETE FROM public.lease_document_profile_records WHERE uploaded_file_id = p_file_id AND org_id = p_org_id;
  DELETE FROM public.lease_claims WHERE uploaded_file_id = p_file_id AND org_id = p_org_id;
  DELETE FROM public.extraction_runs WHERE uploaded_file_id = p_file_id AND org_id = p_org_id;

  -- Now delete the file row itself
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

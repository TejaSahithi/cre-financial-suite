-- Enterprise hardening Phase HARD-2: server-own uploaded_files delete.
--
-- LeaseUpload.jsx's handleDeleteUpload() currently issues a direct
-- supabase.from("uploaded_files").delete().eq("id", fileId) under the
-- caller's own RLS session -- no org-boundary re-check beyond RLS, no
-- audit row at all. This migration replaces it with a narrow, single-row
-- delete workflow following the same shape as delete_expenses_workflow
-- (Phase 6X-4).
--
-- Investigation findings (read directly from the live schema/code, not
-- assumed):
--
--   * Current behavior deletes ONLY the uploaded_files row. No Supabase
--     Storage object deletion happens today (confirmed: no storage_path/
--     storage_bucket column exists on uploaded_files at all -- file_url is
--     a plain text column, not a storage-API reference the app code ever
--     calls .storage.remove() against for this action). This RPC preserves
--     that exact (non-)behavior -- it does not touch Storage, avoiding the
--     "delete DB row but leave/lose the physical object inconsistently"
--     class of risk entirely, since that risk doesn't exist in current
--     behavior to begin with.
--
--   * Dependent-record behavior, confirmed via direct FK inspection
--     (\d uploaded_files against the live local schema):
--       - pipeline_jobs.uploaded_file_id -> uploaded_files(id)
--         ON DELETE CASCADE
--       - pipeline_logs.file_id -> uploaded_files(id) ON DELETE CASCADE
--       - document_links.file_id -> uploaded_files(id) ON DELETE CASCADE
--       - leases.source_file_id -> uploaded_files(id) ON DELETE SET NULL
--       - lease_amendments.source_file_id,
--         lease_assignments.source_file_id,
--         compute_runs.source_file_id -> ON DELETE SET NULL
--       - uploaded_files.parent_file_id (self) -> ON DELETE SET NULL
--     All of this is enforced by the FK constraints themselves, not
--     application code -- Postgres applies these cascades/nulls
--     identically regardless of which code path issues the DELETE. This
--     RPC does not need to (and does not) manually touch any of these
--     tables.
--
--   * LeaseUpload.jsx's own DeleteConfirmDialog copy explicitly documents
--     current product semantics: "This removes the uploaded file record.
--     Any downstream lease draft created from it will remain -- delete it
--     separately from the Leases list if needed." This is a deliberate,
--     already-shipped product decision (matching the schema's ON DELETE
--     SET NULL choice for leases.source_file_id, not RESTRICT) -- deletion
--     is not and has never been blocked by lease linkage, approval status,
--     or completed extraction/review data. No new blocking rule is added
--     here for approved-lease-linked files; doing so would be a behavior
--     change beyond "server-own the same action," not implied by
--     investigation proving current behavior unsafe. Flagged in the phase
--     report for the user to override if this decision should change.
--
--   * Current RLS (uploaded_files_delete: USING (is_org_admin(org_id)))
--     is stricter than the insert/update policies on this table
--     (can_write_org_data, which additionally allows manager/editor/
--     finance/property_manager roles) -- delete is org-admin/super-admin
--     only today. This RPC preserves that exact bar by checking the
--     caller's membership role directly against the explicit
--     p_actor_user_id parameter -- NOT via is_org_admin(p_org_id)/
--     auth.uid(), which would always evaluate against a NULL/absent
--     session and reject every caller: this RPC is invoked from the edge
--     function via the service-role client (matching every other RPC in
--     this codebase, confirmed by reading save_cam_profile/
--     review_expense_classification's actual bodies -- none of them use
--     auth.uid()-based checks internally; they rely on the edge function's
--     assertPageAccess for the coarse gate and validate the explicit actor
--     parameter for anything role-specific). Caught via a real failing
--     test during local verification, not assumed.
--
--   * Idempotency: a raw .delete().eq("id", fileId) against a
--     missing/already-deleted id silently "succeeds" (zero rows affected,
--     no error) under Postgrest -- but every other delete/update RPC
--     introduced this session (delete_expenses_workflow,
--     update_expense_details, manage_lease_critical_date, etc.) treats an
--     unknown id as an explicit error rather than a silent no-op, closing
--     a latent gap rather than preserving a misleading "Upload deleted"
--     success toast for an action that did nothing. Matching that
--     established, session-wide precedent here: unknown/cross-org file_id
--     is rejected with a clear error.

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

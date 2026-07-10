-- Enterprise hardening Phase HARD-2C: uploaded_files delete protection
-- refinement.
--
-- HARD-2 (migration 20260810000000, already applied -- NOT edited here, per
-- explicit instruction) server-owned the uploaded_files delete action but
-- deliberately preserved current permissive semantics (deletion always
-- allowed for org admins, regardless of lease linkage), matching the
-- product's pre-existing UI copy and schema design (ON DELETE SET NULL,
-- not RESTRICT). This phase changes that decision: before promoting the
-- HARD-2 frontend to Production, deletion is now blocked for any upload
-- already consumed as downstream evidence -- "unconsumed/mistaken uploads"
-- only.
--
-- Schema investigation (fresh query against information_schema, not
-- assumed): every real FK referencing uploaded_files(id):
--   leases.source_file_id             -> SET NULL
--   lease_amendments.source_file_id   -> SET NULL
--   lease_assignments.source_file_id  -> SET NULL
--   compute_runs.source_file_id       -> SET NULL
--   document_links.file_id            -> CASCADE
--   pipeline_jobs.uploaded_file_id    -> CASCADE
--   pipeline_logs.file_id             -> CASCADE
--   uploaded_files.parent_file_id     -> SET NULL (self)
--
-- Blocking set chosen (5 checks): leases, lease_amendments,
-- lease_assignments, compute_runs (all four named explicitly in scope) plus
-- document_links -- confirmed via grep as a real, live, actively-populated
-- generic file-to-entity linking table (Documents.jsx inserts a row on
-- upload; entity_type spans lease/property/expense_bucket/expense_line/
-- budget_line/cam_reconciliation/revenue_line), not disposable internal
-- state. Its ON DELETE CASCADE rule reflects "don't orphan the link row,"
-- not "this file was never consumed" -- the opposite signal from the
-- SET NULL group, but the same underlying meaning (real downstream
-- attachment exists).
--
-- Also checks leases.extraction_data->>'source_file_id' alongside the typed
-- leases.source_file_id column: confirmed via direct grep of the frontend
-- (LeaseReview.jsx, SourceFileLink.jsx, ExtractionDebugPanel.jsx,
-- dynamicFields.js) that this exact JSON key is used as a live fallback
-- whenever the typed column is null (`lease.source_file_id ??
-- lease.extraction_data?.source_file_id`) -- a single, well-defined,
-- unambiguous key path directly parallel to the typed column, not a
-- speculative deep-scan.
--
-- Explicitly NOT blocking, with reasoning:
--   * pipeline_jobs / pipeline_logs completed/success state -- these are
--     internal processing-pipeline bookkeeping (parse/normalize/
--     review_draft/rule_extraction stages), already ON DELETE CASCADE,
--     and "completed" only means extraction succeeded, not that a lease or
--     financial record was ever created from the file. Blocking on this
--     would defeat the phase's own stated goal: a file that was uploaded,
--     fully parsed, and then recognized as the wrong file (never turned
--     into a lease) is exactly the "mistaken upload" this workflow must
--     still allow deleting.
--   * uploaded_files.parent_file_id (self-reference) -- internal pipeline
--     lineage tracking between a re-extraction and its predecessor file,
--     not evidence consumption by a downstream financial/legal record.
--   * Deep JSONB evidence-field scanning (searching every field's
--     evidence/source_page/source_text annotations across all leases for
--     any mention of this file's id or name) -- flagged, not implemented,
--     per the explicit escape hatch: no schema/index exists for this, the
--     semantics of a field merely "mentioning" a file during extraction
--     (vs. being formally linked as its source) are genuinely unclear, and
--     a full per-lease JSONB scan on every delete call would be slow and
--     fragile. If this is later judged necessary, it should be its own
--     deliberately-scoped follow-up, not folded in here.
--
-- Audit behavior: the consumption check runs strictly before the DELETE and
-- audit_logs INSERT statements, inside the same function invocation/
-- transaction as the row lock -- a blocked delete raises before either
-- statement executes, so it produces zero audit rows and zero uploaded_files
-- changes, matching the explicit requirement.

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
  v_is_linked BOOLEAN;
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

  -- Same authorization bar as HARD-2 (org-admin/super-admin only, checked
  -- against the explicit actor parameter, not auth.uid()). Unchanged here.
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

  -- New in HARD-2C: block deletion if this file has been consumed as
  -- downstream source evidence. See header note for exactly which
  -- tables/paths are checked and why.
  SELECT EXISTS (
    SELECT 1 FROM public.leases
     WHERE org_id = p_org_id
       AND (source_file_id = p_file_id OR extraction_data->>'source_file_id' = p_file_id::text)
    UNION ALL
    SELECT 1 FROM public.lease_amendments
     WHERE org_id = p_org_id AND source_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.lease_assignments
     WHERE org_id = p_org_id AND source_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.compute_runs
     WHERE org_id = p_org_id AND source_file_id = p_file_id
    UNION ALL
    SELECT 1 FROM public.document_links
     WHERE org_id = p_org_id AND file_id = p_file_id
  ) INTO v_is_linked;

  IF v_is_linked THEN
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

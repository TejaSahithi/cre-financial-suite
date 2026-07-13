-- Upload confirmation lifecycle.
--
-- Today, upload-handler stores the file and inserts a durable uploaded_files
-- row at status='uploaded' in one step, and the frontend immediately
-- fire-and-forgets ingest-file right after -- there is no confirmation gate
-- between "file stored" and "extraction starts".
--
-- Design decision (confirmed with the user before implementation): reuse the
-- existing uploaded_files row as the "session" rather than introducing a
-- separate upload_sessions table or a temp storage path. The row already
-- durably and safely represents a stored file the moment upload-handler
-- returns; a new nullable confirmed_at column is sufficient to distinguish
-- "awaiting confirmation" (NULL) from "confirmed" (set). No storage move is
-- needed since there was never a separate temp location.
--
-- Three additive changes, all backward compatible with every existing row
-- (confirmed_at/cancel_requested_at default NULL; 'cancelled' is a new value
-- appended to an existing CHECK list, not a replacement):
--   1. uploaded_files.confirmed_at -- awaiting-confirmation marker.
--   2. pipeline_jobs.cancel_requested_at -- soft-cancel flag the worker polls
--      before each stage, mirroring how pipeline_jobs.status already uses
--      'cancelled' for job supersession (ingest-file's re-extract path), now
--      extended to a genuine user-initiated cancel.
--   3. 'cancelled' added to uploaded_files_status_check + a matching edge in
--      every non-terminal ALLOWED_TRANSITIONS entry in
--      _shared/pipeline-status.ts (code change, not part of this migration),
--      mirroring exactly how 'failed' is already modeled as reachable from
--      any active state.
--
-- Plus one new SECURITY DEFINER RPC, delete_unconfirmed_upload, following the
-- exact same pattern as delete_uploaded_file_workflow (20260810000000) --
-- RLS already blocks all client-side deletes of uploaded_files
-- (uploaded_files_delete USING (false), 20260812000000), so hard-deleting a
-- cancelled-before-confirmation row must go through a service-role RPC. The
-- guard here is deliberately simpler than delete_uploaded_file_workflow's:
-- an unconfirmed row cannot yet be linked to a lease/compute_run (extraction
-- never started), so there is no dependent-record check to perform. The
-- authorization bar matches can_write_org_data's role list (super_admin,
-- org_admin, manager, editor) -- the same bar as inserting/updating this row
-- in the first place -- rather than delete_uploaded_file_workflow's stricter
-- org-admin-only bar, since cancelling one's own in-progress upload draft is
-- much closer in kind to "undo my own edit" than to "delete a finalized
-- organizational record".

ALTER TABLE public.uploaded_files
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ NULL;

ALTER TABLE public.pipeline_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ NULL;

DO $$
BEGIN
  ALTER TABLE public.uploaded_files
    DROP CONSTRAINT IF EXISTS uploaded_files_status_check;
  ALTER TABLE public.uploaded_files
    ADD CONSTRAINT uploaded_files_status_check
    CHECK (status IN (
      'uploaded',
      'parsing',
      'parsed',
      'pdf_parsed',
      'validating',
      'validated',
      'review_required',
      'approved',
      'storing',
      'stored',
      'computing',
      'completed',
      'failed',
      'cancelled'
    ));
END $$;

CREATE OR REPLACE FUNCTION public.delete_unconfirmed_upload(
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

  -- Same authorization bar as can_write_org_data (the insert/update policy
  -- for this table), checked against the explicit actor parameter rather
  -- than auth.uid() -- this RPC is invoked from the edge function via the
  -- service-role client, which has no session (see delete_uploaded_file_
  -- workflow's header note for the established reasoning on this codebase).
  IF NOT EXISTS (
    SELECT 1 FROM public.memberships
     WHERE user_id = p_actor_user_id
       AND (role = 'super_admin' OR (org_id = p_org_id AND role IN ('org_admin', 'manager', 'editor')))
  ) THEN
    RAISE EXCEPTION 'Not authorized to cancel this upload';
  END IF;

  -- Lock the row before validating/deleting so a concurrent second Cancel
  -- click (or a race with Proceed) can't slip in between the check and the
  -- delete. Idempotent by design: a second call for an already-deleted or
  -- already-confirmed file_id simply finds no matching row and returns
  -- deleted_count=0 rather than erroring -- the caller treats that as "the
  -- desired end state (no unconfirmed row) is already true".
  SELECT *
    INTO v_file
    FROM public.uploaded_files
   WHERE id = p_file_id
     AND org_id = p_org_id
     AND confirmed_at IS NULL
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'deleted_id', p_file_id,
      'deleted_count', 0,
      'reason', 'not_found_or_already_confirmed'
    );
  END IF;

  DELETE FROM public.uploaded_files
   WHERE id = p_file_id
     AND org_id = p_org_id
     AND confirmed_at IS NULL;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_file.property_id,
    'UploadedFile',
    p_file_id::TEXT,
    'upload_cancelled_before_confirmation',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_file),
    NULL,
    jsonb_build_object(
      'file_name', v_file.file_name,
      'module_type', v_file.module_type,
      'file_url', v_file.file_url
    ),
    v_now
  );

  RETURN jsonb_build_object(
    'deleted_id', p_file_id,
    'deleted_count', 1,
    'file_url', v_file.file_url,
    'file_name', v_file.file_name
  );
END;
$$;

REVOKE ALL ON FUNCTION public.delete_unconfirmed_upload(
  UUID, UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.delete_unconfirmed_upload(
  UUID, UUID, UUID, TEXT
) TO service_role;

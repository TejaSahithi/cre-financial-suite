-- Enterprise hardening Phase 6D-5: reject_lease_abstract.
--
-- Moves leaseAbstractService.js's rejectLeaseAbstract (the "Reject Document"
-- action in LeaseReview.jsx, handleRejectDocument) behind a server-owned,
-- audited, transactional RPC. Today this writes directly via
-- updateLeaseStripMissing with zero audit logging and zero permission
-- check.
--
-- Exact fields touched, unchanged from the current client behavior:
--   status = 'rejected'
--   abstract_status = 'rejected'
--   extraction_data.rejection = { reason, rejected_at, rejected_by }
--     (every other extraction_data key preserved, matching the current
--     client's spread-merge)
-- rejected_by is a free-text display value (the client passes
-- lease.signed_by, not necessarily the acting user's own identity) --
-- matches manage_lease_critical_date's completed_by precedent. The RPC's
-- own audit row separately captures the real actor via
-- p_actor_user_id/p_actor_email.
--
-- Approved-lease guard: the old client code had NO check at all -- a
-- rejection could silently overwrite an already-approved lease's status.
-- This RPC deliberately rejects that (409), consistent with the same
-- "approved is locked unless reworked" guarantee already introduced in
-- 20260714000000/20260715000000/20260716000000. There is no formal
-- reopen/rework state in this codebase today, so blocking exactly
-- abstract_status='approved' is sufficient -- an intentional new
-- guarantee, not a preserved behavior (flagged in the phase report).
--
-- Idempotency: no *_workflow_runs tracking table is used here. Rejection
-- is a single, direct state transition on one row with no
-- duplicate-side-effect risk across retries (re-calling it just re-applies
-- the same status/extraction_data.rejection fields) -- unlike
-- approve_lease_workflow/send_expense_classification_to_cam_workflow,
-- which need idempotency-key tracking because they trigger separate
-- downstream side effects (rent schedule generation, CAM webhook sends)
-- that must never double-fire. Adding a workflow_run table here would
-- balloon scope for no corresponding benefit, matching the precedent
-- already set by update_lease_extraction_field/save_lease_review_draft/
-- manage_lease_critical_date (none of which use one either).
--
-- Reuses the existing generic app.skip_lease_audit_trigger GUC (see
-- 20260712000000_lease_audit_trigger_reconciliation.sql) so
-- fn_on_lease_changed does not write a duplicate audit row for this RPC's
-- UPDATE public.leases.
--
-- No JSONB patch parameter exists on this RPC at all (unlike
-- update_lease_extraction_field/manage_lease_critical_date) -- the fields
-- touched are fixed and few, so there is no "arbitrary column patch"
-- surface to whitelist-check in the first place.

CREATE OR REPLACE FUNCTION public.reject_lease_abstract(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT,
  p_rejected_by TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_updated_lease public.leases%ROWTYPE;
  v_next_extraction JSONB;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'reason is required';
  END IF;

  SELECT *
    INTO v_lease
    FROM public.leases
   WHERE id = p_lease_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  -- Approved/locked guard -- see migration header. No formal reopen/rework
  -- state exists in this codebase today, so blocking exactly this value is
  -- sufficient.
  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RAISE EXCEPTION 'Lease abstract is approved and locked; it cannot be rejected without a formal reopen';
  END IF;

  v_next_extraction := jsonb_set(
    COALESCE(v_lease.extraction_data, '{}'::jsonb),
    ARRAY['rejection'],
    jsonb_build_object(
      'reason', p_reason,
      'rejected_at', v_now,
      'rejected_by', p_rejected_by
    ),
    true
  );

  -- Skip fn_on_lease_changed's own audit_logs insert -- this RPC writes its
  -- own canonical row below in the same transaction. Transaction-local
  -- (SET LOCAL semantics): reverts automatically at COMMIT/ROLLBACK.
  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET status = 'rejected',
         abstract_status = 'rejected',
         extraction_data = v_next_extraction,
         updated_at = v_now
   WHERE id = p_lease_id
     AND org_id = p_org_id
  RETURNING * INTO v_updated_lease;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_updated_lease.property_id,
    'Lease',
    p_lease_id::TEXT,
    'lease_abstract_rejected',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    to_jsonb(v_updated_lease),
    jsonb_build_object(
      'reason', p_reason,
      'rejected_by', p_rejected_by,
      'prior_status', v_lease.status,
      'prior_abstract_status', v_lease.abstract_status
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'lease_id', v_updated_lease.id,
    'property_id', v_updated_lease.property_id,
    'status', v_updated_lease.status,
    'abstract_status', v_updated_lease.abstract_status,
    'extraction_data', v_updated_lease.extraction_data,
    'updated_at', v_updated_lease.updated_at,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by reject-lease-abstract's assertPageAccess() call, so EXECUTE must be
-- restricted to service_role only (matching every other RPC introduced
-- this hardening pass).
REVOKE ALL ON FUNCTION public.reject_lease_abstract(
  UUID, UUID, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reject_lease_abstract(
  UUID, UUID, UUID, TEXT, TEXT, TEXT
) TO service_role;

-- Enterprise hardening Phase 6D-3: save_lease_review_draft.
--
-- Moves the whole-field_reviews-map draft save (leaseAbstractService.js's
-- saveAbstractDraft) behind a server-owned, audited, transactional RPC.
-- saveAbstractDraft is called by handleSaveDraft ("Save Review Draft"
-- button), persistFieldAction (Accept/Reject/N-A/Needs-Legal/Manual-Required
-- buttons), handleResetField ("Reset" control), and onSaveOverrideReason
-- (evidence-override reason set/clear) in src/pages/LeaseReview.jsx --
-- migrating saveAbstractDraft's internal write covers all four call sites
-- in one shot without touching their per-field decision logic (which stays
-- entirely client-side: computing the next fieldReviews map, action naming
-- for logAudit, optimistic local state).
--
-- Explicitly OUT of scope (per Phase 6D-3 scope): rejectLeaseAbstract (an
-- approval-flow verdict -- sets status='rejected', a different action
-- entirely, not a draft save) and approveLeaseAbstract (already dead code,
-- superseded by the approve_lease_workflow RPC) are untouched. Critical
-- dates, re-extraction/apply-latest-extraction whole-object rebuilds, and
-- the approval flow itself are untouched.
--
-- Write shape: replaces exactly extraction_data.field_reviews (the whole
-- map, matching saveAbstractDraft's exact current behavior -- it has always
-- fully replaced this one sub-key, never merged it) while preserving every
-- other extraction_data key untouched. Also sets abstract_status.
--
-- Approved-lease guard: saveAbstractDraft's current behavior is "keep
-- abstract_status='approved' if already approved, else set
-- 'pending_review'" -- i.e. today a draft save on an already-approved lease
-- silently succeeds (the FieldDetailDrawer's Accept/Reject/reset controls
-- are not gated by abstract_status client-side either). This RPC
-- deliberately tightens that: it rejects the write outright once
-- abstract_status='approved', matching the same guard already applied to
-- update_lease_extraction_field (20260714000000) -- a send-back/rejection
-- already transitions abstract_status away from 'approved', so blocking
-- exactly that value is sufficient ("unless an existing explicit rework
-- state allows it": every non-approved state already allows it). This is an
-- intentional new guarantee, not a preserved behavior -- flagged in the
-- phase report.
--
-- Locking: FOR UPDATE row lock is the only concurrency guarantee, same
-- rationale as 20260714000000 -- no version/hash column exists on `leases`
-- and adding one is out of scope for this narrow pass.
--
-- Reuses the existing generic app.skip_lease_audit_trigger GUC (see
-- 20260712000000_lease_audit_trigger_reconciliation.sql) so
-- fn_on_lease_changed does not write a duplicate audit row for this RPC's
-- UPDATE public.leases.

CREATE OR REPLACE FUNCTION public.save_lease_review_draft(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_field_reviews JSONB
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
  v_field_review_keys TEXT[];
  v_prior_abstract_status TEXT;
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
  IF jsonb_typeof(COALESCE(p_field_reviews, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'field_reviews must be a JSON object';
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

  -- Approved/locked guard -- see migration header. No dedicated "locked"
  -- column exists; any send-back/rejection already transitions
  -- abstract_status away from 'approved'.
  IF COALESCE(v_lease.abstract_status, '') = 'approved' THEN
    RAISE EXCEPTION 'Lease abstract is approved and locked; the review draft cannot be modified';
  END IF;

  v_prior_abstract_status := v_lease.abstract_status;
  SELECT array_agg(k) INTO v_field_review_keys FROM jsonb_object_keys(p_field_reviews) AS k;

  -- Full replace of field_reviews (matching saveAbstractDraft's exact
  -- current behavior), every other extraction_data key preserved.
  v_next_extraction := jsonb_set(
    COALESCE(v_lease.extraction_data, '{}'::jsonb),
    ARRAY['field_reviews'],
    p_field_reviews,
    true
  );

  -- Skip fn_on_lease_changed's own audit_logs insert -- this RPC writes its
  -- own canonical row below in the same transaction. Transaction-local
  -- (SET LOCAL semantics): reverts automatically at COMMIT/ROLLBACK.
  PERFORM set_config('app.skip_lease_audit_trigger', 'true', true);

  UPDATE public.leases
     SET extraction_data = v_next_extraction,
         abstract_status = 'pending_review',
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
    'lease_review_draft_saved',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    to_jsonb(v_lease),
    to_jsonb(v_updated_lease),
    jsonb_build_object(
      'field_review_keys', to_jsonb(COALESCE(v_field_review_keys, ARRAY[]::text[])),
      'prior_abstract_status', v_prior_abstract_status,
      'next_abstract_status', v_updated_lease.abstract_status
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'lease_id', v_updated_lease.id,
    'property_id', v_updated_lease.property_id,
    'extraction_data', v_updated_lease.extraction_data,
    'abstract_status', v_updated_lease.abstract_status,
    'updated_at', v_updated_lease.updated_at,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by save-lease-review-draft's assertPageAccess() call, so EXECUTE must be
-- restricted to service_role only (matching update_lease_extraction_field /
-- save_lease_expense_rule_set / review_expense_classification).
REVOKE ALL ON FUNCTION public.save_lease_review_draft(
  UUID, UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_lease_review_draft(
  UUID, UUID, UUID, TEXT, JSONB
) TO service_role;

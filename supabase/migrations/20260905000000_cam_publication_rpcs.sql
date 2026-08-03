-- Expense Classification -> CAM Publication boundary: RPC layer.
-- Companion to 20260904000000_cam_publication_boundary.sql (schema).
--
-- Preserves the existing Send-to-CAM calling contract exactly:
-- send_expense_classification_to_cam_workflow keeps its name and full
-- parameter list, so supabase/functions/_shared/send-expense-classification-
-- to-cam-workflow.ts and the send-expense-classification-to-cam edge
-- function (and therefore src/services/expenseClassificationWorkflowService.js
-- and everything that calls it) do not change at all. Same for
-- review_expense_classification and save_lease_rule_amount_cam_input.
--
-- New in this migration: one new RPC (withdraw_cam_expense_input) and a
-- small internal helper (mark_cam_snapshots_stale) that both
-- send_expense_classification_to_cam_workflow's own reopen-cascade path and
-- the new withdraw RPC call.

-- ===========================================================================
-- Helper: marks CAM computation_snapshots stale (unlocked) or
-- restatement_required (locked) for a given scope+year. Never touches
-- status/outputs/locked_at on a locked snapshot — it stays immutable,
-- exactly as this PR's instructions require. Used by both the reopen
-- cascade and the explicit withdraw RPC below.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.mark_cam_snapshots_stale(
  p_org_id UUID,
  p_property_id UUID,
  p_scope_level TEXT,
  p_scope_id UUID,
  p_fiscal_year INT,
  p_reason TEXT
)
RETURNS TABLE(stale_count INT, restatement_count INT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_stale_count INT := 0;
  v_restatement_count INT := 0;
BEGIN
  UPDATE public.computation_snapshots cs
     SET stale = true,
         stale_reason = p_reason
   WHERE cs.org_id = p_org_id
     AND cs.engine_type = 'cam'
     AND cs.fiscal_year = p_fiscal_year
     AND cs.status = 'completed'
     AND cs.locked_at IS NULL
     AND (p_property_id IS NULL OR cs.property_id = p_property_id)
     AND (p_scope_level IS NULL OR cs.scope_level = p_scope_level)
     AND (p_scope_id IS NULL OR cs.scope_id = p_scope_id);
  GET DIAGNOSTICS v_stale_count = ROW_COUNT;

  UPDATE public.computation_snapshots cs
     SET restatement_required = true,
         restatement_reason = p_reason
   WHERE cs.org_id = p_org_id
     AND cs.engine_type = 'cam'
     AND cs.fiscal_year = p_fiscal_year
     AND cs.status = 'completed'
     AND cs.locked_at IS NOT NULL
     AND (p_property_id IS NULL OR cs.property_id = p_property_id)
     AND (p_scope_level IS NULL OR cs.scope_level = p_scope_level)
     AND (p_scope_id IS NULL OR cs.scope_id = p_scope_id);
  GET DIAGNOSTICS v_restatement_count = ROW_COUNT;

  RETURN QUERY SELECT v_stale_count, v_restatement_count;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_cam_snapshots_stale(UUID, UUID, TEXT, UUID, INT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_cam_snapshots_stale(UUID, UUID, TEXT, UUID, INT, TEXT) TO service_role;

-- ===========================================================================
-- send_expense_classification_to_cam_workflow — same name/signature as
-- before. Behavior changes:
--   1. NEW readiness checks not previously enforced server-side: the
--      classification must be classification_status='finalized', the
--      linked expense (when present) must be approval_status/approved_status
--      = 'approved', and the linked rule (when present) must be
--      approval_status = 'approved'. (deriveExpenseCamSendBlockers in
--      _shared/send-expense-classification-to-cam-workflow.ts also gates
--      these before this RPC is even called — this is the second,
--      RPC-level layer of the same checks, so a future caller that skips
--      the TS layer still can't publish an unapproved/unfinalized row.)
--   2. Idempotent: if a PUBLISHED cam_expense_inputs row already exists for
--      this classification, return it unchanged — no new version, no
--      re-insert. (Matches this PR's "make publication idempotent"
--      instruction — this was already close to true via the
--      expense_classification_cam_send_runs idempotency-key table, but
--      that only protects literal duplicate requests; this protects
--      "already published" as a business state regardless of request
--      identity.)
--   3. Versioned: if this classification was PREVIOUSLY published and then
--      withdrawn, republishing creates a NEW cam_expense_inputs row
--      (publication_version = prior max + 1, previous_version_id pointing
--      at the withdrawn row) rather than reusing/updating the old one —
--      "never edit a published input silently."
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.send_expense_classification_to_cam_workflow(p_org_id uuid, p_classification_id uuid, p_actor_user_id uuid, p_actor_email text, p_reason text, p_idempotency_key text, p_request_payload jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_run public.expense_classification_cam_send_runs%ROWTYPE;
  v_classification public.expense_classifications%ROWTYPE;
  v_updated_classification public.expense_classifications%ROWTYPE;
  v_expense public.expenses%ROWTYPE;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_cam_input_id UUID;
  v_audit_log_id UUID;
  v_notification_id UUID;
  v_response JSONB;
  v_already_sent BOOLEAN := false;
  v_expense_id UUID;
  v_rule_id UUID;
  v_amount NUMERIC;
  v_recoverability TEXT;
  v_cam_source TEXT;
  v_is_automatic BOOLEAN := false;
  v_manual_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_existing_published public.cam_expense_inputs%ROWTYPE;
  v_previous_version_id UUID;
  v_next_version INT;
  v_expense_approved BOOLEAN;
  v_rule_approved BOOLEAN;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_classification_id IS NULL THEN
    RAISE EXCEPTION 'classification_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  SELECT *
    INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id
     AND org_id = p_org_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense classification not found for this organization';
  END IF;

  v_expense_id := COALESCE(v_classification.actual_expense_id, v_classification.expense_id);
  v_rule_id := COALESCE(v_classification.lease_expense_rule_id, v_classification.linked_expense_rule_id, v_classification.recovery_rule_id);

  IF v_expense_id IS NOT NULL THEN
    SELECT *
      INTO v_expense
      FROM public.expenses
     WHERE id = v_expense_id
       AND org_id = p_org_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Expense not found for this organization';
    END IF;
  END IF;

  IF v_rule_id IS NOT NULL THEN
    SELECT *
      INTO v_rule
      FROM public.lease_expense_rules
     WHERE id = v_rule_id
       AND COALESCE(org_id, p_org_id) = p_org_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Lease expense rule not found for this organization';
    END IF;
  END IF;

  INSERT INTO public.expense_classification_cam_send_runs (
    org_id,
    classification_id,
    expense_id,
    rule_id,
    idempotency_key,
    request_payload,
    actor_user_id,
    actor_email
  )
  VALUES (
    p_org_id,
    p_classification_id,
    v_expense_id,
    v_rule_id,
    p_idempotency_key,
    COALESCE(p_request_payload, '{}'::jsonb),
    p_actor_user_id,
    p_actor_email
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  SELECT *
    INTO v_run
    FROM public.expense_classification_cam_send_runs
   WHERE org_id = p_org_id
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF v_run.classification_id IS DISTINCT FROM p_classification_id THEN
    RAISE EXCEPTION 'idempotency_key reused for a different expense classification CAM workflow';
  END IF;

  IF v_run.request_payload IS DISTINCT FROM COALESCE(p_request_payload, '{}'::jsonb) THEN
    RAISE EXCEPTION 'idempotency_key reused with a different request payload';
  END IF;

  IF v_run.status = 'completed' AND v_run.response_payload <> '{}'::jsonb THEN
    RETURN v_run.response_payload;
  END IF;

  v_amount := COALESCE(v_classification.amount, v_expense.amount, 0);
  v_recoverability := lower(COALESCE(v_classification.recoverability_result, v_classification.recovery_status, ''));

  -- Business-rule readiness checks not previously enforced by this RPC.
  -- approval_status and approved_status are two distinct, independently
  -- maintained columns on expenses, each with its own non-null-but-not-
  -- "approved" default ('pending'/'draft') — COALESCE would let a
  -- genuinely-approved approved_status get masked by approval_status's
  -- unrelated default. Either column being 'approved' is sufficient.
  v_expense_approved := v_expense_id IS NULL
    OR lower(COALESCE(v_expense.approval_status, '')) = 'approved'
    OR lower(COALESCE(v_expense.approved_status, '')) = 'approved';
  v_rule_approved := v_rule_id IS NULL OR lower(COALESCE(v_rule.approval_status, '')) = 'approved';

  -- Check for an existing PUBLISHED row (the new versioning-aware
  -- idempotency: "already published" is a business state, independent of
  -- whether this exact request was seen before).
  SELECT * INTO v_existing_published
    FROM public.cam_expense_inputs
   WHERE classification_result_id = p_classification_id
     AND publication_status = 'published'
   LIMIT 1;

  IF FOUND THEN
    v_already_sent := true;
    v_updated_classification := v_classification;
    v_cam_input_id := v_existing_published.id;
  ELSE
    IF v_classification.classification_status IS DISTINCT FROM 'finalized' THEN
      RAISE EXCEPTION 'Cannot send to CAM: classification must be finalized first (current status: %)', v_classification.classification_status;
    END IF;
    IF NOT v_expense_approved THEN
      RAISE EXCEPTION 'Cannot send to CAM: linked expense is not approved';
    END IF;
    IF NOT v_rule_approved THEN
      RAISE EXCEPTION 'Cannot send to CAM: linked lease expense rule is not approved';
    END IF;
    IF lower(COALESCE(v_classification.cam_eligible, '')) <> 'yes' THEN
      RAISE EXCEPTION 'Cannot send to CAM: classification is not CAM eligible';
    END IF;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'Cannot send to CAM: classification amount must be greater than zero';
    END IF;
    IF v_recoverability = 'conditional' AND COALESCE(v_classification.condition_resolved, false) IS NOT TRUE THEN
      RAISE EXCEPTION 'Cannot send to CAM: conditional recoverability has not been resolved';
    END IF;
    IF v_rule_id IS NOT NULL THEN
      IF COALESCE(v_rule.published_to_cam, false) IS NOT TRUE AND v_manual_reason IS NULL THEN
        RAISE EXCEPTION 'Cannot send to CAM: linked rule is not published to CAM';
      END IF;
      IF lower(COALESCE(v_rule.payment_treatment, '')) IN ('included_in_base_rent', 'tenant_direct_contract')
        OR COALESCE(v_rule.is_excluded, false) IS TRUE
      THEN
        RAISE EXCEPTION 'Cannot send to CAM: linked rule is excluded from CAM';
      END IF;
    END IF;

    v_is_automatic := (
      v_expense_id IS NOT NULL
      AND v_rule_id IS NOT NULL
      AND v_recoverability = 'recoverable'
      AND lower(COALESCE(v_classification.cam_eligible, '')) = 'yes'
      AND COALESCE(v_rule.published_to_cam, false) IS TRUE
      AND v_amount > 0
      AND lower(COALESCE(v_rule.payment_treatment, '')) NOT IN ('included_in_base_rent', 'tenant_direct_contract')
      AND COALESCE(v_rule.is_excluded, false) IS FALSE
    );

    IF NOT v_is_automatic AND v_manual_reason IS NULL THEN
      RAISE EXCEPTION 'reason is required for manual CAM send';
    END IF;

    v_cam_source := CASE
      WHEN lower(COALESCE(v_classification.cam_input_type, '')) = 'lease_rule_amount' THEN 'lease_rule_amount'
      WHEN v_is_automatic THEN 'lease_rule'
      ELSE 'manual_review'
    END;

    -- Versioning: find the most recently withdrawn/superseded row for this
    -- classification (if any) to link as previous_version_id, and the next
    -- version number.
    SELECT id INTO v_previous_version_id
      FROM public.cam_expense_inputs
     WHERE classification_result_id = p_classification_id
       AND publication_status IN ('withdrawn', 'superseded')
     ORDER BY publication_version DESC, updated_at DESC
     LIMIT 1;

    SELECT COALESCE(MAX(publication_version), 0) + 1 INTO v_next_version
      FROM public.cam_expense_inputs
     WHERE classification_result_id = p_classification_id;

    v_before := jsonb_build_object(
      'sent_to_cam', v_classification.sent_to_cam,
      'sent_to_cam_at', v_classification.sent_to_cam_at,
      'cam_status', v_classification.cam_status,
      'cam_eligible', v_classification.cam_eligible,
      'cam_source', v_classification.cam_source,
      'cam_input_type', v_classification.cam_input_type,
      'manual_cam_reason', v_classification.manual_cam_reason
    );

    INSERT INTO public.cam_expense_inputs (
      org_id,
      property_id,
      building_id,
      unit_id,
      lease_id,
      tenant_id,
      actual_expense_id,
      classification_result_id,
      lease_expense_rule_id,
      category,
      amount,
      recovery_method,
      allocation_basis,
      source,
      status,
      cam_source,
      cam_input_type,
      manual_cam_reviewed,
      manual_cam_reason,
      fiscal_year,
      sent_to_cam_at,
      sent_to_cam_by,
      publication_status,
      publication_version,
      previous_version_id,
      source_expense_updated_at,
      source_classification_updated_at,
      source_rule_updated_at,
      published_by,
      published_at,
      updated_at
    )
    VALUES (
      p_org_id,
      COALESCE(v_classification.property_id, v_expense.property_id),
      COALESCE(v_classification.building_id, v_expense.building_id),
      COALESCE(v_classification.unit_id, v_expense.unit_id),
      COALESCE(v_classification.lease_id, v_expense.lease_id),
      COALESCE(v_classification.tenant_id, v_expense.tenant_id),
      v_expense_id,
      p_classification_id,
      v_rule_id,
      COALESCE(v_classification.category, v_expense.category),
      v_amount,
      v_classification.recovery_method,
      COALESCE(v_classification.allocation_basis, v_classification.allocation_method),
      v_cam_source,
      'cam_ready',
      v_cam_source,
      COALESCE(NULLIF(v_classification.cam_input_type, ''), 'actual_expense'),
      (NOT v_is_automatic) OR lower(COALESCE(v_classification.cam_input_type, '')) = 'lease_rule_amount',
      v_manual_reason,
      CASE
        WHEN v_classification.service_period_start IS NOT NULL THEN EXTRACT(YEAR FROM v_classification.service_period_start)::INTEGER
        ELSE NULL
      END,
      v_now,
      p_actor_user_id,
      'published',
      v_next_version,
      v_previous_version_id,
      v_expense.updated_at,
      v_classification.updated_at,
      v_rule.updated_at,
      p_actor_user_id,
      v_now,
      v_now
    )
    RETURNING id INTO v_cam_input_id;

    UPDATE public.expense_classifications
       SET sent_to_cam = true,
           sent_to_cam_at = v_now,
           sent_to_cam_by = p_actor_user_id,
           cam_status = 'cam_ready',
           cam_eligible = 'yes',
           cam_source = v_cam_source,
           cam_input_type = COALESCE(NULLIF(cam_input_type, ''), 'actual_expense'),
           manual_cam_reviewed = (NOT v_is_automatic) OR lower(COALESCE(cam_input_type, '')) = 'lease_rule_amount',
           manual_cam_reason = v_manual_reason,
           manual_cam_reviewed_by = CASE WHEN (NOT v_is_automatic) OR lower(COALESCE(cam_input_type, '')) = 'lease_rule_amount' THEN p_actor_user_id ELSE NULL END,
           manual_cam_reviewed_at = CASE WHEN (NOT v_is_automatic) OR lower(COALESCE(cam_input_type, '')) = 'lease_rule_amount' THEN v_now ELSE NULL END,
           next_step = 'CAM Ready',
           updated_at = v_now
     WHERE id = p_classification_id
     RETURNING * INTO v_updated_classification;

    v_after := jsonb_build_object(
      'sent_to_cam', v_updated_classification.sent_to_cam,
      'sent_to_cam_at', v_updated_classification.sent_to_cam_at,
      'cam_status', v_updated_classification.cam_status,
      'cam_eligible', v_updated_classification.cam_eligible,
      'cam_source', v_updated_classification.cam_source,
      'cam_input_type', v_updated_classification.cam_input_type,
      'manual_cam_reason', v_updated_classification.manual_cam_reason
    );

    INSERT INTO public.audit_logs (
      org_id,
      entity_type,
      entity_id,
      action,
      field_changed,
      old_value,
      new_value,
      actor_user_id,
      actor_email,
      severity,
      source,
      workflow_run_id,
      before,
      after,
      metadata,
      property_id
    )
    VALUES (
      p_org_id,
      'ExpenseClassification',
      p_classification_id::TEXT,
      'send_expense_classification_to_cam',
      'sent_to_cam',
      COALESCE(v_before->>'sent_to_cam', 'false'),
      'true',
      p_actor_user_id,
      p_actor_email,
      'info',
      'edge_function',
      v_run.id,
      v_before,
      v_after,
      jsonb_build_object(
        'workflow_run_id', v_run.id,
        'idempotency_key', p_idempotency_key,
        'classification_id', p_classification_id,
        'expense_id', v_expense_id,
        'rule_id', v_rule_id,
        'reason', v_manual_reason,
        'automatic', v_is_automatic,
        'publication_version', v_next_version,
        'previous_version_id', v_previous_version_id
      ),
      COALESCE(v_classification.property_id, v_expense.property_id)
    )
    RETURNING id INTO v_audit_log_id;

    INSERT INTO public.notifications (
      org_id,
      type,
      title,
      message,
      link,
      priority
    )
    VALUES (
      p_org_id,
      'approval',
      'Expense classification sent to CAM',
      'An approved expense classification is now available for CAM calculation.',
      '/LeaseExpenseClassification',
      'normal'
    )
    RETURNING id INTO v_notification_id;
  END IF;

  v_response := jsonb_build_object(
    'classification', to_jsonb(v_updated_classification),
    'expense_id', v_expense_id,
    'rule_id', v_rule_id,
    'cam_input_id', v_cam_input_id,
    'workflow_run_id', v_run.id,
    'audit_log_id', v_audit_log_id,
    'notification_id', v_notification_id,
    'already_sent', v_already_sent
  );

  UPDATE public.expense_classification_cam_send_runs
     SET status = 'completed',
         response_payload = v_response,
         completed_at = v_now,
         error_message = NULL
   WHERE id = v_run.id;

  RETURN v_response;
EXCEPTION WHEN OTHERS THEN
  IF v_run.id IS NOT NULL THEN
    UPDATE public.expense_classification_cam_send_runs
       SET status = 'failed',
           error_message = SQLERRM
     WHERE id = v_run.id;
  END IF;
  RAISE;
END;
$function$;

-- ===========================================================================
-- withdraw_cam_expense_input — NEW. Pulls a published CAM input back:
-- marks it 'withdrawn' (never deleted), returns the classification to
-- review ('matched', sent_to_cam=false, cam_status reset), and cascades to
-- CAM computation_snapshots via mark_cam_snapshots_stale. A later "Send to
-- CAM" on the same classification (after re-finalizing) publishes a brand
-- new, higher-version row via send_expense_classification_to_cam_workflow
-- above — this RPC never re-publishes anything itself.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.withdraw_cam_expense_input(
  p_org_id UUID,
  p_classification_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_classification public.expense_classifications%ROWTYPE;
  v_published public.cam_expense_inputs%ROWTYPE;
  v_reason TEXT := NULLIF(trim(COALESCE(p_reason, '')), '');
  v_scope_level TEXT;
  v_scope_id UUID;
  v_fiscal_year INT;
  v_stale_result RECORD;
  v_before JSONB;
  v_after JSONB;
  v_audit_log_id UUID;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_classification_id IS NULL THEN
    RAISE EXCEPTION 'classification_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'reason is required to withdraw a published CAM input';
  END IF;

  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense classification not found for this organization';
  END IF;

  SELECT * INTO v_published
    FROM public.cam_expense_inputs
   WHERE classification_result_id = p_classification_id
     AND publication_status = 'published'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This classification has no active published CAM input to withdraw';
  END IF;

  v_before := to_jsonb(v_published);

  UPDATE public.cam_expense_inputs
     SET publication_status = 'withdrawn',
         withdrawn_by = p_actor_user_id,
         withdrawn_at = v_now,
         withdrawal_reason = v_reason,
         updated_at = v_now
   WHERE id = v_published.id
  RETURNING to_jsonb(cam_expense_inputs.*) INTO v_after;

  UPDATE public.expense_classifications
     SET classification_status = 'matched',
         sent_to_cam = false,
         sent_to_cam_at = NULL,
         sent_to_cam_by = NULL,
         cam_status = NULL,
         finalized_at = NULL,
         next_step = 'Finalize row'
   WHERE id = p_classification_id AND org_id = p_org_id;

  v_scope_id := COALESCE(v_published.unit_id, v_published.building_id, v_published.property_id);
  v_scope_level := CASE
    WHEN v_published.unit_id IS NOT NULL THEN 'unit'
    WHEN v_published.building_id IS NOT NULL THEN 'building'
    WHEN v_published.property_id IS NOT NULL THEN 'property'
    ELSE NULL
  END;
  v_fiscal_year := v_published.fiscal_year;

  IF v_fiscal_year IS NOT NULL AND v_scope_level IS NOT NULL THEN
    SELECT * INTO v_stale_result
      FROM public.mark_cam_snapshots_stale(p_org_id, v_published.property_id, v_scope_level, v_scope_id, v_fiscal_year,
        format('CAM input withdrawn for classification %s: %s', p_classification_id, v_reason));
  END IF;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_published.property_id,
    'CamExpenseInput',
    v_published.id::TEXT,
    'cam_expense_input_withdrawn',
    p_actor_user_id,
    p_actor_email,
    'warning',
    'edge_function',
    v_before,
    v_after,
    jsonb_build_object(
      'classification_id', p_classification_id,
      'reason', v_reason,
      'stale_snapshot_count', COALESCE(v_stale_result.stale_count, 0),
      'restatement_required_snapshot_count', COALESCE(v_stale_result.restatement_count, 0)
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'cam_expense_input', v_after,
    'classification_id', p_classification_id,
    'audit_log_id', v_audit_log_id,
    'stale_snapshot_count', COALESCE(v_stale_result.stale_count, 0),
    'restatement_required_snapshot_count', COALESCE(v_stale_result.restatement_count, 0)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.withdraw_cam_expense_input(UUID, UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.withdraw_cam_expense_input(UUID, UUID, UUID, TEXT, TEXT) TO service_role;

-- ===========================================================================
-- review_expense_classification — same name/signature as before. Only the
-- 'reopen' branch changes: if the classification currently has an ACTIVE
-- published CAM input, reopening it now also withdraws that input (same
-- cascade as withdraw_cam_expense_input, inlined here so a single 'reopen'
-- call is enough — the UI does not need to call both). Every other action
-- (finalize/approve/reject/mark_na/resolve) is byte-for-byte unchanged.
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.review_expense_classification(p_org_id uuid, p_classification_id uuid, p_actor_user_id uuid, p_actor_email text, p_action text, p_recovery_status text DEFAULT NULL::text, p_approved_status text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_action TEXT := lower(COALESCE(p_action, ''));
  v_recovery_status TEXT := lower(COALESCE(p_recovery_status, ''));
  v_approved_status TEXT := lower(COALESCE(p_approved_status, ''));
  v_classification public.expense_classifications%ROWTYPE;
  v_expense public.expenses%ROWTYPE;
  v_expense_id UUID;
  v_before JSONB;
  v_after public.expense_classifications%ROWTYPE;
  v_after_json JSONB;
  v_next_step TEXT;
  v_next_status TEXT;
  v_amount NUMERIC;
  v_recoverable_amount NUMERIC := 0;
  v_non_recoverable_amount NUMERIC := 0;
  v_conditional_amount NUMERIC := 0;
  v_excluded_amount NUMERIC := 0;
  v_audit_action TEXT;
  v_audit_log_id UUID;
  v_response JSONB;
  v_published public.cam_expense_inputs%ROWTYPE;
  v_scope_level TEXT;
  v_scope_id UUID;
  v_stale_result RECORD;
  v_withdraw_metadata JSONB := NULL;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_classification_id IS NULL THEN
    RAISE EXCEPTION 'classification_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF v_action NOT IN ('finalize', 'reopen', 'approve', 'reject', 'mark_na', 'resolve') THEN
    RAISE EXCEPTION 'action must be one of finalize, reopen, approve, reject, mark_na, resolve';
  END IF;
  IF v_action IN ('finalize', 'approve') AND v_recovery_status NOT IN ('recoverable', 'non_recoverable', 'conditional', 'excluded') THEN
    RAISE EXCEPTION 'recovery_status must be one of recoverable, non_recoverable, conditional, excluded for %', v_action;
  END IF;
  IF v_action = 'approve' AND v_approved_status NOT IN ('approved', 'needs_review', 'rejected') THEN
    RAISE EXCEPTION 'approved_status must be one of approved, needs_review, rejected for approve';
  END IF;

  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense classification not found for this organization';
  END IF;

  v_expense_id := COALESCE(v_classification.expense_id, v_classification.actual_expense_id);
  IF v_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense classification has no linked expense';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = v_expense_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Linked expense not found for this organization';
  END IF;

  v_before := to_jsonb(v_classification);
  v_amount := COALESCE(v_classification.amount, v_expense.amount, 0);

  IF v_action = 'finalize' THEN
    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN v_amount ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN v_amount ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN v_amount ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN v_amount ELSE 0 END;
    v_next_step := CASE
      WHEN lower(COALESCE(v_classification.cam_eligible, '')) = 'yes' AND v_recovery_status = 'recoverable' THEN 'Send to CAM'
      ELSE 'Ready for projection'
    END;

    UPDATE public.expenses
       SET classification_updated_at = v_now,
           classification_updated_by = p_actor_user_id,
           recovery_status = v_recovery_status,
           recoverability_result = v_recovery_status,
           classification = v_recovery_status
     WHERE id = v_expense_id AND org_id = p_org_id;

    UPDATE public.expense_classifications
       SET recoverability_result = v_recovery_status,
           recovery_status = v_recovery_status,
           approved_status = 'approved',
           classification_status = 'finalized',
           exception_type = NULL,
           reviewed_at = v_now,
           reviewed_by = p_actor_user_id,
           approved_at = v_now,
           approved_by = p_actor_user_id,
           finalized_at = v_now,
           recoverable_amount = v_recoverable_amount,
           non_recoverable_amount = v_non_recoverable_amount,
           conditional_amount = v_conditional_amount,
           excluded_amount = v_excluded_amount,
           next_step = v_next_step
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_finalized';
  ELSIF v_action = 'reopen' THEN
    -- Cascade: if this classification currently has an ACTIVE published CAM
    -- input, withdraw it first (same effect as withdraw_cam_expense_input)
    -- so reopening never leaves a stale published input pointing at a
    -- classification that's back in draft/review. Inlined rather than
    -- calling withdraw_cam_expense_input directly so a missing published
    -- row (the common case: most reopens happen before anything was ever
    -- published) is a silent no-op here, not an error.
    SELECT * INTO v_published
      FROM public.cam_expense_inputs
     WHERE classification_result_id = p_classification_id
       AND publication_status = 'published'
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.cam_expense_inputs
         SET publication_status = 'withdrawn',
             withdrawn_by = p_actor_user_id,
             withdrawn_at = v_now,
             withdrawal_reason = 'Classification reopened for review',
             updated_at = v_now
       WHERE id = v_published.id;

      v_scope_id := COALESCE(v_published.unit_id, v_published.building_id, v_published.property_id);
      v_scope_level := CASE
        WHEN v_published.unit_id IS NOT NULL THEN 'unit'
        WHEN v_published.building_id IS NOT NULL THEN 'building'
        WHEN v_published.property_id IS NOT NULL THEN 'property'
        ELSE NULL
      END;

      IF v_published.fiscal_year IS NOT NULL AND v_scope_level IS NOT NULL THEN
        SELECT * INTO v_stale_result
          FROM public.mark_cam_snapshots_stale(p_org_id, v_published.property_id, v_scope_level, v_scope_id, v_published.fiscal_year,
            format('Classification %s reopened after CAM publication', p_classification_id));
      END IF;

      v_withdraw_metadata := jsonb_build_object(
        'withdrawn_cam_input_id', v_published.id,
        'stale_snapshot_count', COALESCE(v_stale_result.stale_count, 0),
        'restatement_required_snapshot_count', COALESCE(v_stale_result.restatement_count, 0)
      );
    END IF;

    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           finalized_at = NULL,
           cam_status = NULL,
           sent_to_cam = false,
           sent_to_cam_at = NULL,
           sent_to_cam_by = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_reopened';
  ELSIF v_action = 'approve' THEN
    v_next_status := CASE
      WHEN v_approved_status = 'approved' THEN
        CASE WHEN v_recovery_status IN ('recoverable', 'non_recoverable', 'excluded') THEN 'finalized' ELSE 'conditional' END
      ELSE
        CASE
          WHEN v_recovery_status = 'conditional' THEN 'conditional'
          WHEN v_recovery_status IN ('non_recoverable', 'excluded') THEN 'excluded'
          ELSE 'matched'
        END
    END;
    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN v_amount ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN v_amount ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN v_amount ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN v_amount ELSE 0 END;

    UPDATE public.expense_classifications
       SET recoverability_result = v_recovery_status,
           recovery_status = v_recovery_status,
           approved_status = p_approved_status,
           classification_status = v_next_status,
           exception_type = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN NULL ELSE exception_type END,
           reviewed_at = v_now,
           finalized_at = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN v_now ELSE NULL END,
           recoverable_amount = v_recoverable_amount,
           non_recoverable_amount = v_non_recoverable_amount,
           conditional_amount = v_conditional_amount,
           excluded_amount = v_excluded_amount,
           next_step = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN 'Ready for projection' ELSE 'Finalize row' END
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_approved';
  ELSIF v_action = 'reject' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'excluded',
           recoverability_result = 'excluded',
           recovery_status = 'excluded',
           exception_type = NULL,
           recoverable_amount = 0,
           non_recoverable_amount = 0,
           conditional_amount = 0,
           excluded_amount = v_amount,
           next_step = 'Ready for projection'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_rejected';
  ELSIF v_action = 'mark_na' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'excluded',
           recoverability_result = 'non_recoverable',
           recovery_status = 'non_recoverable',
           exception_type = NULL,
           recoverable_amount = 0,
           non_recoverable_amount = v_amount,
           conditional_amount = 0,
           excluded_amount = 0,
           next_step = 'Ready for projection'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_marked_na';
  ELSE -- resolve
    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           exception_type = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_resolved';
  END IF;

  v_after_json := to_jsonb(v_after);

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_after.property_id,
    'ExpenseClassification',
    v_after.id::TEXT,
    v_audit_action,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_before,
    v_after_json,
    COALESCE(v_withdraw_metadata, '{}'::jsonb) || jsonb_build_object('expense_id', v_expense_id, 'action', v_action),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object('row', v_after_json, 'audit_log_id', v_audit_log_id) || COALESCE(v_withdraw_metadata, '{}'::jsonb);
  RETURN v_response;
END;
$function$;

-- ===========================================================================
-- save_lease_rule_amount_cam_input — same name/signature as before. Only
-- change: a rule must now be rule_type='fixed_charge' to receive a manually
-- entered CAM rule amount through this workflow ("a normal lease expense
-- rule must never create an actual expense amount; only explicit
-- fixed-charge rules may contain contractual amounts"). Confirmed via this
-- PR's audit: 0 of 810 lease_expense_rules rows currently carry
-- rule_type='fixed_charge' — this workflow will correctly become
-- unavailable until rules are explicitly tagged as fixed-charge (see this
-- PR's report, deliverable I, for why no UI to set that tag was added
-- here).
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.save_lease_rule_amount_cam_input(p_org_id uuid, p_rule_id uuid, p_actor_user_id uuid, p_actor_email text, p_classification jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_allowed_keys TEXT[] := ARRAY[
    'classification_key', 'category', 'subcategory', 'property_id', 'building_id',
    'unit_id', 'lease_id', 'tenant_id', 'amount', 'fiscal_year'
  ];
  v_key TEXT;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_existing public.expense_classifications%ROWTYPE;
  v_updated public.expense_classifications%ROWTYPE;
  v_found BOOLEAN := false;
  v_classification_key TEXT;
  v_category TEXT;
  v_subcategory TEXT;
  v_property_id UUID;
  v_building_id UUID;
  v_unit_id UUID;
  v_lease_id UUID;
  v_tenant_id UUID;
  v_amount NUMERIC;
  v_fiscal_year INT;
  v_service_period_start DATE;
  v_service_period_end DATE;
  v_audit_log_id UUID;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_rule_id IS NULL THEN
    RAISE EXCEPTION 'rule_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF jsonb_typeof(COALESCE(p_classification, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'classification must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_classification) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'field % is not permitted', v_key;
    END IF;
  END LOOP;

  SELECT * INTO v_rule
    FROM public.lease_expense_rules
   WHERE id = p_rule_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this organization';
  END IF;
  IF v_rule.published_to_cam IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Only approved, CAM-eligible lease rules can receive a CAM rule amount';
  END IF;
  IF v_rule.rule_type IS DISTINCT FROM 'fixed_charge' THEN
    RAISE EXCEPTION 'Only rules explicitly marked rule_type=fixed_charge may receive a manually entered CAM amount — a normal recovery rule must be matched to a real actual expense instead (rule_type is currently %)', COALESCE(v_rule.rule_type, '(none)');
  END IF;

  v_classification_key := NULLIF(trim(COALESCE(p_classification ->> 'classification_key', '')), '');
  IF v_classification_key IS NULL THEN
    RAISE EXCEPTION 'classification_key is required';
  END IF;

  IF NULLIF(p_classification ->> 'amount', '') IS NULL THEN
    RAISE EXCEPTION 'amount is required';
  END IF;
  v_amount := (p_classification ->> 'amount')::NUMERIC;
  IF v_amount < 0 THEN
    RAISE EXCEPTION 'amount must be a non-negative number';
  END IF;

  IF NULLIF(p_classification ->> 'fiscal_year', '') IS NULL THEN
    RAISE EXCEPTION 'fiscal_year is required';
  END IF;
  v_fiscal_year := (p_classification ->> 'fiscal_year')::INT;
  v_service_period_start := make_date(v_fiscal_year, 1, 1);
  v_service_period_end := make_date(v_fiscal_year, 12, 31);

  v_category := NULLIF(p_classification ->> 'category', '');
  v_subcategory := NULLIF(p_classification ->> 'subcategory', '');

  v_property_id := NULLIF(p_classification ->> 'property_id', '')::UUID;
  IF v_property_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.properties WHERE id = v_property_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Property not found for this organization';
  END IF;

  v_building_id := NULLIF(p_classification ->> 'building_id', '')::UUID;
  IF v_building_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.buildings
       WHERE id = v_building_id AND org_id = p_org_id
         AND (v_property_id IS NULL OR property_id = v_property_id)
    ) THEN
      RAISE EXCEPTION 'Building not found for this organization/property';
    END IF;
  END IF;

  v_unit_id := NULLIF(p_classification ->> 'unit_id', '')::UUID;
  IF v_unit_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.units u
       WHERE u.id = v_unit_id AND u.org_id = p_org_id
         AND (v_property_id IS NULL OR u.property_id = v_property_id)
         AND (v_building_id IS NULL OR u.building_id = v_building_id)
    ) THEN
      RAISE EXCEPTION 'Unit not found for this organization/property/building';
    END IF;
  END IF;

  v_lease_id := NULLIF(p_classification ->> 'lease_id', '')::UUID;
  IF v_lease_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.leases WHERE id = v_lease_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  v_tenant_id := NULLIF(p_classification ->> 'tenant_id', '')::UUID;
  IF v_tenant_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.tenants WHERE id = v_tenant_id AND org_id = p_org_id
  ) THEN
    RAISE EXCEPTION 'Tenant not found for this organization';
  END IF;

  SELECT * INTO v_existing
    FROM public.expense_classifications
   WHERE org_id = p_org_id AND lease_expense_rule_id = p_rule_id AND row_type = 'rule_missing_actual'
   FOR UPDATE;
  v_found := FOUND;

  -- Idempotent no-op: nothing would actually change.
  IF v_found
     AND v_existing.classification_key IS NOT DISTINCT FROM v_classification_key
     AND v_existing.category IS NOT DISTINCT FROM v_category
     AND v_existing.subcategory IS NOT DISTINCT FROM v_subcategory
     AND v_existing.property_id IS NOT DISTINCT FROM v_property_id
     AND v_existing.building_id IS NOT DISTINCT FROM v_building_id
     AND v_existing.unit_id IS NOT DISTINCT FROM v_unit_id
     AND v_existing.lease_id IS NOT DISTINCT FROM v_lease_id
     AND v_existing.tenant_id IS NOT DISTINCT FROM v_tenant_id
     AND v_existing.amount IS NOT DISTINCT FROM v_amount
     AND v_existing.service_period_start IS NOT DISTINCT FROM v_service_period_start
     AND v_existing.service_period_end IS NOT DISTINCT FROM v_service_period_end
  THEN
    RETURN jsonb_build_object(
      'classification', to_jsonb(v_existing),
      'changed', false
    );
  END IF;

  IF v_found THEN
    UPDATE public.expense_classifications SET
      classification_key = v_classification_key,
      category = v_category,
      subcategory = v_subcategory,
      property_id = v_property_id,
      building_id = v_building_id,
      unit_id = v_unit_id,
      lease_id = v_lease_id,
      tenant_id = v_tenant_id,
      amount = v_amount,
      service_period_start = v_service_period_start,
      service_period_end = v_service_period_end,
      recoverable_amount = v_amount,
      non_recoverable_amount = 0,
      conditional_amount = 0,
      excluded_amount = 0,
      recoverability_result = 'recoverable',
      recovery_status = 'recoverable',
      cam_eligible = 'yes',
      cam_status = 'cam_ready',
      cam_source = 'lease_rule_amount',
      cam_input_type = 'lease_rule_amount',
      manual_cam_reviewed = true,
      manual_cam_reason = 'CAM rule amount entered by reviewer',
      manual_cam_reviewed_by = p_actor_user_id,
      manual_cam_reviewed_at = v_now,
      classification_status = 'finalized',
      approved_status = 'approved',
      sent_to_cam = false,
      sent_to_cam_at = NULL,
      sent_to_cam_by = NULL,
      finalized_at = v_now,
      reviewed_at = v_now,
      reviewed_by = p_actor_user_id,
      next_step = 'CAM Ready',
      updated_at = v_now
     WHERE id = v_existing.id AND org_id = p_org_id
    RETURNING * INTO v_updated;
  ELSE
    INSERT INTO public.expense_classifications (
      org_id, expense_id, actual_expense_id, classification_key,
      lease_expense_rule_id, linked_expense_rule_id, recovery_rule_id, row_type,
      category, subcategory, property_id, building_id, unit_id, lease_id, tenant_id,
      amount, service_period_start, service_period_end,
      recoverable_amount, non_recoverable_amount, conditional_amount, excluded_amount,
      recoverability_result, recovery_status, cam_eligible, cam_status,
      cam_source, cam_input_type, manual_cam_reviewed, manual_cam_reason,
      manual_cam_reviewed_by, manual_cam_reviewed_at,
      classification_status, approved_status,
      sent_to_cam, sent_to_cam_at, sent_to_cam_by,
      finalized_at, reviewed_at, reviewed_by, next_step,
      classified_at, updated_at
    ) VALUES (
      p_org_id, NULL, NULL, v_classification_key,
      p_rule_id, p_rule_id, p_rule_id, 'rule_missing_actual',
      v_category, v_subcategory, v_property_id, v_building_id, v_unit_id, v_lease_id, v_tenant_id,
      v_amount, v_service_period_start, v_service_period_end,
      v_amount, 0, 0, 0,
      'recoverable', 'recoverable', 'yes', 'cam_ready',
      'lease_rule_amount', 'lease_rule_amount', true, 'CAM rule amount entered by reviewer',
      p_actor_user_id, v_now,
      'finalized', 'approved',
      false, NULL, NULL,
      v_now, v_now, p_actor_user_id, 'CAM Ready',
      v_now, v_now
    )
    RETURNING * INTO v_updated;
  END IF;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'ExpenseClassification', v_updated.id::TEXT,
    'expense_classification_rule_amount_saved', p_actor_user_id, p_actor_email,
    'info', 'edge_function',
    CASE WHEN v_found THEN to_jsonb(v_existing) ELSE NULL END,
    to_jsonb(v_updated),
    jsonb_build_object('rule_id', p_rule_id, 'fiscal_year', v_fiscal_year, 'amount', v_amount),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'classification', to_jsonb(v_updated),
    'changed', true,
    'audit_log_id', v_audit_log_id
  );
END;
$function$;

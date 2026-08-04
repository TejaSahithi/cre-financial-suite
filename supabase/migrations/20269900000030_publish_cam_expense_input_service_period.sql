-- Root cause (confirmed against real production data, org
-- 7d16919f-6587-4fbc-b21f-e27e15a752ee, property A2): 100% (6 of 6) of
-- currently published cam_expense_inputs rows have NULL
-- service_period_start/service_period_end, even though every one of their
-- source expense_classifications rows has real, non-null service period
-- dates. This is NOT a legacy-data-only gap.
--
-- 20269900000020_cam_expense_inputs_engine_v2_columns.sql added
-- service_period_start/service_period_end to cam_expense_inputs (correctly
-- declining to backfill historical rows, since inventing a service period
-- for old data would be worse than leaving it NULL) but never updated the
-- publish RPC itself to populate those columns going forward. So every
-- classification published AFTER that migration — not just rows that
-- predate it — still gets a NULL service period today. That's the live bug
-- this migration fixes: send_expense_classification_to_cam_workflow's
-- INSERT INTO cam_expense_inputs never lists service_period_start or
-- service_period_end at all, despite reading v_classification directly.
--
-- pools/pool-builder.ts::assembleSegmentAmounts already treats a missing
-- service period as a blocking EXPENSE_SERVICE_PERIOD_MISSING exception,
-- so today every newly published expense silently becomes a blocking CAM
-- exception instead of a working input — this is the "expenses missing
-- ... service period" defect.
--
-- Same 7-parameter signature as the current definition
-- (20269900000007_cam_publication_remainder_checks.sql) — no new
-- parameters, so a plain CREATE OR REPLACE is sufficient (does not create
-- a second overload).
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

  -- Business-rule readiness checks. approval_status and approved_status are
  -- two distinct, independently maintained columns on expenses, each with
  -- its own non-null-but-not-"approved" default ('pending'/'draft') —
  -- COALESCE would let a genuinely-approved approved_status get masked by
  -- approval_status's unrelated default. Either column being 'approved' is
  -- sufficient.
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
    IF v_expense_id IS NOT NULL AND v_amount > COALESCE(v_expense.amount, v_amount) THEN
      RAISE EXCEPTION 'Cannot send to CAM: classification amount (%) exceeds the approved expense amount (%)', v_amount, v_expense.amount;
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
      service_period_start,
      service_period_end,
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
      v_classification.service_period_start,
      v_classification.service_period_end,
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

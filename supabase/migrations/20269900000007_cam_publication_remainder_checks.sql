-- Enforces the two remaining readiness checks from this PR's list that
-- need real data, not just new columns:
--   "allocated amount total must not exceed the approved expense amount"
--   "unresolved remainder exists without an accepted exception" (blocks finalize)
--
-- review_expense_classification gains two new OPTIONAL trailing parameters
-- (p_remainder_accepted, p_remainder_reason) — this CHANGES its parameter
-- signature, so (per this session's established lesson from
-- 20269900000002_snapshot_publish_rpc.sql) a plain CREATE OR REPLACE would
-- create a SECOND overload instead of replacing the function. The old
-- 7-parameter signature is explicitly dropped first. Existing callers that
-- only pass the original 7 arguments are unaffected — the 2 new parameters
-- default to false/NULL, which is "no remainder acceptance provided",
-- exactly matching pre-this-PR behavior for any classification that fully
-- allocates the expense amount (the common case).
DROP FUNCTION IF EXISTS public.review_expense_classification(uuid, uuid, uuid, text, text, text, text);

CREATE OR REPLACE FUNCTION public.review_expense_classification(
  p_org_id uuid,
  p_classification_id uuid,
  p_actor_user_id uuid,
  p_actor_email text,
  p_action text,
  p_recovery_status text DEFAULT NULL::text,
  p_approved_status text DEFAULT NULL::text,
  p_remainder_accepted boolean DEFAULT false,
  p_remainder_reason text DEFAULT NULL::text
)
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
  v_remainder NUMERIC;
  v_remainder_reason TEXT := NULLIF(trim(COALESCE(p_remainder_reason, '')), '');
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
  IF p_remainder_accepted IS TRUE AND v_remainder_reason IS NULL THEN
    RAISE EXCEPTION 'remainder_reason is required when remainder_accepted is true';
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
    -- "allocated amount total must not exceed the approved expense amount"
    IF v_amount > COALESCE(v_expense.amount, v_amount) THEN
      RAISE EXCEPTION 'Cannot finalize: classification amount (%) exceeds the approved expense amount (%)', v_amount, v_expense.amount;
    END IF;

    -- "unresolved remainder exists without an accepted exception" blocks finalize.
    v_remainder := GREATEST(COALESCE(v_expense.amount, v_amount) - v_amount, 0);
    IF v_remainder > 0 AND NOT COALESCE(p_remainder_accepted, false) THEN
      RAISE EXCEPTION 'Cannot finalize: % of the expense amount is unallocated (classification amount % of expense amount %) — pass remainder_accepted with a reason, or allocate the full amount', v_remainder, v_amount, v_expense.amount;
    END IF;

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
           remainder_accepted = COALESCE(p_remainder_accepted, false),
           remainder_reason = v_remainder_reason,
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

-- send_expense_classification_to_cam_workflow: add the same
-- "allocated amount must not exceed approved expense amount" check at
-- publish time (defense in depth — finalize already blocks it, but publish
-- must not trust that the classification's amount/expense.amount
-- relationship hasn't drifted between finalize and publish). Same 7-param
-- signature as before (no new parameters), so a plain CREATE OR REPLACE is
-- sufficient here.
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

-- The DROP FUNCTION above resets grants to the Postgres default (PUBLIC +
-- anon execute) — every prior migration that changed this function's
-- signature (20260711000000_review_expense_classification_exception_queue.sql:263-269)
-- re-applied this exact lockdown afterward and this migration must too, or
-- a SECURITY DEFINER function meant to be service_role-only silently
-- becomes callable by anon/authenticated again.
REVOKE ALL ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, BOOLEAN, TEXT
) TO service_role;

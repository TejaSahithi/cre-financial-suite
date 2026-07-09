-- Enterprise hardening Phase 6X-1: server-own the paired expenses +
-- expense_classifications writes for reviewExpense(), classifyExpenses(),
-- and sendExpenseClassificationToReview().
--
-- Problem found: all three workflows already route their
-- expense_classifications write through persist_expense_classification
-- (via upsertExpenseClassification's hasExpense branch) EXCEPT
-- sendExpenseClassificationToReview, which instead used the still-direct
-- updateExpenseClassificationRecord() helper. All three ALSO perform a
-- second, completely separate direct write to `expenses` via
-- updateExpenseWorkflowDirect()/persistExpenseWorkflowPatch() -- confirmed
-- by reading the exact call sites that, despite each building a much
-- larger patch object, persistExpenseWorkflowPatch's own narrow 3-attempt
-- ladder means only `classification` and `recovery_status` (plus a
-- server-set `updated_at`) ever actually reach the `expenses` table today.
-- One user action therefore produced two separate, non-transactional
-- writes -- one gated, one not.
--
-- Fix: extend persist_expense_classification with a new, optional
-- `p_expense_patch` parameter. When provided, the same transaction that
-- upserts expense_classifications also updates exactly the two `expenses`
-- columns confirmed to be the only ones ever actually written by these
-- workflows (`classification`, `recovery_status`) plus `updated_at`.
-- Whitelisted the same way update_lease_expense_rule whitelists its patch
-- keys -- an unrecognized key raises an exception, nothing is silently
-- dropped. A failure anywhere in the function (classification consistency
-- gate, expenses update) rolls back the whole transaction; no path can
-- leave one table updated and the other not.
--
-- Also fixed, needed to safely support sendExpenseClassificationToReview's
-- sparse-patch call shape without losing data: every column previously
-- extracted from p_classification_patch with NO existing-row fallback
-- (e.g. `NULLIF(v_patch->>'category', '')`, which silently wrote NULL if
-- the key was simply absent from the patch) now falls back to the
-- existing row's own value when the key is absent -- CASE WHEN v_patch ?
-- 'key' THEN ... ELSE v_existing.key END. This is backward compatible:
-- reviewExpense()/classifyExpenses() already send a near-complete payload
-- every call (computed by merging existingClassification client-side), so
-- their behavior is unchanged. It newly makes the RPC safe for genuinely
-- sparse patches too (send-to-review only needs to touch ~9 fields without
-- wiping everything else). Fields that already had a sensible non-NULL
-- default (e.g. allocation_method='pro_rata') keep that default for a
-- brand-new row (v_existing.* is NULL when no row was found, so
-- COALESCE(v_existing.col, default) resolves correctly either way).
--
-- Security correction: this RPC has had no direct frontend caller since it
-- was introduced (confirmed via grep -- the sole caller is
-- upsertExpenseClassification's invokeEdgeFunction("persist-expense-classification", ...)
-- call). Its original grant of `TO authenticated, service_role` was
-- broader than necessary for a SECURITY DEFINER function whose only
-- legitimate entry point is the edge function; tightened to
-- `service_role` only, matching every RPC added since Phase 6D-1.

DROP FUNCTION IF EXISTS public.persist_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB
);

CREATE OR REPLACE FUNCTION public.persist_expense_classification(
  p_org_id UUID,
  p_expense_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_recovery_status TEXT,
  p_recoverability_result TEXT,
  p_cam_eligible TEXT,
  p_cam_status TEXT,
  p_linked_expense_rule_id UUID,
  p_sent_to_cam BOOLEAN,
  p_classification_patch JSONB DEFAULT '{}'::jsonb,
  p_expense_patch JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_expense public.expenses%ROWTYPE;
  v_expense_before JSONB;
  v_expense_after public.expenses%ROWTYPE;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_existing public.expense_classifications%ROWTYPE;
  v_after public.expense_classifications%ROWTYPE;
  v_patch JSONB := COALESCE(p_classification_patch, '{}'::jsonb);
  v_expense_patch JSONB := COALESCE(p_expense_patch, '{}'::jsonb);
  v_expense_key TEXT;
  v_expense_patched BOOLEAN := false;
  v_recovery_status TEXT := lower(COALESCE(p_recovery_status, p_recoverability_result, 'needs_review'));
  v_recoverability_result TEXT := COALESCE(p_recoverability_result, p_recovery_status);
  v_cam_eligible TEXT := lower(COALESCE(p_cam_eligible, ''));
  v_cam_status TEXT := lower(COALESCE(p_cam_status, ''));
  v_blockers TEXT[] := ARRAY[]::TEXT[];
  v_before JSONB;
  v_after_json JSONB;
  v_audit_log_id UUID;
  v_response JSONB;
  v_allowed_expense_patch_keys TEXT[] := ARRAY['classification', 'recovery_status'];
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_expense_id IS NULL THEN
    RAISE EXCEPTION 'expense_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;

  IF p_expense_patch IS NOT NULL THEN
    FOR v_expense_key IN SELECT jsonb_object_keys(v_expense_patch) LOOP
      IF NOT (v_expense_key = ANY(v_allowed_expense_patch_keys)) THEN
        RAISE EXCEPTION 'expense_patch field % is not permitted', v_expense_key;
      END IF;
    END LOOP;
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found for this organization';
  END IF;

  IF p_linked_expense_rule_id IS NOT NULL THEN
    SELECT * INTO v_rule
      FROM public.lease_expense_rules
     WHERE id = p_linked_expense_rule_id
       AND COALESCE(org_id, p_org_id) = p_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Linked lease expense rule not found for this organization';
    END IF;
  END IF;

  SELECT * INTO v_existing
    FROM public.expense_classifications
   WHERE org_id = p_org_id AND expense_id = p_expense_id;

  -- Consistency checks. These re-derive blockers from the expense/rule the
  -- same way deriveExpenseCamSendBlockers does for the CAM-send workflow,
  -- not from the client-asserted booleans.
  IF v_cam_eligible = 'yes' AND v_recovery_status <> 'recoverable' THEN
    v_blockers := array_append(v_blockers, 'cam_eligible_without_recoverable_status');
  END IF;

  IF v_cam_status = 'cam_ready' THEN
    IF v_recovery_status <> 'recoverable' THEN
      v_blockers := array_append(v_blockers, 'cam_ready_without_recoverable_status');
    END IF;
    IF v_cam_eligible <> 'yes' THEN
      v_blockers := array_append(v_blockers, 'cam_ready_without_cam_eligible');
    END IF;
    IF p_linked_expense_rule_id IS NOT NULL THEN
      IF COALESCE(v_rule.published_to_cam, false) IS NOT TRUE THEN
        v_blockers := array_append(v_blockers, 'cam_ready_rule_not_published');
      END IF;
      IF COALESCE(v_rule.is_excluded, false) IS TRUE
        OR lower(COALESCE(v_rule.payment_treatment, '')) IN ('included_in_base_rent', 'tenant_direct_contract')
      THEN
        v_blockers := array_append(v_blockers, 'cam_ready_rule_excluded');
      END IF;
    END IF;
  END IF;

  -- sent_to_cam may only be carried forward, never newly set true here.
  IF COALESCE(p_sent_to_cam, false) IS TRUE AND COALESCE(v_existing.sent_to_cam, false) IS NOT TRUE THEN
    v_blockers := array_append(v_blockers, 'sent_to_cam_must_use_dedicated_workflow');
  END IF;

  IF array_length(v_blockers, 1) > 0 THEN
    RAISE EXCEPTION 'Classification rejected: %', array_to_string(v_blockers, ', ');
  END IF;

  v_before := to_jsonb(v_existing);

  INSERT INTO public.expense_classifications (
    org_id, expense_id, actual_expense_id, property_id, building_id, unit_id, lease_id, tenant_id,
    recovery_rule_id, linked_expense_rule_id, lease_expense_rule_id, classification_key,
    category, subcategory, amount, service_period_start, service_period_end,
    recovery_status, recoverability_result, cam_eligible, cam_status, cam_source, cam_input_type,
    recovery_method, recovery_reason, allocation_method, allocation_basis,
    cap_applied, exclusion_applied, condition_applied, condition_reason, condition_resolved, condition_result,
    rule_source, confidence_score, evidence_text, evidence_page_number,
    approved_status, classification_status, exception_type, finalized_at,
    recoverable_amount, non_recoverable_amount, conditional_amount, excluded_amount,
    sent_to_cam, sent_to_cam_at, sent_to_cam_by, manual_cam_reason, manual_cam_reviewed,
    next_step, notes, classified_at, classified_by, updated_at
  )
  VALUES (
    p_org_id, p_expense_id,
    COALESCE(NULLIF(v_patch->>'actual_expense_id', '')::UUID, p_expense_id),
    COALESCE(NULLIF(v_patch->>'property_id', '')::UUID, v_expense.property_id),
    COALESCE(NULLIF(v_patch->>'building_id', '')::UUID, v_expense.building_id),
    COALESCE(NULLIF(v_patch->>'unit_id', '')::UUID, v_expense.unit_id),
    COALESCE(NULLIF(v_patch->>'lease_id', '')::UUID, v_expense.lease_id),
    COALESCE(NULLIF(v_patch->>'tenant_id', '')::UUID, v_expense.tenant_id),
    p_linked_expense_rule_id,
    p_linked_expense_rule_id,
    p_linked_expense_rule_id,
    CASE WHEN v_patch ? 'classification_key' THEN NULLIF(v_patch->>'classification_key', '') ELSE v_existing.classification_key END,
    CASE WHEN v_patch ? 'category' THEN NULLIF(v_patch->>'category', '') ELSE v_existing.category END,
    CASE WHEN v_patch ? 'subcategory' THEN NULLIF(v_patch->>'subcategory', '') ELSE v_existing.subcategory END,
    CASE WHEN v_patch ? 'amount' THEN NULLIF(v_patch->>'amount', '')::NUMERIC ELSE v_existing.amount END,
    CASE WHEN v_patch ? 'service_period_start' THEN NULLIF(v_patch->>'service_period_start', '')::DATE ELSE v_existing.service_period_start END,
    CASE WHEN v_patch ? 'service_period_end' THEN NULLIF(v_patch->>'service_period_end', '')::DATE ELSE v_existing.service_period_end END,
    v_recovery_status,
    v_recoverability_result,
    p_cam_eligible,
    p_cam_status,
    CASE WHEN v_patch ? 'cam_source' THEN NULLIF(v_patch->>'cam_source', '') ELSE v_existing.cam_source END,
    CASE WHEN v_patch ? 'cam_input_type' THEN COALESCE(NULLIF(v_patch->>'cam_input_type', ''), 'actual_expense') ELSE COALESCE(v_existing.cam_input_type, 'actual_expense') END,
    CASE WHEN v_patch ? 'recovery_method' THEN NULLIF(v_patch->>'recovery_method', '') ELSE v_existing.recovery_method END,
    CASE WHEN v_patch ? 'recovery_reason' THEN NULLIF(v_patch->>'recovery_reason', '') ELSE v_existing.recovery_reason END,
    CASE WHEN v_patch ? 'allocation_method' THEN COALESCE(NULLIF(v_patch->>'allocation_method', ''), 'pro_rata') ELSE COALESCE(v_existing.allocation_method, 'pro_rata') END,
    CASE WHEN v_patch ? 'allocation_basis' THEN COALESCE(NULLIF(v_patch->>'allocation_basis', ''), 'pro_rata') ELSE COALESCE(v_existing.allocation_basis, 'pro_rata') END,
    CASE WHEN v_patch ? 'cap_applied' THEN COALESCE((v_patch->>'cap_applied')::BOOLEAN, false) ELSE COALESCE(v_existing.cap_applied, false) END,
    CASE WHEN v_patch ? 'exclusion_applied' THEN COALESCE((v_patch->>'exclusion_applied')::BOOLEAN, false) ELSE COALESCE(v_existing.exclusion_applied, false) END,
    CASE WHEN v_patch ? 'condition_applied' THEN COALESCE((v_patch->>'condition_applied')::BOOLEAN, false) ELSE COALESCE(v_existing.condition_applied, false) END,
    CASE WHEN v_patch ? 'condition_reason' THEN NULLIF(v_patch->>'condition_reason', '') ELSE v_existing.condition_reason END,
    CASE WHEN v_patch ? 'condition_resolved' THEN COALESCE((v_patch->>'condition_resolved')::BOOLEAN, true) ELSE COALESCE(v_existing.condition_resolved, true) END,
    CASE WHEN v_patch ? 'condition_result' THEN NULLIF(v_patch->>'condition_result', '') ELSE v_existing.condition_result END,
    CASE WHEN v_patch ? 'rule_source' THEN NULLIF(v_patch->>'rule_source', '') ELSE v_existing.rule_source END,
    CASE WHEN v_patch ? 'confidence_score' THEN NULLIF(v_patch->>'confidence_score', '')::NUMERIC ELSE v_existing.confidence_score END,
    CASE WHEN v_patch ? 'evidence_text' THEN NULLIF(v_patch->>'evidence_text', '') ELSE v_existing.evidence_text END,
    CASE WHEN v_patch ? 'evidence_page_number' THEN NULLIF(v_patch->>'evidence_page_number', '')::INTEGER ELSE v_existing.evidence_page_number END,
    CASE WHEN v_patch ? 'approved_status' THEN COALESCE(NULLIF(v_patch->>'approved_status', ''), 'draft') ELSE COALESCE(v_existing.approved_status, 'draft') END,
    CASE WHEN v_patch ? 'classification_status' THEN NULLIF(v_patch->>'classification_status', '') ELSE v_existing.classification_status END,
    CASE WHEN v_patch ? 'exception_type' THEN NULLIF(v_patch->>'exception_type', '') ELSE v_existing.exception_type END,
    CASE WHEN v_patch ? 'finalized_at' THEN NULLIF(v_patch->>'finalized_at', '')::TIMESTAMPTZ ELSE v_existing.finalized_at END,
    CASE WHEN v_patch ? 'recoverable_amount' THEN COALESCE((v_patch->>'recoverable_amount')::NUMERIC, 0) ELSE COALESCE(v_existing.recoverable_amount, 0) END,
    CASE WHEN v_patch ? 'non_recoverable_amount' THEN COALESCE((v_patch->>'non_recoverable_amount')::NUMERIC, 0) ELSE COALESCE(v_existing.non_recoverable_amount, 0) END,
    CASE WHEN v_patch ? 'conditional_amount' THEN COALESCE((v_patch->>'conditional_amount')::NUMERIC, 0) ELSE COALESCE(v_existing.conditional_amount, 0) END,
    CASE WHEN v_patch ? 'excluded_amount' THEN COALESCE((v_patch->>'excluded_amount')::NUMERIC, 0) ELSE COALESCE(v_existing.excluded_amount, 0) END,
    COALESCE(p_sent_to_cam, v_existing.sent_to_cam, false),
    v_existing.sent_to_cam_at,
    v_existing.sent_to_cam_by,
    CASE WHEN v_patch ? 'manual_cam_reason' THEN NULLIF(v_patch->>'manual_cam_reason', '') ELSE v_existing.manual_cam_reason END,
    COALESCE((v_patch->>'manual_cam_reviewed')::BOOLEAN, v_existing.manual_cam_reviewed, false),
    CASE WHEN v_patch ? 'next_step' THEN NULLIF(v_patch->>'next_step', '') ELSE v_existing.next_step END,
    CASE WHEN v_patch ? 'notes' THEN NULLIF(v_patch->>'notes', '') ELSE v_existing.notes END,
    COALESCE(NULLIF(v_patch->>'classified_at', '')::TIMESTAMPTZ, v_now),
    p_actor_user_id,
    v_now
  )
  ON CONFLICT (org_id, expense_id) DO UPDATE SET
    property_id = EXCLUDED.property_id,
    building_id = EXCLUDED.building_id,
    unit_id = EXCLUDED.unit_id,
    lease_id = EXCLUDED.lease_id,
    tenant_id = EXCLUDED.tenant_id,
    recovery_rule_id = EXCLUDED.recovery_rule_id,
    linked_expense_rule_id = EXCLUDED.linked_expense_rule_id,
    lease_expense_rule_id = EXCLUDED.lease_expense_rule_id,
    category = EXCLUDED.category,
    subcategory = EXCLUDED.subcategory,
    amount = EXCLUDED.amount,
    service_period_start = EXCLUDED.service_period_start,
    service_period_end = EXCLUDED.service_period_end,
    recovery_status = EXCLUDED.recovery_status,
    recoverability_result = EXCLUDED.recoverability_result,
    cam_eligible = EXCLUDED.cam_eligible,
    cam_status = EXCLUDED.cam_status,
    cam_source = EXCLUDED.cam_source,
    cam_input_type = EXCLUDED.cam_input_type,
    recovery_method = EXCLUDED.recovery_method,
    recovery_reason = EXCLUDED.recovery_reason,
    allocation_method = EXCLUDED.allocation_method,
    allocation_basis = EXCLUDED.allocation_basis,
    cap_applied = EXCLUDED.cap_applied,
    exclusion_applied = EXCLUDED.exclusion_applied,
    condition_applied = EXCLUDED.condition_applied,
    condition_reason = EXCLUDED.condition_reason,
    condition_resolved = EXCLUDED.condition_resolved,
    condition_result = EXCLUDED.condition_result,
    rule_source = EXCLUDED.rule_source,
    confidence_score = EXCLUDED.confidence_score,
    evidence_text = EXCLUDED.evidence_text,
    evidence_page_number = EXCLUDED.evidence_page_number,
    approved_status = EXCLUDED.approved_status,
    classification_status = EXCLUDED.classification_status,
    exception_type = EXCLUDED.exception_type,
    finalized_at = EXCLUDED.finalized_at,
    recoverable_amount = EXCLUDED.recoverable_amount,
    non_recoverable_amount = EXCLUDED.non_recoverable_amount,
    conditional_amount = EXCLUDED.conditional_amount,
    excluded_amount = EXCLUDED.excluded_amount,
    sent_to_cam = EXCLUDED.sent_to_cam,
    manual_cam_reason = EXCLUDED.manual_cam_reason,
    manual_cam_reviewed = EXCLUDED.manual_cam_reviewed,
    next_step = EXCLUDED.next_step,
    notes = EXCLUDED.notes,
    classified_at = EXCLUDED.classified_at,
    classified_by = EXCLUDED.classified_by,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO v_after;

  v_after_json := to_jsonb(v_after);

  -- Paired expenses-table persistence, in the same transaction. Whitelisted
  -- to exactly the two columns these workflows have ever actually written
  -- (classification, recovery_status) -- see migration header.
  IF p_expense_patch IS NOT NULL AND v_expense_patch <> '{}'::jsonb THEN
    v_expense_before := to_jsonb(v_expense);
    UPDATE public.expenses
       SET classification = CASE WHEN v_expense_patch ? 'classification' THEN NULLIF(v_expense_patch->>'classification', '') ELSE classification END,
           recovery_status = CASE WHEN v_expense_patch ? 'recovery_status' THEN NULLIF(v_expense_patch->>'recovery_status', '') ELSE recovery_status END,
           updated_at = v_now
     WHERE id = p_expense_id AND org_id = p_org_id
    RETURNING * INTO v_expense_after;
    v_expense_patched := true;
  END IF;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_after.property_id, 'ExpenseClassification', v_after.id::TEXT, 'expense_classification_persisted',
    p_actor_user_id, p_actor_email, 'info', 'edge_function',
    v_before, v_after_json,
    jsonb_build_object(
      'expense_id', p_expense_id,
      'linked_expense_rule_id', p_linked_expense_rule_id,
      'expense_patched', v_expense_patched,
      'expense_patch_keys', CASE WHEN v_expense_patched THEN to_jsonb((SELECT array_agg(k) FROM jsonb_object_keys(v_expense_patch) AS k)) ELSE NULL END
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'row', v_after_json,
    'audit_log_id', v_audit_log_id,
    'expense_patched', v_expense_patched,
    'expense', CASE WHEN v_expense_patched THEN to_jsonb(v_expense_after) ELSE NULL END
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.persist_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB, JSONB
) TO service_role;

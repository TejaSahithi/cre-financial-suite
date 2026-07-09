-- Enterprise hardening Phase 3 (part 2): narrow server-side consistency gate
-- for expense classification writes.
--
-- Scope note: this does NOT re-derive the lease-rule match/score itself
-- (src/services/expenseService.js::classifyExpenses is a ~2000-line
-- matching/scoring engine left client-side for this pass — see
-- docs/server-owned-workflow-pattern.md and the plan file for the full
-- rationale). What this RPC adds is what was completely missing: the
-- submitted classification is re-checked for internal consistency against
-- the expense and any linked lease_expense_rule before being persisted, and
-- every persist writes exactly one audit_logs row. A client could previously
-- write any combination of recovery_status/cam_eligible/cam_status directly.
--
-- Not a run-tracked "_workflow" (no idempotency-run table) — like the CAM
-- config saves, a classification persist is an idempotent upsert of current
-- derived state (one row per (org_id, expense_id)), not a one-time action
-- with duplicate-side-effect risk.
--
-- sent_to_cam is intentionally excluded from what this RPC can newly set:
-- that transition is exclusively owned by
-- send_expense_classification_to_cam_workflow (20260603110000). This RPC may
-- only carry forward an existing true value, never flip it from false to
-- true itself — otherwise the CAM-send gate could be bypassed by routing
-- through classification persistence instead.

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
  p_classification_patch JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_expense public.expenses%ROWTYPE;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_existing public.expense_classifications%ROWTYPE;
  v_after public.expense_classifications%ROWTYPE;
  v_patch JSONB := COALESCE(p_classification_patch, '{}'::jsonb);
  v_recovery_status TEXT := lower(COALESCE(p_recovery_status, p_recoverability_result, 'needs_review'));
  v_recoverability_result TEXT := COALESCE(p_recoverability_result, p_recovery_status);
  v_cam_eligible TEXT := lower(COALESCE(p_cam_eligible, ''));
  v_cam_status TEXT := lower(COALESCE(p_cam_status, ''));
  v_blockers TEXT[] := ARRAY[]::TEXT[];
  v_before JSONB;
  v_after_json JSONB;
  v_audit_log_id UUID;
  v_response JSONB;
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

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id AND org_id = p_org_id;
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
    NULLIF(v_patch->>'classification_key', ''),
    NULLIF(v_patch->>'category', ''),
    NULLIF(v_patch->>'subcategory', ''),
    NULLIF(v_patch->>'amount', '')::NUMERIC,
    NULLIF(v_patch->>'service_period_start', '')::DATE,
    NULLIF(v_patch->>'service_period_end', '')::DATE,
    v_recovery_status,
    v_recoverability_result,
    p_cam_eligible,
    p_cam_status,
    NULLIF(v_patch->>'cam_source', ''),
    COALESCE(NULLIF(v_patch->>'cam_input_type', ''), 'actual_expense'),
    NULLIF(v_patch->>'recovery_method', ''),
    NULLIF(v_patch->>'recovery_reason', ''),
    COALESCE(NULLIF(v_patch->>'allocation_method', ''), 'pro_rata'),
    COALESCE(NULLIF(v_patch->>'allocation_basis', ''), 'pro_rata'),
    COALESCE((v_patch->>'cap_applied')::BOOLEAN, false),
    COALESCE((v_patch->>'exclusion_applied')::BOOLEAN, false),
    COALESCE((v_patch->>'condition_applied')::BOOLEAN, false),
    NULLIF(v_patch->>'condition_reason', ''),
    COALESCE((v_patch->>'condition_resolved')::BOOLEAN, true),
    NULLIF(v_patch->>'condition_result', ''),
    NULLIF(v_patch->>'rule_source', ''),
    NULLIF(v_patch->>'confidence_score', '')::NUMERIC,
    NULLIF(v_patch->>'evidence_text', ''),
    NULLIF(v_patch->>'evidence_page_number', '')::INTEGER,
    COALESCE(NULLIF(v_patch->>'approved_status', ''), 'draft'),
    NULLIF(v_patch->>'classification_status', ''),
    NULLIF(v_patch->>'exception_type', ''),
    NULLIF(v_patch->>'finalized_at', '')::TIMESTAMPTZ,
    COALESCE((v_patch->>'recoverable_amount')::NUMERIC, 0),
    COALESCE((v_patch->>'non_recoverable_amount')::NUMERIC, 0),
    COALESCE((v_patch->>'conditional_amount')::NUMERIC, 0),
    COALESCE((v_patch->>'excluded_amount')::NUMERIC, 0),
    COALESCE(p_sent_to_cam, v_existing.sent_to_cam, false),
    v_existing.sent_to_cam_at,
    v_existing.sent_to_cam_by,
    NULLIF(v_patch->>'manual_cam_reason', ''),
    COALESCE((v_patch->>'manual_cam_reviewed')::BOOLEAN, v_existing.manual_cam_reviewed, false),
    NULLIF(v_patch->>'next_step', ''),
    NULLIF(v_patch->>'notes', ''),
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

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_after.property_id, 'ExpenseClassification', v_after.id::TEXT, 'expense_classification_persisted',
    p_actor_user_id, p_actor_email, 'info', 'edge_function',
    v_before, v_after_json,
    jsonb_build_object('expense_id', p_expense_id, 'linked_expense_rule_id', p_linked_expense_rule_id),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object('row', v_after_json, 'audit_log_id', v_audit_log_id);
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.persist_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.persist_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, UUID, BOOLEAN, JSONB
) TO authenticated, service_role;

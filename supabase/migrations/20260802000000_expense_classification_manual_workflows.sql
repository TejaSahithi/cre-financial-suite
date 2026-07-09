-- Enterprise hardening Phase 6X-6: server-own the remaining direct browser
-- writes to expense_classifications not covered by Phase 6X-1
-- (persist_expense_classification).
--
-- Investigation (confirmed via direct grep + schema inspection, not
-- assumed):
--   1. updateExpenseClassificationRecord (expenseService.js) has 3 live
--      call sites: expenseService.updateExpenseClassification()
--      (line ~1789, itself has ZERO live callers anywhere in src/ --
--      ExpenseReview.jsx now exclusively uses reviewExpenseClassification()
--      since Phase 6E-1/6E-2 -- dead code, left as-is, not deleted, since
--      deleting unrelated dead code is out of this phase's narrow scope),
--      createLeaseRuleAmountCamInput()'s update branch, and
--      markManualOverride(). Only the latter two are reachable from the UI.
--   2. createLeaseRuleAmountCamInput has exactly one live caller:
--      LeaseExpenseClassification.jsx's classificationAmountMutation.
--   3. markManualOverride has exactly one live caller:
--      LeaseExpenseClassification.jsx's manualOverrideMutation, itself
--      called only from promptForOverride() with a fixed 4-key payload
--      shape (override_reason, override_type, override_previous_value,
--      override_new_value).
--
-- A genuine, pre-existing bug was found and is fixed by this migration,
-- not just moved server-side: expense_classifications.expense_id is
-- NOT NULL, but createLeaseRuleAmountCamInput's "no existing row" branch
-- calls upsertExpenseClassification({...payload, expense_id: null,
-- actual_expense_id: null}) -- a genuine first-time INSERT attempt with a
-- NULL expense_id. compactDefined() (used internally) only strips
-- `undefined`, not `null`, so the NULL survives into the insert payload
-- and Postgres raises a not_null_violation (23502) -- a different error
-- class than the "missing column" errors upsertExpenseClassification's
-- retry loop is built to catch. The whole function body is wrapped in a
-- try/catch that swallows any error with a console.warn, so this has
-- likely NEVER successfully created a "rule_missing_actual" row: the UI
-- toasts "CAM rule amount saved" while nothing was persisted. Verified
-- empirically was not re-run here (would require a live mutating test,
-- out of scope) but confirmed by full code-path tracing plus direct
-- confirmation that no migration in this repo has ever made expense_id
-- nullable. User-approved fix: make expense_id nullable (matches
-- actual_expense_id, its sibling column, which was already nullable) --
-- see the ALTER TABLE below. No other write path is affected: every other
-- caller of this table (persist_expense_classification, create paths,
-- etc.) always supplies a real expense_id already.
--
-- Design: two new narrow sibling RPCs, per the task's explicit "Preferred
-- design" guidance -- neither reuses persist_expense_classification, since
-- neither is "classification persistence tied to a real expense" (the
-- consistency gate persist_expense_classification enforces has nothing to
-- validate against for either of these actions).
--
--   manual_override_expense_classification: markManualOverride's action.
--   Of markManualOverride's 4-key payload (override_reason, override_type,
--   override_previous_value, override_new_value), NONE of the
--   override_reason/override_type/override_previous_value/override_new_value/
--   manual_override/override_source columns exist on expense_classifications
--   at all (confirmed via direct schema query) -- every prior call to
--   updateExpenseClassificationRecord for this action has silently
--   stripped every one of these keys via its "missing column, retry"
--   loop, leaving only classification_status/reviewed_by/reviewed_at/
--   approved_by/approved_at/updated_at actually persisted. Rather than
--   silently keep dropping the override reason, or add speculative new
--   columns (out of this phase's narrow scope), this RPC captures the
--   override_reason/override_type/override_previous_value/
--   override_new_value in the audit_logs row's metadata instead -- the
--   mechanism that already exists for exactly this purpose -- so the
--   override's rationale finally has a durable, queryable home for the
--   first time, without broadening the table's schema or this RPC's
--   write surface.
--
--   save_lease_rule_amount_cam_input: createLeaseRuleAmountCamInput's two
--   write branches (update-existing-row, insert-new-row) unified into one
--   upsert-by-lock RPC, keyed on (org_id, lease_expense_rule_id,
--   row_type='rule_missing_actual') -- the same lookup the client already
--   performs today, just done under a row lock instead of a separate
--   check-then-act query. Of classificationPayload's ~30 keys, only 10
--   actually vary per call (classification_key, category, subcategory,
--   property_id, building_id, unit_id, lease_id, tenant_id, amount,
--   fiscal_year) -- every other field is a fixed constant for this one
--   narrow action every time it's called (recoverability_result is always
--   'recoverable', cam_eligible is always 'yes', cam_status is always
--   'cam_ready', manual_cam_reason is always the same fixed string, etc.)
--   so those are hardcoded server-side rather than accepted from the
--   client, narrowing the whitelist instead of mirroring the client's
--   full (mostly-constant) payload shape -- avoids "broadening this into
--   a generic expense_classifications update API" per explicit
--   instruction. published_to_cam=true is independently re-checked
--   server-side (mirrors persist_expense_classification's own
--   CAM-readiness consistency-gate style), since this write path has no
--   other gate at all otherwise (it never touches
--   persist_expense_classification, whose hasExpense-gated checks don't
--   apply here).
--
-- Not touched: the already-RPC-owned calls createLeaseRuleAmountCamInput
-- makes around the classification write (publishRuleToCamSetup,
-- update-lease-expense-rule-amount, sendExpenseClassificationToCam) --
-- only the classification persistence step itself moves here.

ALTER TABLE public.expense_classifications
  ALTER COLUMN expense_id DROP NOT NULL;

-- ============================================================
-- manual_override_expense_classification
-- ============================================================
CREATE OR REPLACE FUNCTION public.manual_override_expense_classification(
  p_org_id UUID,
  p_classification_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_override_reason TEXT,
  p_override_type TEXT,
  p_override_previous_value JSONB,
  p_override_new_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_classification public.expense_classifications%ROWTYPE;
  v_updated public.expense_classifications%ROWTYPE;
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
  IF NULLIF(trim(COALESCE(p_override_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'override_reason is required';
  END IF;

  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Classification not found for this organization';
  END IF;

  -- Idempotent no-op: only the persisted columns participate (the
  -- override reason/type/before/after are captured in audit metadata
  -- below, not as columns, so they can't be part of a DB-state
  -- comparison) -- matching every other RPC's "same final state = no
  -- write, no audit row" convention this session.
  IF v_classification.classification_status IS NOT DISTINCT FROM 'finalized'
     AND v_classification.reviewed_by IS NOT DISTINCT FROM p_actor_user_id
     AND v_classification.approved_by IS NOT DISTINCT FROM p_actor_user_id
  THEN
    RETURN jsonb_build_object(
      'classification', to_jsonb(v_classification),
      'changed', false
    );
  END IF;

  UPDATE public.expense_classifications SET
    classification_status = 'finalized',
    reviewed_by = p_actor_user_id,
    reviewed_at = v_now,
    approved_by = p_actor_user_id,
    approved_at = v_now,
    updated_at = v_now
   WHERE id = p_classification_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'ExpenseClassification', p_classification_id::TEXT,
    'expense_classification_manual_override', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_classification), to_jsonb(v_updated),
    jsonb_build_object(
      'override_reason', p_override_reason,
      'override_type', p_override_type,
      'override_previous_value', p_override_previous_value,
      'override_new_value', p_override_new_value
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object(
    'classification', to_jsonb(v_updated),
    'changed', true,
    'audit_log_id', v_audit_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.manual_override_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.manual_override_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, JSONB
) TO service_role;

-- ============================================================
-- save_lease_rule_amount_cam_input
-- ============================================================
CREATE OR REPLACE FUNCTION public.save_lease_rule_amount_cam_input(
  p_org_id UUID,
  p_rule_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_classification JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
$$;

REVOKE ALL ON FUNCTION public.save_lease_rule_amount_cam_input(
  UUID, UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_lease_rule_amount_cam_input(
  UUID, UUID, UUID, TEXT, JSONB
) TO service_role;

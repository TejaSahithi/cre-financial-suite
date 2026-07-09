-- Repair migration: creates cam_expense_inputs, expense_classification_cam_send_runs,
-- and send_expense_classification_to_cam_workflow RPC that failed to apply during
-- earlier migration runs (20260519120000, 20260525030000, 20260603110000).
-- All statements use IF NOT EXISTS / CREATE OR REPLACE so this is fully idempotent.

-- ── 1. Missing columns on expense_classifications ───────────────────────────
ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS linked_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cam_input_type TEXT,
  ADD COLUMN IF NOT EXISTS cam_source TEXT,
  ADD COLUMN IF NOT EXISTS manual_cam_reason TEXT,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS manual_cam_reviewed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS next_step TEXT,
  ADD COLUMN IF NOT EXISTS allocation_basis TEXT,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID;

-- ── 2. Missing columns on expenses (from 20260525030000) ────────────────────
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT,
  ADD COLUMN IF NOT EXISTS cam_pool_id UUID,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS cam_eligible TEXT,
  ADD COLUMN IF NOT EXISTS recovery_method TEXT,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS linked_expense_rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS recovery_meta JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS classification_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS classification_updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_status TEXT DEFAULT 'draft';

-- ── 3. audit_logs.workflow_run_id ───────────────────────────────────────────
ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS workflow_run_id UUID;

-- ── 4. cam_expense_inputs table (combined schema from 20260519+20260525) ────
CREATE TABLE IF NOT EXISTS public.cam_expense_inputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID,
  property_id UUID,
  building_id UUID,
  unit_id UUID,
  lease_id UUID,
  tenant_id UUID,
  actual_expense_id UUID,
  classification_result_id UUID,
  lease_expense_rule_id UUID,
  category TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  recovery_method TEXT,
  allocation_basis TEXT,
  source TEXT NOT NULL DEFAULT 'expense_classification',
  status TEXT NOT NULL DEFAULT 'pending_cam_review',
  cam_source TEXT,
  cam_input_type TEXT,
  manual_cam_reviewed BOOLEAN DEFAULT false,
  manual_cam_reason TEXT,
  fiscal_year INTEGER,
  sent_to_cam_at TIMESTAMPTZ,
  sent_to_cam_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_expense_inputs_classification
  ON public.cam_expense_inputs(classification_result_id)
  WHERE classification_result_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cam_expense_inputs_rule_amount
  ON public.cam_expense_inputs(lease_expense_rule_id, fiscal_year)
  WHERE lease_expense_rule_id IS NOT NULL
    AND fiscal_year IS NOT NULL
    AND cam_input_type = 'lease_rule_amount';

ALTER TABLE public.cam_expense_inputs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  EXECUTE 'DROP POLICY IF EXISTS "cam_expense_inputs_org_select" ON public.cam_expense_inputs';
  EXECUTE 'DROP POLICY IF EXISTS "cam_expense_inputs_org_write" ON public.cam_expense_inputs';
  EXECUTE $POL$
    CREATE POLICY "cam_expense_inputs_org_select"
      ON public.cam_expense_inputs FOR SELECT
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
  EXECUTE $POL$
    CREATE POLICY "cam_expense_inputs_org_write"
      ON public.cam_expense_inputs FOR ALL
      USING (
        public.is_super_admin()
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
      WITH CHECK (
        public.is_super_admin()
        OR org_id IS NULL
        OR org_id IN (SELECT m.org_id FROM public.memberships m WHERE m.user_id = auth.uid())
      )
  $POL$;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'cam_expense_inputs policies skipped: %', SQLERRM;
END $$;

-- ── 5. expense_classification_cam_send_runs table (from 20260603110000) ────
CREATE TABLE IF NOT EXISTS public.expense_classification_cam_send_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  classification_id UUID NOT NULL REFERENCES public.expense_classifications(id) ON DELETE CASCADE,
  expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL,
  rule_id UUID REFERENCES public.lease_expense_rules(id) ON DELETE SET NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started'
    CHECK (status IN ('started', 'completed', 'failed')),
  request_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  response_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  error_message TEXT,
  actor_user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  actor_email TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_expense_classification_cam_send_runs_classification
  ON public.expense_classification_cam_send_runs (org_id, classification_id, created_at DESC);

ALTER TABLE public.expense_classification_cam_send_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "expense_classification_cam_send_runs_select" ON public.expense_classification_cam_send_runs;
DROP POLICY IF EXISTS "expense_classification_cam_send_runs_insert" ON public.expense_classification_cam_send_runs;
DROP POLICY IF EXISTS "expense_classification_cam_send_runs_update" ON public.expense_classification_cam_send_runs;

CREATE POLICY "expense_classification_cam_send_runs_select" ON public.expense_classification_cam_send_runs
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "expense_classification_cam_send_runs_insert" ON public.expense_classification_cam_send_runs
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "expense_classification_cam_send_runs_update" ON public.expense_classification_cam_send_runs
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_expense_classification_cam_send_runs_updated_at ON public.expense_classification_cam_send_runs;
CREATE TRIGGER set_expense_classification_cam_send_runs_updated_at
  BEFORE UPDATE ON public.expense_classification_cam_send_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

-- ── 6. send_expense_classification_to_cam_workflow RPC (from 20260603110000)
CREATE OR REPLACE FUNCTION public.send_expense_classification_to_cam_workflow(
  p_org_id UUID,
  p_classification_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_reason TEXT,
  p_idempotency_key TEXT,
  p_request_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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

  v_is_automatic := (
    v_expense_id IS NOT NULL
    AND v_rule_id IS NOT NULL
    AND v_recoverability = 'recoverable'
    AND lower(COALESCE(v_classification.cam_eligible, '')) = 'yes'
    AND COALESCE(v_rule.published_to_cam, false) IS TRUE
    AND v_amount > 0
    AND COALESCE(v_classification.sent_to_cam, false) IS FALSE
    AND v_classification.sent_to_cam_at IS NULL
    AND lower(COALESCE(v_rule.payment_treatment, '')) NOT IN ('included_in_base_rent', 'tenant_direct_contract')
    AND COALESCE(v_rule.is_excluded, false) IS FALSE
  );

  IF COALESCE(v_classification.sent_to_cam, false) IS TRUE OR v_classification.sent_to_cam_at IS NOT NULL THEN
    v_already_sent := true;
    v_updated_classification := v_classification;
    SELECT id
      INTO v_cam_input_id
      FROM public.cam_expense_inputs
     WHERE classification_result_id = p_classification_id
     LIMIT 1;
  ELSE
    IF lower(COALESCE(v_classification.cam_eligible, '')) <> 'yes' THEN
      RAISE EXCEPTION 'Cannot send to CAM: classification is not CAM eligible';
    END IF;
    IF v_amount <= 0 THEN
      RAISE EXCEPTION 'Cannot send to CAM: classification amount must be greater than zero';
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
    IF NOT v_is_automatic AND v_manual_reason IS NULL THEN
      RAISE EXCEPTION 'reason is required for manual CAM send';
    END IF;

    v_cam_source := CASE
      WHEN lower(COALESCE(v_classification.cam_input_type, '')) = 'lease_rule_amount' THEN 'lease_rule_amount'
      WHEN v_is_automatic THEN 'lease_rule'
      ELSE 'manual_review'
    END;

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
      v_now
    )
    ON CONFLICT (classification_result_id)
    WHERE classification_result_id IS NOT NULL
    DO UPDATE SET
      org_id = EXCLUDED.org_id,
      property_id = EXCLUDED.property_id,
      building_id = EXCLUDED.building_id,
      unit_id = EXCLUDED.unit_id,
      lease_id = EXCLUDED.lease_id,
      tenant_id = EXCLUDED.tenant_id,
      actual_expense_id = EXCLUDED.actual_expense_id,
      lease_expense_rule_id = EXCLUDED.lease_expense_rule_id,
      category = EXCLUDED.category,
      amount = EXCLUDED.amount,
      recovery_method = EXCLUDED.recovery_method,
      allocation_basis = EXCLUDED.allocation_basis,
      source = EXCLUDED.source,
      status = EXCLUDED.status,
      cam_source = EXCLUDED.cam_source,
      cam_input_type = EXCLUDED.cam_input_type,
      manual_cam_reviewed = EXCLUDED.manual_cam_reviewed,
      manual_cam_reason = EXCLUDED.manual_cam_reason,
      fiscal_year = EXCLUDED.fiscal_year,
      sent_to_cam_at = EXCLUDED.sent_to_cam_at,
      sent_to_cam_by = EXCLUDED.sent_to_cam_by,
      updated_at = EXCLUDED.updated_at
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
        'automatic', v_is_automatic
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
$$;

REVOKE ALL ON FUNCTION public.send_expense_classification_to_cam_workflow(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.send_expense_classification_to_cam_workflow(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB
) TO authenticated, service_role;

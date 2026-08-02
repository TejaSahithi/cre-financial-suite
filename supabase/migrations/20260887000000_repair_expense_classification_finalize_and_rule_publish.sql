-- Repair live expense classification finalize/publish contract.
-- Adds the missing classified_by column required by persist_expense_classification
-- and reinstalls the server-owned lease expense rule CAM publish workflow.

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS classified_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.lease_expense_rule_cam_publish_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  rule_set_id UUID REFERENCES public.lease_expense_rule_sets(id) ON DELETE SET NULL,
  rule_id UUID NOT NULL REFERENCES public.lease_expense_rules(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'started' CHECK (status IN ('started', 'completed', 'failed')),
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

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_cam_publish_runs_rule
  ON public.lease_expense_rule_cam_publish_runs (org_id, rule_id, created_at DESC);

ALTER TABLE public.lease_expense_rule_cam_publish_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_expense_rule_cam_publish_runs_select" ON public.lease_expense_rule_cam_publish_runs;
DROP POLICY IF EXISTS "lease_expense_rule_cam_publish_runs_insert" ON public.lease_expense_rule_cam_publish_runs;
DROP POLICY IF EXISTS "lease_expense_rule_cam_publish_runs_update" ON public.lease_expense_rule_cam_publish_runs;

CREATE POLICY "lease_expense_rule_cam_publish_runs_select" ON public.lease_expense_rule_cam_publish_runs
  FOR SELECT USING (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "lease_expense_rule_cam_publish_runs_insert" ON public.lease_expense_rule_cam_publish_runs
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "lease_expense_rule_cam_publish_runs_update" ON public.lease_expense_rule_cam_publish_runs
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_expense_rule_cam_publish_runs_updated_at ON public.lease_expense_rule_cam_publish_runs;
CREATE TRIGGER set_lease_expense_rule_cam_publish_runs_updated_at
  BEFORE UPDATE ON public.lease_expense_rule_cam_publish_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE OR REPLACE FUNCTION public.publish_lease_expense_rule_to_cam_workflow(
  p_org_id UUID,
  p_rule_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
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
  v_run public.lease_expense_rule_cam_publish_runs%ROWTYPE;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_rule_set public.lease_expense_rule_sets%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_updated_rule public.lease_expense_rules%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_audit_log_id UUID;
  v_response JSONB;
  v_already_published BOOLEAN := false;
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
  IF NULLIF(trim(COALESCE(p_idempotency_key, '')), '') IS NULL THEN
    RAISE EXCEPTION 'idempotency_key is required';
  END IF;

  SELECT r.*
    INTO v_rule
    FROM public.lease_expense_rules r
    JOIN public.lease_expense_rule_sets rs ON rs.id = r.rule_set_id
   WHERE r.id = p_rule_id
     AND COALESCE(r.org_id, rs.org_id) = p_org_id
   FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this organization';
  END IF;

  SELECT *
    INTO v_rule_set
    FROM public.lease_expense_rule_sets
   WHERE id = v_rule.rule_set_id
     AND org_id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule set not found for this organization';
  END IF;

  SELECT *
    INTO v_lease
    FROM public.leases
   WHERE id = COALESCE(v_rule.lease_id, v_rule_set.lease_id)
     AND org_id = p_org_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  INSERT INTO public.lease_expense_rule_cam_publish_runs (
    org_id, lease_id, rule_set_id, rule_id, idempotency_key,
    request_payload, actor_user_id, actor_email
  )
  VALUES (
    p_org_id, v_lease.id, v_rule_set.id, p_rule_id, p_idempotency_key,
    COALESCE(p_request_payload, '{}'::jsonb), p_actor_user_id, p_actor_email
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  SELECT *
    INTO v_run
    FROM public.lease_expense_rule_cam_publish_runs
   WHERE org_id = p_org_id
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF v_run.rule_id IS DISTINCT FROM p_rule_id THEN
    RAISE EXCEPTION 'idempotency_key reused for a different CAM publish workflow';
  END IF;
  IF v_run.request_payload IS DISTINCT FROM COALESCE(p_request_payload, '{}'::jsonb) THEN
    RAISE EXCEPTION 'idempotency_key reused with a different request payload';
  END IF;
  IF v_run.status = 'completed' AND v_run.response_payload <> '{}'::jsonb THEN
    RETURN v_run.response_payload;
  END IF;

  IF v_rule.published_to_cam IS TRUE THEN
    v_already_published := true;
    v_updated_rule := v_rule;
  ELSE
    IF NOT (
      lower(COALESCE(v_rule.approval_status, '')) = 'approved'
      AND lower(COALESCE(v_rule.review_status, '')) IN ('approved', 'reviewed')
    ) THEN
      RAISE EXCEPTION 'Only approved lease expense rules can be published to CAM';
    END IF;
    IF lower(COALESCE(v_rule.recoverable_from_tenant, '')) <> 'yes' THEN
      RAISE EXCEPTION 'Only recoverable lease expense rules can be published to CAM';
    END IF;
    IF lower(COALESCE(v_rule.cam_eligible, '')) <> 'yes' THEN
      RAISE EXCEPTION 'Only CAM-eligible lease expense rules can be published to CAM';
    END IF;
    IF COALESCE(v_rule.included_in_base_rent, false) IS TRUE
      OR lower(COALESCE(v_rule.payment_treatment, '')) = 'included_in_base_rent'
      OR lower(COALESCE(v_rule.payment_treatment, '')) = 'tenant_direct_contract'
      OR COALESCE(v_rule.is_excluded, false) IS TRUE
      OR lower(COALESCE(v_rule.row_status, v_rule.extraction_status, '')) IN ('unmapped', 'not_found', 'not_mentioned', 'not_applicable', 'rejected')
    THEN
      RAISE EXCEPTION 'Excluded, tenant-direct, included-in-rent, or not-applicable rules cannot be published to CAM';
    END IF;
    IF NULLIF(trim(COALESCE(v_rule.exact_source_text, v_rule.source, '')), '') IS NULL
      AND NULLIF(trim(COALESCE(v_rule.notes, '')), '') IS NULL
    THEN
      RAISE EXCEPTION 'Missing lease evidence for CAM publication';
    END IF;

    v_before := jsonb_build_object(
      'approval_status', v_rule.approval_status,
      'review_status', v_rule.review_status,
      'recoverable_from_tenant', v_rule.recoverable_from_tenant,
      'cam_eligible', v_rule.cam_eligible,
      'payment_treatment', v_rule.payment_treatment,
      'published_to_cam', v_rule.published_to_cam
    );

    UPDATE public.lease_expense_rules
       SET org_id = COALESCE(org_id, p_org_id),
           lease_id = COALESCE(lease_id, v_lease.id),
           property_id = COALESCE(property_id, v_lease.property_id),
           building_id = COALESCE(building_id, v_lease.building_id),
           unit_id = COALESCE(unit_id, v_lease.unit_id),
           tenant_id = COALESCE(tenant_id, v_lease.tenant_id),
           published_to_cam = true,
           updated_at = v_now
     WHERE id = p_rule_id
     RETURNING * INTO v_updated_rule;

    v_after := jsonb_build_object(
      'approval_status', v_updated_rule.approval_status,
      'review_status', v_updated_rule.review_status,
      'recoverable_from_tenant', v_updated_rule.recoverable_from_tenant,
      'cam_eligible', v_updated_rule.cam_eligible,
      'payment_treatment', v_updated_rule.payment_treatment,
      'published_to_cam', v_updated_rule.published_to_cam
    );

    INSERT INTO public.audit_logs (
      org_id, entity_type, entity_id, action, field_changed, old_value, new_value,
      actor_user_id, actor_email, severity, source, workflow_run_id,
      before, after, metadata, property_id, "timestamp"
    )
    VALUES (
      p_org_id, 'LeaseExpenseRule', p_rule_id::TEXT, 'publish_rule_to_cam',
      'published_to_cam', COALESCE(v_before->>'published_to_cam', 'false'), 'true',
      p_actor_user_id, p_actor_email, 'info', 'edge_function', v_run.id,
      v_before, v_after,
      jsonb_build_object('workflow_run_id', v_run.id, 'idempotency_key', p_idempotency_key),
      v_lease.property_id, v_now
    )
    RETURNING id INTO v_audit_log_id;
  END IF;

  v_response := jsonb_build_object(
    'rule', to_jsonb(v_updated_rule),
    'rule_set_id', v_rule_set.id,
    'lease_id', v_lease.id,
    'workflow_run_id', v_run.id,
    'audit_log_id', v_audit_log_id,
    'notification_id', NULL,
    'already_published', v_already_published
  );

  UPDATE public.lease_expense_rule_cam_publish_runs
     SET status = 'completed',
         response_payload = v_response,
         completed_at = v_now,
         error_message = NULL
   WHERE id = v_run.id;

  RETURN v_response;
EXCEPTION WHEN OTHERS THEN
  IF v_run.id IS NOT NULL THEN
    UPDATE public.lease_expense_rule_cam_publish_runs
       SET status = 'failed',
           error_message = SQLERRM,
           updated_at = now()
     WHERE id = v_run.id;
  END IF;
  RAISE;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_lease_expense_rule_to_cam_workflow(
  UUID, UUID, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.publish_lease_expense_rule_to_cam_workflow(
  UUID, UUID, UUID, TEXT, TEXT, JSONB
) TO service_role;

NOTIFY pgrst, 'reload schema';

-- Hardening Sprint 2 Phase 2: server-owned lease expense rule review.
-- Additive only: idempotent workflow runs, defensive rule columns, and one
-- transactional RPC for approve/reject/not-applicable rule review actions.

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS org_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;

ALTER TABLE public.audit_logs
  ADD COLUMN IF NOT EXISTS workflow_run_id UUID;

CREATE TABLE IF NOT EXISTS public.lease_expense_rule_workflow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  rule_set_id UUID REFERENCES public.lease_expense_rule_sets(id) ON DELETE SET NULL,
  rule_id UUID NOT NULL REFERENCES public.lease_expense_rules(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'not_applicable')),
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

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_workflow_runs_rule
  ON public.lease_expense_rule_workflow_runs (org_id, rule_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_workflow_runs_rule_set
  ON public.lease_expense_rule_workflow_runs (org_id, rule_set_id, created_at DESC);

ALTER TABLE public.lease_expense_rule_workflow_runs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_expense_rule_workflow_runs_select" ON public.lease_expense_rule_workflow_runs;
DROP POLICY IF EXISTS "lease_expense_rule_workflow_runs_insert" ON public.lease_expense_rule_workflow_runs;
DROP POLICY IF EXISTS "lease_expense_rule_workflow_runs_update" ON public.lease_expense_rule_workflow_runs;

CREATE POLICY "lease_expense_rule_workflow_runs_select" ON public.lease_expense_rule_workflow_runs
  FOR SELECT USING (public.is_super_admin() OR org_id IN (SELECT public.get_my_org_ids()));

CREATE POLICY "lease_expense_rule_workflow_runs_insert" ON public.lease_expense_rule_workflow_runs
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));

CREATE POLICY "lease_expense_rule_workflow_runs_update" ON public.lease_expense_rule_workflow_runs
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

DROP TRIGGER IF EXISTS set_lease_expense_rule_workflow_runs_updated_at ON public.lease_expense_rule_workflow_runs;
CREATE TRIGGER set_lease_expense_rule_workflow_runs_updated_at
  BEFORE UPDATE ON public.lease_expense_rule_workflow_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_workflow_updated_at();

CREATE OR REPLACE FUNCTION public.review_lease_expense_rule_workflow(
  p_org_id UUID,
  p_rule_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_action TEXT,
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
  v_action TEXT := lower(trim(COALESCE(p_action, '')));
  v_run public.lease_expense_rule_workflow_runs%ROWTYPE;
  v_rule public.lease_expense_rules%ROWTYPE;
  v_rule_set public.lease_expense_rule_sets%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_updated_rule public.lease_expense_rules%ROWTYPE;
  v_before JSONB;
  v_after JSONB;
  v_audit_log_id UUID;
  v_notification_id UUID;
  v_next_rule_set_status TEXT;
  v_response JSONB;
  v_already_reviewed BOOLEAN := false;
  v_notification_title TEXT;
  v_notification_message TEXT;
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
  IF v_action NOT IN ('approve', 'reject', 'not_applicable') THEN
    RAISE EXCEPTION 'action must be approve, reject, or not_applicable';
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
     AND org_id = p_org_id
   FOR UPDATE;

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

  INSERT INTO public.lease_expense_rule_workflow_runs (
    org_id,
    lease_id,
    rule_set_id,
    rule_id,
    action,
    idempotency_key,
    request_payload,
    actor_user_id,
    actor_email
  )
  VALUES (
    p_org_id,
    v_lease.id,
    v_rule_set.id,
    p_rule_id,
    v_action,
    p_idempotency_key,
    COALESCE(p_request_payload, '{}'::jsonb),
    p_actor_user_id,
    p_actor_email
  )
  ON CONFLICT (org_id, idempotency_key) DO NOTHING;

  SELECT *
    INTO v_run
    FROM public.lease_expense_rule_workflow_runs
   WHERE org_id = p_org_id
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF v_run.rule_id IS DISTINCT FROM p_rule_id OR v_run.action IS DISTINCT FROM v_action THEN
    RAISE EXCEPTION 'idempotency_key reused for a different rule workflow';
  END IF;

  IF v_run.request_payload IS DISTINCT FROM COALESCE(p_request_payload, '{}'::jsonb) THEN
    RAISE EXCEPTION 'idempotency_key reused with a different request payload';
  END IF;

  IF v_run.status = 'completed' AND v_run.response_payload <> '{}'::jsonb THEN
    RETURN v_run.response_payload;
  END IF;

  v_before := jsonb_build_object(
    'row_status', v_rule.row_status,
    'review_status', v_rule.review_status,
    'approval_status', v_rule.approval_status,
    'approved_by', v_rule.approved_by,
    'approved_at', v_rule.approved_at,
    'recoverable_from_tenant', v_rule.recoverable_from_tenant,
    'cam_eligible', v_rule.cam_eligible,
    'payment_treatment', v_rule.payment_treatment,
    'recovery_method', v_rule.recovery_method,
    'allocation_basis', v_rule.allocation_basis,
    'published_to_cam', v_rule.published_to_cam,
    'is_recoverable', v_rule.is_recoverable,
    'is_excluded', v_rule.is_excluded
  );

  IF v_action = 'approve' AND lower(COALESCE(v_rule.review_status, '')) IN ('approved', 'reviewed') AND lower(COALESCE(v_rule.approval_status, '')) = 'approved' THEN
    v_already_reviewed := true;
    v_updated_rule := v_rule;
  ELSIF v_action = 'reject' AND lower(COALESCE(v_rule.review_status, '')) = 'rejected' AND lower(COALESCE(v_rule.approval_status, '')) = 'rejected' THEN
    v_already_reviewed := true;
    v_updated_rule := v_rule;
  ELSIF v_action = 'not_applicable' AND lower(COALESCE(v_rule.approval_status, '')) = 'approved' AND lower(COALESCE(v_rule.row_status, '')) IN ('unmapped', 'not_applicable', 'not_found', 'not_mentioned') THEN
    v_already_reviewed := true;
    v_updated_rule := v_rule;
  ELSE
    IF v_action = 'approve' THEN
      UPDATE public.lease_expense_rules
         SET org_id = COALESCE(org_id, p_org_id),
             lease_id = COALESCE(lease_id, v_lease.id),
             property_id = COALESCE(property_id, v_lease.property_id),
             building_id = COALESCE(building_id, v_lease.building_id),
             unit_id = COALESCE(unit_id, v_lease.unit_id),
             tenant_id = COALESCE(tenant_id, v_lease.tenant_id),
             review_status = 'approved',
             approval_status = 'approved',
             approved_by = p_actor_user_id,
             approved_at = v_now,
             updated_at = v_now
       WHERE id = p_rule_id
       RETURNING * INTO v_updated_rule;
    ELSIF v_action = 'reject' THEN
      UPDATE public.lease_expense_rules
         SET org_id = COALESCE(org_id, p_org_id),
             lease_id = COALESCE(lease_id, v_lease.id),
             property_id = COALESCE(property_id, v_lease.property_id),
             building_id = COALESCE(building_id, v_lease.building_id),
             unit_id = COALESCE(unit_id, v_lease.unit_id),
             tenant_id = COALESCE(tenant_id, v_lease.tenant_id),
             row_status = 'rejected',
             review_status = 'rejected',
             approval_status = 'rejected',
             approved_by = NULL,
             approved_at = NULL,
             recoverable_from_tenant = 'no',
             cam_eligible = 'no',
             published_to_cam = false,
             recovery_method = 'not_applicable',
             allocation_basis = NULL,
             is_recoverable = false,
             is_excluded = true,
             updated_at = v_now
       WHERE id = p_rule_id
       RETURNING * INTO v_updated_rule;
    ELSE
      UPDATE public.lease_expense_rules
         SET org_id = COALESCE(org_id, p_org_id),
             lease_id = COALESCE(lease_id, v_lease.id),
             property_id = COALESCE(property_id, v_lease.property_id),
             building_id = COALESCE(building_id, v_lease.building_id),
             unit_id = COALESCE(unit_id, v_lease.unit_id),
             tenant_id = COALESCE(tenant_id, v_lease.tenant_id),
             row_status = 'unmapped',
             review_status = 'approved',
             approval_status = 'approved',
             approved_by = p_actor_user_id,
             approved_at = v_now,
             payment_treatment = CASE
               WHEN included_in_base_rent IS TRUE THEN 'included_in_base_rent'
               ELSE 'not_applicable'
             END,
             recoverable_from_tenant = 'no',
             cam_eligible = 'no',
             published_to_cam = false,
             recovery_method = CASE
               WHEN included_in_base_rent IS TRUE THEN 'included_in_base_rent'
               ELSE 'not_applicable'
             END,
             allocation_basis = NULL,
             is_recoverable = false,
             is_excluded = true,
             updated_at = v_now
       WHERE id = p_rule_id
       RETURNING * INTO v_updated_rule;
    END IF;
  END IF;

  WITH active_rules AS (
    SELECT *
      FROM public.lease_expense_rules
     WHERE rule_set_id = v_rule_set.id
       AND lower(COALESCE(row_status, extraction_status, '')) NOT IN ('archived', 'deleted', 'void', 'voided', 'superseded')
  ),
  status_rollup AS (
    SELECT
      COUNT(*) AS total_count,
      COUNT(*) FILTER (
        WHERE (
          lower(COALESCE(approval_status, '')) = 'approved'
          AND lower(COALESCE(review_status, '')) IN ('approved', 'reviewed')
        )
        OR lower(COALESCE(approval_status, '')) = 'rejected'
        OR lower(COALESCE(review_status, '')) = 'rejected'
        OR lower(COALESCE(row_status, extraction_status, '')) IN ('unmapped', 'not_found', 'not_mentioned', 'not_applicable', 'na', 'n/a')
      ) AS resolved_count,
      COUNT(*) FILTER (
        WHERE lower(COALESCE(review_status, '')) = 'needs_review'
           OR lower(COALESCE(approval_status, '')) = 'needs_review'
           OR lower(COALESCE(row_status, extraction_status, '')) IN ('needs_review', 'uncertain', 'missing_value')
      ) AS needs_review_count
    FROM active_rules
  )
  SELECT CASE
      WHEN total_count = 0 THEN 'draft'
      WHEN total_count = resolved_count THEN 'approved'
      WHEN needs_review_count > 0 THEN 'needs_review'
      ELSE 'draft'
    END
    INTO v_next_rule_set_status
    FROM status_rollup;

  UPDATE public.lease_expense_rule_sets
     SET status = COALESCE(v_next_rule_set_status, 'draft'),
         approved_by = CASE WHEN v_next_rule_set_status = 'approved' THEN p_actor_user_id ELSE NULL END,
         approved_at = CASE WHEN v_next_rule_set_status = 'approved' THEN COALESCE(approved_at, v_now) ELSE NULL END,
         updated_at = v_now
   WHERE id = v_rule_set.id;

  v_after := jsonb_build_object(
    'row_status', v_updated_rule.row_status,
    'review_status', v_updated_rule.review_status,
    'approval_status', v_updated_rule.approval_status,
    'approved_by', v_updated_rule.approved_by,
    'approved_at', v_updated_rule.approved_at,
    'recoverable_from_tenant', v_updated_rule.recoverable_from_tenant,
    'cam_eligible', v_updated_rule.cam_eligible,
    'payment_treatment', v_updated_rule.payment_treatment,
    'recovery_method', v_updated_rule.recovery_method,
    'allocation_basis', v_updated_rule.allocation_basis,
    'published_to_cam', v_updated_rule.published_to_cam,
    'is_recoverable', v_updated_rule.is_recoverable,
    'is_excluded', v_updated_rule.is_excluded
  );

  IF NOT v_already_reviewed THEN
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
      'LeaseExpenseRule',
      p_rule_id::TEXT,
      CASE
        WHEN v_action = 'approve' THEN 'approve_rule'
        WHEN v_action = 'reject' THEN 'reject_rule'
        ELSE 'mark_rule_not_applicable'
      END,
      'approval_status',
      COALESCE(v_before->>'approval_status', v_before->>'review_status'),
      COALESCE(v_after->>'approval_status', v_after->>'review_status'),
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
        'action', v_action,
        'reason', NULLIF(trim(COALESCE(p_reason, '')), ''),
        'before_status', v_before,
        'after_status', v_after
      ),
      v_lease.property_id
    )
    RETURNING id INTO v_audit_log_id;

    v_notification_title := CASE
      WHEN v_action = 'approve' THEN 'Lease expense rule approved'
      WHEN v_action = 'reject' THEN 'Lease expense rule rejected'
      ELSE 'Lease expense rule marked not applicable'
    END;
    v_notification_message := CASE
      WHEN v_action = 'approve' THEN 'A lease expense rule was approved for downstream review.'
      WHEN v_action = 'reject' THEN 'A lease expense rule was rejected and removed from CAM eligibility.'
      ELSE 'A lease expense rule was marked not applicable and removed from CAM eligibility.'
    END;

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
      v_notification_title,
      v_notification_message,
      '/LeaseExpenseRules?lease=' || v_lease.id::TEXT,
      'normal'
    )
    RETURNING id INTO v_notification_id;
  END IF;

  v_response := jsonb_build_object(
    'rule', to_jsonb(v_updated_rule),
    'rule_set_id', v_rule_set.id,
    'lease_id', v_lease.id,
    'workflow_run_id', v_run.id,
    'audit_log_id', v_audit_log_id,
    'notification_id', v_notification_id,
    'rule_set_status', COALESCE(v_next_rule_set_status, v_rule_set.status),
    'already_reviewed', v_already_reviewed
  );

  UPDATE public.lease_expense_rule_workflow_runs
     SET status = 'completed',
         response_payload = v_response,
         completed_at = v_now,
         error_message = NULL
   WHERE id = v_run.id;

  RETURN v_response;
EXCEPTION WHEN OTHERS THEN
  IF v_run.id IS NOT NULL THEN
    UPDATE public.lease_expense_rule_workflow_runs
       SET status = 'failed',
           error_message = SQLERRM
     WHERE id = v_run.id;
  END IF;
  RAISE;
END;
$$;

GRANT EXECUTE ON FUNCTION public.review_lease_expense_rule_workflow(
  UUID,
  UUID,
  UUID,
  TEXT,
  TEXT,
  TEXT,
  TEXT,
  JSONB
) TO authenticated, service_role;

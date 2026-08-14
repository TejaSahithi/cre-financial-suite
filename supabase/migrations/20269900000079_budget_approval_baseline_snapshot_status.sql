-- Budget approval baselines are audit/variance evidence, not completed
-- calculation outputs. The completed-snapshot unique index is scoped to
-- authoritative engine calculation series; leaving approve_and_lock_budget's
-- scope-less baseline rows at the default status='completed' makes concurrent
-- approvals for sibling building/unit budgets collide on the null-scope series.
--
-- Preserve the existing separation from generation lineage by keeping the
-- baseline row scope-less, but write it with a non-completed status so it does
-- not compete with authoritative budget computation snapshots.
CREATE OR REPLACE FUNCTION public.approve_and_lock_budget(
  p_budget_id UUID,
  p_org_id UUID,
  p_user_id UUID,
  p_expected_updated_at TIMESTAMPTZ,
  p_approval_comment TEXT DEFAULT NULL,
  p_expected_basis_snapshot_id UUID DEFAULT NULL,
  p_expected_cam_snapshot_id UUID DEFAULT NULL,
  p_expected_revenue_snapshot_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_budget RECORD;
  v_membership RECORD;
  v_latest_snapshot RECORD;
  v_source_snapshots JSONB;
  v_basis_id UUID;
  v_cam_id UUID;
  v_rev_id UUID;
  v_computed_hash TEXT;
  v_now TIMESTAMPTZ := now();
BEGIN
  SELECT * INTO v_budget
  FROM public.budgets
  WHERE id = p_budget_id AND org_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found or belongs to a different organization.';
  END IF;

  IF v_budget.status = 'locked' THEN
    RAISE EXCEPTION 'Budget is already locked and cannot be approved again.';
  END IF;

  IF v_budget.status IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Budget status must be ''reviewed'' to approve and lock. Current status: ''%''', v_budget.status;
  END IF;

  SELECT role, status INTO v_membership
  FROM public.memberships
  WHERE user_id = p_user_id
    AND org_id = p_org_id
    AND COALESCE(status, 'active') IN ('active', 'owner')
  LIMIT 1;

  IF v_membership.role IS NULL OR v_membership.role NOT IN ('owner', 'org_admin', 'super_admin') THEN
    RAISE EXCEPTION 'Unauthorized: Final budget approval requires Owner or Org Admin authority. Caller role: ''%''', COALESCE(v_membership.role, 'none');
  END IF;

  IF p_expected_updated_at IS NOT NULL AND date_trunc('milliseconds', v_budget.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Stale version error: The budget was modified after you reviewed it. Persisted updated_at is %, expected %.', v_budget.updated_at, p_expected_updated_at;
  END IF;

  SELECT * INTO v_latest_snapshot
  FROM public.computation_snapshots
  WHERE org_id = p_org_id
    AND engine_type = 'budget'
    AND fiscal_year = v_budget.budget_year
    AND (
      (scope_level = v_budget.scope AND scope_id = v_budget.scope_id)
      OR (inputs->>'scope_level' = v_budget.scope AND inputs->>'scope_id' = v_budget.scope_id::text)
      OR (v_budget.scope = 'property' AND scope_level IS NULL AND scope_id IS NULL AND property_id = v_budget.property_id)
    )
  ORDER BY computed_at DESC
  LIMIT 1;

  IF v_latest_snapshot.id IS NOT NULL THEN
    v_source_snapshots := v_latest_snapshot.inputs->'_compute'->'source_snapshot_ids';
    v_basis_id := (v_source_snapshots->>'budget_basis')::uuid;
    v_cam_id := (v_source_snapshots->>'budget_cam_estimate')::uuid;
    v_rev_id := (v_source_snapshots->>'revenue')::uuid;

    IF p_expected_basis_snapshot_id IS NOT NULL AND v_basis_id IS DISTINCT FROM p_expected_basis_snapshot_id THEN
      RAISE EXCEPTION 'Stale lineage error: Expense basis snapshot has changed since review.';
    END IF;
    IF p_expected_cam_snapshot_id IS NOT NULL AND v_cam_id IS DISTINCT FROM p_expected_cam_snapshot_id THEN
      RAISE EXCEPTION 'Stale lineage error: CAM estimate snapshot has changed since review.';
    END IF;
    IF p_expected_revenue_snapshot_id IS NOT NULL AND v_rev_id IS DISTINCT FROM p_expected_revenue_snapshot_id THEN
      RAISE EXCEPTION 'Stale lineage error: Revenue snapshot has changed since review.';
    END IF;
  END IF;

  v_computed_hash := md5(concat_ws(':', v_budget.id::text, v_budget.total_revenue::text, v_budget.total_expenses::text, v_budget.noi::text, v_budget.cam_total::text, COALESCE(v_basis_id::text, ''), COALESCE(v_cam_id::text, ''), COALESCE(v_rev_id::text, '')));

  UPDATE public.budgets
  SET
    status = 'locked',
    approved_at = v_now,
    approved_by = p_user_id,
    approved_by_role = v_membership.role,
    approval_comment = p_approval_comment,
    locked_at = v_now,
    locked_by = p_user_id,
    version_hash = v_computed_hash,
    updated_at = v_now
  WHERE id = p_budget_id;

  INSERT INTO public.computation_snapshots (
    org_id,
    property_id,
    engine_type,
    fiscal_year,
    status,
    computed_by,
    inputs,
    outputs,
    computed_at
  ) VALUES (
    p_org_id,
    v_budget.property_id,
    'budget',
    v_budget.budget_year,
    'approval_baseline',
    p_user_id::text,
    jsonb_build_object(
      'scope_level', v_budget.scope,
      'scope_id', v_budget.scope_id,
      'fiscal_year', v_budget.budget_year,
      'action', 'approve_and_lock',
      'approved_at', v_now,
      'approved_by', p_user_id,
      'approved_by_role', v_membership.role,
      'locked_at', v_now,
      'locked_by', p_user_id,
      'version_hash', v_computed_hash,
      'approval_comment', p_approval_comment
    ),
    jsonb_build_object(
      'budget_id', v_budget.id,
      'status', 'locked',
      'baseline', true,
      'total_revenue', v_budget.total_revenue,
      'total_expenses', v_budget.total_expenses,
      'noi', v_budget.noi,
      'cam_total', v_budget.cam_total,
      'version_hash', v_computed_hash
    ),
    v_now
  );

  INSERT INTO public.audit_logs (
    org_id,
    property_id,
    entity_type,
    entity_id,
    action,
    actor_user_id,
    source,
    severity,
    metadata
  ) VALUES (
    p_org_id,
    v_budget.property_id,
    'Budget',
    v_budget.id::text,
    'budget_approved_and_locked',
    p_user_id,
    'rpc',
    'info',
    jsonb_build_object(
      'fiscal_year', v_budget.budget_year,
      'total_revenue', v_budget.total_revenue,
      'total_expenses', v_budget.total_expenses,
      'noi', v_budget.noi,
      'cam_total', v_budget.cam_total,
      'approved_at', v_now,
      'approved_by', p_user_id,
      'approved_by_role', v_membership.role,
      'approval_comment', p_approval_comment,
      'version_hash', v_computed_hash
    )
  );

  RETURN jsonb_build_object(
    'error', false,
    'budget_id', v_budget.id,
    'status', 'locked',
    'approved_at', v_now,
    'approved_by', p_user_id,
    'approved_by_role', v_membership.role,
    'locked_at', v_now,
    'version_hash', v_computed_hash,
    'message', 'Budget approved and locked successfully'
  );
END;
$$;

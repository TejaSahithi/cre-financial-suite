-- Migration: 20260904000000_budget_approval_signoff.sql
-- Description: Phase 4B Enterprise Budget Approval, Sign-Off, and Lock
-- Provides:
--   1. Additive persistence columns on public.budgets (approved_at, approved_by, approved_by_role, approval_comment, locked_at, locked_by, version_hash)
--   2. Transactional SECURITY DEFINER RPC public.approve_and_lock_budget for atomic FOR UPDATE row locking, stale-version validation, role authority check, frozen role-at-approval capture, and status transition to 'locked'.
--   3. Database-level immutability triggers blocking UPDATE/DELETE on locked budgets and budget_line_items.

-- 1. Additive columns on public.budgets
ALTER TABLE public.budgets
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by_role TEXT,
  ADD COLUMN IF NOT EXISTS approval_comment TEXT,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS version_hash TEXT;

-- 2. Transactional RPC for atomic Approve + Sign + Lock
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
  -- A. Lock target budget row FOR UPDATE to prevent race conditions / concurrent approvals
  SELECT * INTO v_budget
  FROM public.budgets
  WHERE id = p_budget_id AND org_id = p_org_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Budget not found or belongs to a different organization.';
  END IF;

  -- B. Check status precondition: must be 'reviewed'
  IF v_budget.status = 'locked' THEN
    RAISE EXCEPTION 'Budget is already locked and cannot be approved again.';
  END IF;

  IF v_budget.status IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Budget status must be ''reviewed'' to approve and lock. Current status: ''%''', v_budget.status;
  END IF;

  -- C. Validate User Signer Authority (Owner OR Org Admin required) and capture exact role-at-approval
  SELECT role, status INTO v_membership
  FROM public.memberships
  WHERE user_id = p_user_id
    AND org_id = p_org_id
    AND COALESCE(status, 'active') IN ('active', 'owner')
  LIMIT 1;

  IF v_membership.role IS NULL OR v_membership.role NOT IN ('owner', 'org_admin', 'super_admin') THEN
    RAISE EXCEPTION 'Unauthorized: Final budget approval requires Owner or Org Admin authority. Caller role: ''%''', COALESCE(v_membership.role, 'none');
  END IF;

  -- D. True Stale-Version Protection: compare expected_updated_at
  IF p_expected_updated_at IS NOT NULL AND date_trunc('milliseconds', v_budget.updated_at) <> date_trunc('milliseconds', p_expected_updated_at) THEN
    RAISE EXCEPTION 'Stale version error: The budget was modified after you reviewed it. Persisted updated_at is %, expected %.', v_budget.updated_at, p_expected_updated_at;
  END IF;

  -- E. Validate Source Snapshot Lineage against computation_snapshots
  SELECT * INTO v_latest_snapshot
  FROM public.computation_snapshots
  WHERE org_id = p_org_id
    AND engine_type = 'budget'
    AND fiscal_year = v_budget.budget_year
    AND (inputs->>'scope_id' = v_budget.scope_id OR property_id = v_budget.property_id)
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

  -- F. Compute deterministic version hash
  v_computed_hash := md5(concat_ws(':', v_budget.id::text, v_budget.total_revenue::text, v_budget.total_expenses::text, v_budget.noi::text, v_budget.cam_total::text, COALESCE(v_basis_id::text, ''), COALESCE(v_cam_id::text, ''), COALESCE(v_rev_id::text, '')));

  -- G. Perform Atomic State Transition to 'locked', persisting frozen role-at-approval
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

  -- H. Persist Baseline Snapshot
  INSERT INTO public.computation_snapshots (
    org_id,
    property_id,
    engine_type,
    fiscal_year,
    computed_by,
    inputs,
    outputs,
    computed_at
  ) VALUES (
    p_org_id,
    v_budget.property_id,
    'budget',
    v_budget.budget_year,
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

  -- I. Audit Log Entry
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

-- 3. Database Immutability Triggers

-- Trigger function to prevent mutation of locked budgets
CREATE OR REPLACE FUNCTION public.fn_protect_locked_budget()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'locked' THEN
    -- Allow updating metadata fields (like updated_at or audit logs if needed), but block financial changes or status regression
    IF (NEW.total_revenue IS DISTINCT FROM OLD.total_revenue OR
        NEW.total_expenses IS DISTINCT FROM OLD.total_expenses OR
        NEW.noi IS DISTINCT FROM OLD.noi OR
        NEW.cam_total IS DISTINCT FROM OLD.cam_total OR
        NEW.budget_year IS DISTINCT FROM OLD.budget_year OR
        NEW.scope_id IS DISTINCT FROM OLD.scope_id) THEN
      RAISE EXCEPTION 'Cannot modify financial values of a locked budget (id: %). Create a new version instead.', OLD.id;
    END IF;

    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'Cannot delete a locked budget (id: %).', OLD.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_locked_budget ON public.budgets;
CREATE TRIGGER trg_protect_locked_budget
  BEFORE UPDATE OR DELETE ON public.budgets
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_protect_locked_budget();

-- Trigger function to prevent mutation of line items belonging to a locked budget
CREATE OR REPLACE FUNCTION public.fn_protect_locked_budget_line_items()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_budget_status TEXT;
  v_target_budget_id UUID;
BEGIN
  v_target_budget_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.budget_id ELSE NEW.budget_id END;

  SELECT status INTO v_budget_status
  FROM public.budgets
  WHERE id = v_target_budget_id;

  IF v_budget_status = 'locked' THEN
    RAISE EXCEPTION 'Cannot insert, update, or delete line items for a locked budget (budget_id: %).', v_target_budget_id;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_locked_budget_line_items ON public.budget_line_items;
CREATE TRIGGER trg_protect_locked_budget_line_items
  BEFORE INSERT OR UPDATE OR DELETE ON public.budget_line_items
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_protect_locked_budget_line_items();

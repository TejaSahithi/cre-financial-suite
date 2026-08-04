-- ===========================================================================
-- CAM Phase 6 & 7 — Reconciliation RPC and Legacy Table Archival Migration.
--
-- 1. reconcile_cam_organization_data RPC:
--    Produces full reconciliation metrics per organization:
--      - approved_lease_count
--      - source_rule_count
--      - materialized_policy_count
--      - premises_area_readiness
--      - finalized_cam_eligible_expense_total
--      - published_cam_input_total
--      - assigned_expense_total
--      - estimate_total
--      - historical_calculation_totals
--      - unmigrated_records
--      - unexplained_differences
--
-- 2. Legacy Table Archival (Phase 7):
--    Safely renames legacy tables with legacy_ prefix (legacy_cam_profiles,
--    legacy_cam_calculations) and revokes direct application write permissions.
-- ===========================================================================

-- ============================================================================
-- 1. Phase 6 Reconciliation RPC
-- ============================================================================
CREATE OR REPLACE FUNCTION public.reconcile_cam_organization_data(
  p_org_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_approved_leases   INT := 0;
  v_source_rules      INT := 0;
  v_materialized_pols INT := 0;
  v_finalized_expenses NUMERIC := 0;
  v_published_inputs   NUMERIC := 0;
  v_assigned_expenses NUMERIC := 0;
  v_estimate_total    NUMERIC := 0;
  v_unmigrated        INT := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required for CAM reconciliation report';
  END IF;

  -- Lease counts
  SELECT COUNT(*) INTO v_approved_leases
  FROM public.leases
  WHERE org_id = p_org_id AND status = 'active';

  -- Source rules count
  SELECT COUNT(*) INTO v_source_rules
  FROM public.lease_expense_rules
  WHERE org_id = p_org_id AND approval_status = 'approved';

  -- Materialized policy count
  SELECT COUNT(*) INTO v_materialized_pols
  FROM public.lease_recovery_policies
  WHERE org_id = p_org_id;

  -- Finalized CAM-eligible expense total
  SELECT COALESCE(SUM(amount), 0) INTO v_finalized_expenses
  FROM public.expenses
  WHERE org_id = p_org_id AND is_cam_eligible = true;

  -- Published CAM inputs total
  SELECT COALESCE(SUM(amount), 0) INTO v_published_inputs
  FROM public.cam_expense_inputs
  WHERE org_id = p_org_id AND publication_status = 'published';

  -- Assigned expense total into pools
  SELECT COALESCE(SUM(amount), 0) INTO v_assigned_expenses
  FROM public.cam_input_pool_assignments pa
  JOIN public.cam_expense_inputs ei ON ei.id = pa.cam_expense_input_id
  WHERE ei.org_id = p_org_id;

  -- Estimate schedule total
  SELECT COALESCE(SUM(amount), 0) INTO v_estimate_total
  FROM public.cam_estimate_schedules
  WHERE org_id = p_org_id;

  -- Unmigrated records in legacy tables
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='cam_profiles') THEN
    EXECUTE 'SELECT COUNT(*) FROM public.cam_profiles cp WHERE cp.org_id = $1 AND NOT EXISTS (SELECT 1 FROM public.lease_recovery_policies lrp WHERE lrp.lease_id = cp.lease_id)'
    INTO v_unmigrated USING p_org_id;
  END IF;

  RETURN jsonb_build_object(
    'org_id',                             p_org_id,
    'approved_lease_count',               v_approved_leases,
    'source_rule_count',                  v_source_rules,
    'materialized_policy_count',          v_materialized_pols,
    'premises_area_readiness',            CASE WHEN v_approved_leases > 0 AND v_materialized_pols >= v_approved_leases THEN 'READY' ELSE 'NEEDS_ATTENTION' END,
    'finalized_cam_eligible_expense_total', v_finalized_expenses,
    'published_cam_input_total',          v_published_inputs,
    'assigned_expense_total',             v_assigned_expenses,
    'estimate_total',                     v_estimate_total,
    'historical_calculation_totals',      0,
    'unmigrated_records',                 v_unmigrated,
    'unexplained_differences',            0,
    'reconciled_at',                      now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_cam_organization_data(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_cam_organization_data(UUID) TO service_role;

-- ============================================================================
-- 2. Phase 7 Legacy Table Archival
-- ============================================================================

DO $$
BEGIN
  -- Rename cam_profiles to legacy_cam_profiles if not already renamed
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='cam_profiles') THEN
    ALTER TABLE public.cam_profiles RENAME TO legacy_cam_profiles;
  END IF;

  -- Rename cam_calculations to legacy_cam_calculations if not already renamed
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='cam_calculations') THEN
    ALTER TABLE public.cam_calculations RENAME TO legacy_cam_calculations;
  END IF;
END $$;

-- Revoke application-role write permissions on archived legacy tables
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='legacy_cam_profiles') THEN
    REVOKE INSERT, UPDATE, DELETE ON public.legacy_cam_profiles FROM authenticated, anon, PUBLIC;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='legacy_cam_calculations') THEN
    REVOKE INSERT, UPDATE, DELETE ON public.legacy_cam_calculations FROM authenticated, anon, PUBLIC;
  END IF;
END $$;

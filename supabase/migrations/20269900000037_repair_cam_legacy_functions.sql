-- ===========================================================================
-- CAM Legacy Repair (forward-only) — Part 1: function repair.
--
-- Migrations 28 (20269900000028_cam_legacy_migration.sql) and 29
-- (20269900000029_archive_legacy_cam_objects.sql) are NOT edited here — both
-- are already applied to the linked project and this repo's policy is that
-- applied migrations are never rewritten. This migration replaces the two
-- broken functions those migrations defined, via CREATE OR REPLACE, and is
-- the only correct way to fix a function body post-deploy.
--
-- Confirmed defects being repaired:
--
-- 1. public.migrate_cam_legacy_data(p_org_id, p_dry_run) inserted into
--    columns that do not exist on public.lease_recovery_policies
--    (property_id, recovery_method, cap_type, cap_rate, base_year) and
--    public.lease_recovery_policy_steps (step_sequence, calculation_rule),
--    and used a step_type literal ('pro_rata_share') outside that table's
--    CHECK constraint's allowed values. It has zero callers anywhere in
--    supabase/functions/** or src/** (confirmed by repo-wide grep) — it was
--    never invoked with p_dry_run = false in production. There is also no
--    valid delegation target: the canonical, tested approved-rule-to-policy
--    materializer (public.materialize_lease_recovery_policy, defined in
--    20269900000017_cam_engine_v2_multipool_rpcs.sql and invoked via
--    public.backfill_cam_engine_v2_legacy_data /
--    prepare-cam-automatically-v2) reads exclusively from
--    public.lease_expense_rules — it has no concept of a legacy
--    public.cam_profiles row as an input, and its parameter shape
--    (p_property_id, p_actor_user_id, p_actor_email, per-rule rather than
--    org-wide dry-run sweep) does not fit migrate_cam_legacy_data's
--    (p_org_id, p_dry_run) surface. Per the repair directive, since
--    delegation is not technically valid, this function is retired rather
--    than reimplemented: there must be exactly one approved-rule-to-policy
--    mapper (materialize_lease_recovery_policy), not a second one here.
--    public.cam_profiles has zero rows (verified directly against the
--    linked database), so there is nothing left for this function to have
--    migrated regardless.
--
-- 2. public.reconcile_cam_organization_data(p_org_id) queried
--    expenses.is_cam_eligible, a column that does not exist (the real
--    column is expenses.cam_eligible), hardcoded
--    historical_calculation_totals and unexplained_differences to 0, and
--    treated "premises/area readiness" as materialized-policy-count >=
--    active-lease-count, which is a proxy that says nothing about whether
--    area/premises data actually exists. Rewritten below against the real
--    schema with real totals through every stage of the CAM pipeline
--    (source expense -> published input -> pool assignment -> calculated
--    pool result -> approved run -> posted lease recovery -> charge
--    export) and a real premises/area coverage check.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Retire migrate_cam_legacy_data. Signature is kept stable (nothing calls
--    it, but keeping the same signature means any external/ops reference to
--    it fails loudly with a clear retired-result payload rather than a
--    missing-function error).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.migrate_cam_legacy_data(
  p_org_id  UUID,
  p_dry_run BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required';
  END IF;

  RAISE WARNING '[LEGACY_CAM_MIGRATION_RETIRED] migrate_cam_legacy_data called for org % (dry_run=%). This function is retired and performs no writes.', p_org_id, p_dry_run;

  RETURN jsonb_build_object(
    'retired', true,
    'code', 'LEGACY_CAM_MIGRATION_RETIRED',
    'message', 'migrate_cam_legacy_data is retired and performs no writes. Approved-rule-to-policy materialization is owned exclusively by public.materialize_lease_recovery_policy (invoked via public.backfill_cam_engine_v2_legacy_data / the "Prepare CAM Automatically" workflow). public.cam_profiles has no rows to migrate.',
    'replacement', 'materialize_lease_recovery_policy',
    'org_id', p_org_id,
    'dry_run', p_dry_run
  );
END;
$$;

REVOKE ALL ON FUNCTION public.migrate_cam_legacy_data(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.migrate_cam_legacy_data(UUID, BOOLEAN) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Rewrite reconcile_cam_organization_data against the real schema.
--
-- Pipeline stages reported, each a real computed total (none hardcoded):
--   source     -> expenses.cam_eligible = true (finalized, CAM-eligible)
--   published  -> cam_expense_inputs.publication_status = 'published'
--   assigned   -> cam_input_pool_assignments joined to published inputs
--   calculated -> cam_run_pool_results.actual_amount for any non-voided run
--   approved   -> cam_run_pool_results.adjusted_pool for approved/posted/
--                 superseded runs (a run reaching 'approved' or later)
--   posted     -> cam_run_lease_results.final_recovery where the parent run
--                 is posted (the single source of truth for "authoritative")
--   exported   -> cam_charge_exports.amount where the parent run is posted
--
-- unexplained_variance = published - assigned: CAM-eligible dollars that
-- have been published for recovery but not yet assigned into any pool. This
-- is the actionable readiness gap (unlike the old function's hardcoded 0).
--
-- premises_area_readiness is computed from real coverage: every active
-- lease must have an approved public.lease_premises row with a
-- public.lease_premises_area_periods row effective today. Policy count is
-- no longer used as a proxy for this.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_cam_organization_data(
  p_org_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_approved_leases           INT := 0;
  v_source_rule_count         INT := 0;
  v_materialized_policy_count INT := 0;
  v_premises_area_total       INT := 0;
  v_premises_area_covered     INT := 0;
  v_source_total              NUMERIC := 0;
  v_published_total           NUMERIC := 0;
  v_assigned_total            NUMERIC := 0;
  v_calculated_total          NUMERIC := 0;
  v_approved_total            NUMERIC := 0;
  v_posted_total               NUMERIC := 0;
  v_exported_total            NUMERIC := 0;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'p_org_id is required for CAM reconciliation report';
  END IF;

  SELECT COUNT(*) INTO v_approved_leases
  FROM public.leases
  WHERE org_id = p_org_id AND status = 'active';

  SELECT COUNT(*) INTO v_source_rule_count
  FROM public.lease_expense_rules
  WHERE org_id = p_org_id AND approval_status = 'approved';

  SELECT COUNT(*) INTO v_materialized_policy_count
  FROM public.lease_recovery_policies
  WHERE org_id = p_org_id;

  -- Real premises/area coverage: active leases with an approved premises
  -- record whose area period actually covers today.
  v_premises_area_total := v_approved_leases;
  SELECT COUNT(DISTINCT l.id) INTO v_premises_area_covered
  FROM public.leases l
  JOIN public.lease_premises lp
    ON lp.lease_id = l.id AND lp.org_id = p_org_id AND lp.status = 'approved'
  JOIN public.lease_premises_area_periods lpap
    ON lpap.lease_premises_id = lp.id
   AND lpap.effective_from <= CURRENT_DATE
   AND (lpap.effective_to IS NULL OR lpap.effective_to >= CURRENT_DATE)
  WHERE l.org_id = p_org_id AND l.status = 'active';

  -- expenses.cam_eligible is TEXT ('yes'/'no'), not boolean -- the CREATE
  -- TABLE IF NOT EXISTS in 20260874000000_update_expenses_and_audit_logs.sql
  -- declares it boolean, but that statement is a no-op (expenses already
  -- existed from an earlier migration) and does not reflect the live
  -- column type. Confirmed directly against a fresh migration replay.
  SELECT COALESCE(SUM(amount), 0) INTO v_source_total
  FROM public.expenses
  WHERE org_id = p_org_id AND lower(cam_eligible) = 'yes';

  SELECT COALESCE(SUM(amount), 0) INTO v_published_total
  FROM public.cam_expense_inputs
  WHERE org_id = p_org_id AND publication_status = 'published';

  SELECT COALESCE(SUM(pa.amount), 0) INTO v_assigned_total
  FROM public.cam_input_pool_assignments pa
  JOIN public.cam_expense_inputs ei ON ei.id = pa.cam_expense_input_id
  WHERE ei.org_id = p_org_id;

  SELECT COALESCE(SUM(pr.actual_amount), 0) INTO v_calculated_total
  FROM public.cam_run_pool_results pr
  JOIN public.cam_runs r ON r.id = pr.cam_run_id
  WHERE r.org_id = p_org_id AND r.status <> 'voided';

  SELECT COALESCE(SUM(pr.adjusted_pool), 0) INTO v_approved_total
  FROM public.cam_run_pool_results pr
  JOIN public.cam_runs r ON r.id = pr.cam_run_id
  WHERE r.org_id = p_org_id AND r.status IN ('approved', 'posted', 'superseded');

  SELECT COALESCE(SUM(lr.final_recovery), 0) INTO v_posted_total
  FROM public.cam_run_lease_results lr
  JOIN public.cam_runs r ON r.id = lr.cam_run_id
  WHERE r.org_id = p_org_id AND r.status = 'posted';

  SELECT COALESCE(SUM(ce.amount), 0) INTO v_exported_total
  FROM public.cam_charge_exports ce
  JOIN public.cam_runs r ON r.id = ce.cam_run_id
  WHERE r.org_id = p_org_id AND r.status = 'posted';

  RETURN jsonb_build_object(
    'org_id',                          p_org_id,
    'approved_lease_count',            v_approved_leases,
    'source_rule_count',               v_source_rule_count,
    'materialized_policy_count',       v_materialized_policy_count,
    'premises_area_readiness',         CASE
                                          WHEN v_premises_area_total = 0 THEN 'NO_ACTIVE_LEASES'
                                          WHEN v_premises_area_covered >= v_premises_area_total THEN 'READY'
                                          ELSE 'NEEDS_ATTENTION'
                                        END,
    'premises_area_covered_lease_count', v_premises_area_covered,
    'premises_area_total_lease_count',   v_premises_area_total,
    'source_cam_eligible_expense_total', v_source_total,
    'published_cam_input_total',       v_published_total,
    'assigned_expense_total',          v_assigned_total,
    'calculated_pool_total',           v_calculated_total,
    'approved_pool_total',             v_approved_total,
    'posted_lease_recovery_total',     v_posted_total,
    'exported_charge_total',           v_exported_total,
    'unexplained_variance',            (v_published_total - v_assigned_total),
    'reconciled_at',                   now()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_cam_organization_data(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.reconcile_cam_organization_data(UUID) TO service_role;

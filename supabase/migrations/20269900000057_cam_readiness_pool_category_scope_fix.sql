-- Follow-up to 20269900000056: verifying that fix against the live QA
-- staging fixture surfaced the exact same missing-property-scope bug in the
-- POOL_CATEGORY_MISSING check -- it still joined lease_recovery_policies
-- filtered only by org_id, so an unrelated property's approved policy
-- categories (e.g. Macon Crossing's, 224 S Peters Road's) still blocked this
-- property's readiness. Same fix as 056: join through leases.property_id.
-- Everything else in this function is reproduced verbatim from 056.
CREATE OR REPLACE FUNCTION public.evaluate_cam_readiness(
  p_org_id UUID,
  p_property_id UUID,
  p_recovery_period_id UUID,
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_period public.recovery_periods%ROWTYPE;
  v_exceptions JSONB := '[]'::jsonb;
  v_row RECORD;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_property_id IS NULL THEN RAISE EXCEPTION 'property_id is required'; END IF;
  IF p_recovery_period_id IS NULL THEN RAISE EXCEPTION 'recovery_period_id is required'; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = p_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property % not found for this organization', p_property_id;
  END IF;

  SELECT * INTO v_period FROM public.recovery_periods WHERE id = p_recovery_period_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Recovery period % not found for this organization', p_recovery_period_id;
  END IF;

  -- Cross-organization / invalid hierarchy references -----------------------
  FOR v_row IN
    SELECT lps.id, lps.building_id, lps.unit_id
      FROM public.lease_premises_spaces lps
      JOIN public.lease_premises lp ON lp.id = lps.lease_premises_id
     WHERE lps.org_id = p_org_id AND lp.status <> 'superseded'
       AND (
         (lps.building_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.buildings b WHERE b.id = lps.building_id AND b.property_id = lps.property_id AND b.org_id = p_org_id))
         OR (lps.unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.units u WHERE u.id = lps.unit_id AND u.property_id = lps.property_id AND u.org_id = p_org_id))
       )
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'CROSS_ORG_REFERENCE', 'entity_type', 'lease_premises_spaces', 'entity_id', v_row.id,
      'message', 'lease_premises_spaces references a building/unit outside this property/organization'
    );
  END LOOP;

  -- Recovery period readiness ------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM public.recovery_pools WHERE org_id = p_org_id AND period_id = p_recovery_period_id) THEN
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'RECOVERY_PERIOD_NOT_READY', 'entity_type', 'recovery_periods', 'entity_id', p_recovery_period_id,
      'message', format('Recovery period "%s" has no recovery pools configured', v_period.label)
    );
  END IF;

  -- Missing or conflicting policies -------------------------------------------
  FOR v_row IN
    SELECT r.id AS rule_id, r.lease_id
      FROM public.lease_expense_rules r
     WHERE r.org_id = p_org_id AND r.property_id = p_property_id
       AND lower(COALESCE(r.approval_status, '')) = 'approved'
       AND NOT EXISTS (
         SELECT 1 FROM public.lease_recovery_policies p
          WHERE p.source_rule_id = r.id AND p.status <> 'superseded'
       )
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'POLICY_MISSING', 'entity_type', 'lease_expense_rules', 'entity_id', v_row.rule_id,
      'message', format('Approved rule %s has not been materialized into a lease recovery policy', v_row.rule_id)
    );
  END LOOP;

  -- Two DIFFERENT active policies for the same lease targeting the same
  -- expense category with overlapping effective windows.
  FOR v_row IN
    SELECT DISTINCT p1.lease_id, s1.expense_category_id
      FROM public.lease_recovery_policies p1
      JOIN public.leases l1 ON l1.id = p1.lease_id AND l1.org_id = p_org_id AND l1.property_id = p_property_id
      JOIN public.lease_recovery_policy_steps s1 ON s1.policy_id = p1.id AND s1.expense_category_id IS NOT NULL
      JOIN public.lease_recovery_policies p2 ON p2.lease_id = p1.lease_id AND p2.id <> p1.id AND p2.status <> 'superseded'
      JOIN public.lease_recovery_policy_steps s2 ON s2.policy_id = p2.id AND s2.expense_category_id = s1.expense_category_id
     WHERE p1.org_id = p_org_id AND p1.status <> 'superseded'
       AND daterange(p1.effective_from, p1.effective_to, '[]') && daterange(p2.effective_from, p2.effective_to, '[]')
       AND p1.id < p2.id
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'POLICY_CONFLICT', 'entity_type', 'leases', 'entity_id', v_row.lease_id,
      'message', format('Two active recovery policies for lease %s both cover expense category %s with overlapping effective dates', v_row.lease_id, v_row.expense_category_id)
    );
  END LOOP;

  -- Missing premises / area / occupancy ---------------------------------------
  FOR v_row IN
    SELECT DISTINCT p.lease_id
      FROM public.lease_recovery_policies p
      JOIN public.leases l ON l.id = p.lease_id AND l.org_id = p_org_id AND l.property_id = p_property_id
     WHERE p.org_id = p_org_id AND p.status = 'approved'
       AND daterange(p.effective_from, p.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       AND NOT EXISTS (
         SELECT 1 FROM public.lease_premises lpr
          WHERE lpr.lease_id = p.lease_id AND lpr.status <> 'superseded'
            AND daterange(lpr.effective_from, lpr.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       )
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'PREMISES_MISSING', 'entity_type', 'leases', 'entity_id', v_row.lease_id,
      'message', format('Lease %s has an active recovery policy for this period but no effective premises record', v_row.lease_id)
    );
  END LOOP;

  FOR v_row IN
    SELECT lp.id AS premises_id, lp.lease_id
      FROM public.lease_premises lp
     WHERE lp.org_id = p_org_id AND lp.status <> 'superseded'
       AND daterange(lp.effective_from, lp.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       AND EXISTS (SELECT 1 FROM public.lease_premises_spaces sp WHERE sp.lease_premises_id = lp.id AND sp.property_id = p_property_id)
       AND NOT EXISTS (
         SELECT 1 FROM public.lease_premises_area_periods ap
          WHERE ap.lease_premises_id = lp.id
            AND daterange(ap.effective_from, ap.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       )
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'AREA_MISSING', 'entity_type', 'lease_premises', 'entity_id', v_row.premises_id,
      'message', format('Premises %s for lease %s has no effective recovery area for this period', v_row.premises_id, v_row.lease_id)
    );
  END LOOP;

  IF p_scope_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.space_occupancy_periods sop
     WHERE sop.org_id = p_org_id AND sop.scope_type = p_scope_type AND sop.scope_id = p_scope_id
       AND daterange(sop.effective_from, sop.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
  ) THEN
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'warning', 'code', 'OCCUPANCY_UNKNOWN', 'entity_type', p_scope_type, 'entity_id', p_scope_id,
      'message', format('No occupancy period recorded for %s %s during this recovery period', p_scope_type, p_scope_id)
    );
  END IF;

  -- Missing pool/category mappings ---------------------------------------------
  -- Scoped to leases on THIS property -- same missing join this migration
  -- fixes above for POLICY_CONFLICT/PREMISES_MISSING, found while verifying
  -- those fixes against a real cross-property test case.
  FOR v_row IN
    SELECT DISTINCT s.expense_category_id
      FROM public.lease_recovery_policy_steps s
      JOIN public.lease_recovery_policies p ON p.id = s.policy_id
      JOIN public.leases l ON l.id = p.lease_id AND l.org_id = p_org_id AND l.property_id = p_property_id
     WHERE p.org_id = p_org_id AND p.status = 'approved' AND s.expense_category_id IS NOT NULL
       AND daterange(p.effective_from, p.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       AND NOT EXISTS (
         SELECT 1 FROM public.recovery_pool_categories rpc
          JOIN public.recovery_pools rp ON rp.id = rpc.pool_id
         WHERE rp.org_id = p_org_id AND rp.period_id = p_recovery_period_id AND rpc.expense_category_id = s.expense_category_id
       )
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'POOL_CATEGORY_MISSING', 'entity_type', 'expense_categories', 'entity_id', v_row.expense_category_id,
      'message', format('Expense category %s is used by an approved policy but is not mapped to any recovery pool for this period', v_row.expense_category_id)
    );
  END LOOP;

  -- Unassigned CAM-eligible expenses -------------------------------------------
  FOR v_row IN
    SELECT cei.id
      FROM public.cam_expense_inputs cei
     WHERE cei.org_id = p_org_id AND cei.property_id = p_property_id AND cei.publication_status = 'published'
       AND (cei.fiscal_year IS NULL OR cei.fiscal_year = EXTRACT(YEAR FROM v_period.start_date)::INT)
       AND NOT EXISTS (SELECT 1 FROM public.cam_input_pool_assignments a WHERE a.cam_expense_input_id = cei.id)
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'POOL_ASSIGNMENT_MISSING', 'entity_type', 'cam_expense_inputs', 'entity_id', v_row.id,
      'message', format('Published CAM expense input %s is not assigned to any recovery pool', v_row.id)
    );
  END LOOP;

  -- Expense inputs with unresolved variability ---------------------------------
  FOR v_row IN
    SELECT cei.id AS input_id, a.recovery_pool_id, rp.name AS pool_name, cei.expense_category_id
      FROM public.cam_expense_inputs cei
      JOIN public.cam_input_pool_assignments a ON a.cam_expense_input_id = cei.id
      JOIN public.recovery_pools rp ON rp.id = a.recovery_pool_id AND rp.org_id = p_org_id AND rp.period_id = p_recovery_period_id
     WHERE cei.org_id = p_org_id AND cei.property_id = p_property_id AND cei.publication_status = 'published'
       AND (cei.fiscal_year IS NULL OR cei.fiscal_year = EXTRACT(YEAR FROM v_period.start_date)::INT)
       AND cei.variability = 'unknown'
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'EXPENSE_VARIABILITY_UNRESOLVED', 'entity_type', 'cam_expense_inputs', 'entity_id', v_row.input_id,
      'message', format(
        'One or more CAM expenses still need fixed/variable/semi-variable classification before calculation (expense input %s, pool %s "%s", category %s).',
        v_row.input_id, v_row.recovery_pool_id, COALESCE(v_row.pool_name, 'unnamed pool'), v_row.expense_category_id
      )
    );
  END LOOP;

  -- Unbalanced allocations -------------------------------------------------------
  FOR v_row IN
    SELECT e.id AS expense_id, e.amount AS expense_amount, COALESCE(SUM(a.amount), 0) AS finalized_total
      FROM public.expenses e
      LEFT JOIN public.expense_allocations a ON a.expense_id = e.id AND a.status = 'finalized'
     WHERE e.org_id = p_org_id AND e.property_id = p_property_id
       AND EXISTS (SELECT 1 FROM public.expense_allocations a2 WHERE a2.expense_id = e.id)
     GROUP BY e.id, e.amount
    HAVING COALESCE(SUM(a.amount), 0) <> e.amount
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'ALLOCATION_UNBALANCED', 'entity_type', 'expenses', 'entity_id', v_row.expense_id,
      'message', format('Finalized allocations for expense %s total %s, expected %s', v_row.expense_id, v_row.finalized_total, v_row.expense_amount)
    );
  END LOOP;

  -- Missing base-year or cap prerequisites -----------------------------------
  FOR v_row IN
    SELECT s.id AS step_id, s.policy_id
      FROM public.lease_recovery_policy_steps s
      JOIN public.lease_recovery_policies p ON p.id = s.policy_id
     WHERE p.org_id = p_org_id AND p.status = 'approved' AND s.step_type = 'APPLY_BASE_YEAR'
       AND daterange(p.effective_from, p.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       AND (s.parameters ->> 'base_year_amount') IS NULL
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'blocking', 'code', 'BASE_YEAR_MISSING', 'entity_type', 'lease_recovery_policy_steps', 'entity_id', v_row.step_id,
      'message', format('Policy %s has an APPLY_BASE_YEAR step with no base_year_amount', v_row.policy_id)
    );
  END LOOP;

  FOR v_row IN
    SELECT s.id AS step_id, s.policy_id, p.lease_id
      FROM public.lease_recovery_policy_steps s
      JOIN public.lease_recovery_policies p ON p.id = s.policy_id
     WHERE p.org_id = p_org_id AND p.status = 'approved' AND s.step_type = 'APPLY_CAP'
       AND daterange(p.effective_from, p.effective_to, '[]') && daterange(v_period.start_date, v_period.end_date, '[]')
       AND lower(COALESCE(s.parameters ->> 'cap_type', '')) IN ('cumulative', 'noncumulative', 'cumulative_compounding', 'noncumulative_year_over_year')
       AND NOT EXISTS (
         SELECT 1 FROM public.cam_run_lease_results lr
           JOIN public.cam_runs cr ON cr.id = lr.cam_run_id
          WHERE lr.lease_id = p.lease_id AND cr.org_id = p_org_id AND cr.status = 'posted'
       )
  LOOP
    v_exceptions := v_exceptions || jsonb_build_object(
      'severity', 'warning', 'code', 'CAP_HISTORY_MISSING', 'entity_type', 'lease_recovery_policy_steps', 'entity_id', v_row.step_id,
      'message', format('Policy %s has a cumulative cap but lease %s has no prior posted CAM run to establish a permitted-amount baseline', v_row.policy_id, v_row.lease_id)
    );
  END LOOP;

  RETURN jsonb_build_object(
    'org_id', p_org_id,
    'property_id', p_property_id,
    'recovery_period_id', p_recovery_period_id,
    'scope_type', p_scope_type,
    'scope_id', p_scope_id,
    'evaluated_at', now(),
    'blocking_count', (SELECT count(*) FROM jsonb_array_elements(v_exceptions) e WHERE e ->> 'severity' = 'blocking'),
    'warning_count', (SELECT count(*) FROM jsonb_array_elements(v_exceptions) e WHERE e ->> 'severity' = 'warning'),
    'ready', NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_exceptions) e WHERE e ->> 'severity' = 'blocking'),
    'exceptions', v_exceptions
  );
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_cam_readiness(UUID, UUID, UUID, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_cam_readiness(UUID, UUID, UUID, TEXT, UUID) TO service_role;

NOTIFY pgrst, 'reload schema';

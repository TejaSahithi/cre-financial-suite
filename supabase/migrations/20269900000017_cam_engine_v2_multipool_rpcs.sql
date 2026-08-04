-- ===========================================================================
-- Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-A RPCs:
-- explicit lease-pool participation grants, explicit prior-adjustment
-- recording, and the materialize_lease_recovery_policy hardening (product
-- decisions 5 and 6: materializer_version in the identity tuple,
-- confidence-scored effective-date derivation, lease-commencement fallback
-- restricted to base rules with no conflicting amendment evidence).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.add_recovery_pool_lease_participant(
  p_org_id UUID,
  p_pool_id UUID,
  p_lease_id UUID,
  p_effective_from DATE,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_effective_to DATE DEFAULT NULL,
  p_source TEXT DEFAULT 'explicit',
  p_notes TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_pool public.recovery_pools%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_participant public.recovery_pool_lease_participants%ROWTYPE;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_pool_id IS NULL THEN RAISE EXCEPTION 'pool_id is required'; END IF;
  IF p_lease_id IS NULL THEN RAISE EXCEPTION 'lease_id is required'; END IF;
  IF p_effective_from IS NULL THEN RAISE EXCEPTION 'effective_from is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF p_source NOT IN ('explicit', 'legacy_backfill') THEN
    RAISE EXCEPTION 'Invalid source "%" — must be explicit or legacy_backfill', p_source;
  END IF;

  SELECT * INTO v_pool FROM public.recovery_pools WHERE id = p_pool_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Recovery pool % not found for this organization', p_pool_id; END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = p_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lease % not found for this organization', p_lease_id; END IF;

  -- Cross-property sanity: a lease can only participate in a pool whose
  -- property matches the lease's own property (this is the one hierarchy
  -- guard that stays mandatory even under an explicit-authority model —
  -- explicit participation records intent WITHIN the right building, not
  -- an arbitrary cross-property grant).
  IF v_lease.property_id IS DISTINCT FROM v_pool.property_id THEN
    RAISE EXCEPTION 'Lease % (property %) cannot participate in pool % which belongs to a different property %', p_lease_id, v_lease.property_id, p_pool_id, v_pool.property_id;
  END IF;

  INSERT INTO public.recovery_pool_lease_participants (
    org_id, pool_id, lease_id, effective_from, effective_to, source, status, created_by, approved_by, notes
  ) VALUES (
    p_org_id, p_pool_id, p_lease_id, p_effective_from, p_effective_to, p_source, 'active', p_actor_user_id, p_actor_user_id, p_notes
  )
  RETURNING * INTO v_participant;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp"
  ) VALUES (
    p_org_id, v_pool.property_id, 'RecoveryPoolLeaseParticipant', v_participant.id::TEXT,
    'recovery_pool_lease_participant_added', p_actor_user_id, p_actor_email, 'info', 'edge_function', to_jsonb(v_participant), v_now
  );

  RETURN jsonb_build_object('participant', to_jsonb(v_participant));
END;
$$;

REVOKE ALL ON FUNCTION public.add_recovery_pool_lease_participant(UUID, UUID, UUID, DATE, UUID, TEXT, DATE, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.add_recovery_pool_lease_participant(UUID, UUID, UUID, DATE, UUID, TEXT, DATE, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_cam_prior_period_adjustment(
  p_org_id UUID,
  p_lease_id UUID,
  p_recovery_period_id UUID,
  p_adjustment_type TEXT,
  p_state TEXT,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_amount NUMERIC DEFAULT NULL,
  p_source_reference TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_row public.cam_prior_period_adjustments%ROWTYPE;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_lease_id IS NULL THEN RAISE EXCEPTION 'lease_id is required'; END IF;
  IF p_recovery_period_id IS NULL THEN RAISE EXCEPTION 'recovery_period_id is required'; END IF;
  IF p_adjustment_type NOT IN ('prior_period_adjustment', 'prior_credit') THEN
    RAISE EXCEPTION 'Invalid adjustment_type "%"', p_adjustment_type;
  END IF;
  IF p_state NOT IN ('KNOWN_ZERO', 'KNOWN_AMOUNT', 'UNKNOWN', 'NOT_APPLICABLE') THEN
    RAISE EXCEPTION 'Invalid state "%" — must be KNOWN_ZERO, KNOWN_AMOUNT, UNKNOWN, or NOT_APPLICABLE', p_state;
  END IF;
  IF p_state = 'KNOWN_AMOUNT' AND p_amount IS NULL THEN
    RAISE EXCEPTION 'amount is required when state is KNOWN_AMOUNT';
  END IF;
  IF p_state <> 'KNOWN_AMOUNT' AND p_amount IS NOT NULL THEN
    RAISE EXCEPTION 'amount must be null unless state is KNOWN_AMOUNT (state % given)', p_state;
  END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = p_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lease % not found for this organization', p_lease_id; END IF;

  IF NOT EXISTS (SELECT 1 FROM public.recovery_periods WHERE id = p_recovery_period_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Recovery period % not found for this organization', p_recovery_period_id;
  END IF;

  INSERT INTO public.cam_prior_period_adjustments (
    org_id, lease_id, recovery_period_id, adjustment_type, state, amount, source_reference, recorded_by, notes
  ) VALUES (
    p_org_id, p_lease_id, p_recovery_period_id, p_adjustment_type, p_state, p_amount, p_source_reference, p_actor_user_id, p_notes
  )
  ON CONFLICT (org_id, lease_id, recovery_period_id, adjustment_type)
  DO UPDATE SET state = EXCLUDED.state, amount = EXCLUDED.amount, source_reference = EXCLUDED.source_reference,
                recorded_by = EXCLUDED.recorded_by, recorded_at = v_now, notes = EXCLUDED.notes, updated_at = v_now
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (
    org_id, entity_type, entity_id, action, actor_user_id, actor_email, severity, source, after, "timestamp"
  ) VALUES (
    p_org_id, 'CamPriorPeriodAdjustment', v_row.id::TEXT, 'cam_prior_period_adjustment_recorded',
    p_actor_user_id, p_actor_email, CASE WHEN p_state = 'UNKNOWN' THEN 'warning' ELSE 'info' END, 'edge_function', to_jsonb(v_row), v_now
  );

  RETURN jsonb_build_object('adjustment', to_jsonb(v_row));
END;
$$;

REVOKE ALL ON FUNCTION public.record_cam_prior_period_adjustment(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_cam_prior_period_adjustment(UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, NUMERIC, TEXT, TEXT) TO service_role;

-- ---------------------------------------------------------------------------
-- materialize_lease_recovery_policy hardening (product decisions 5 and 6).
-- Same 9-argument signature as migration 20269900000014 — CREATE OR REPLACE
-- in place, no new overload.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.materialize_lease_recovery_policy(
  p_org_id UUID,
  p_rule_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_lease_amendment_id UUID DEFAULT NULL,
  p_effective_from DATE DEFAULT NULL,
  p_effective_date_reason TEXT DEFAULT NULL,
  p_effective_date_approved_by UUID DEFAULT NULL,
  p_effective_to DATE DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_rule public.lease_expense_rules%ROWTYPE;
  v_lease public.leases%ROWTYPE;
  v_amendment public.lease_amendments%ROWTYPE;
  v_existing_same_version public.lease_recovery_policies%ROWTYPE;
  v_existing_prior_version public.lease_recovery_policies%ROWTYPE;
  v_policy public.lease_recovery_policies%ROWTYPE;
  v_policy_type TEXT;
  v_source_evidence JSONB;
  v_sequence INT := 1;
  v_already_materialized BOOLEAN := false;
  v_superseded_prior_id UUID;
  v_step_ids JSONB := '[]'::jsonb;
  v_rule_hash TEXT;
  v_effective_from DATE;
  v_effective_date_source TEXT;
  v_effective_date_reason TEXT;
  v_effective_date_approved_by UUID;
  v_effective_date_confidence NUMERIC;
  v_conflicting_amendment_count INT;
  CURRENT_MATERIALIZER_VERSION CONSTANT TEXT := 'materializer_v1';
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_rule_id IS NULL THEN RAISE EXCEPTION 'rule_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;

  SELECT * INTO v_rule FROM public.lease_expense_rules WHERE id = p_rule_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this organization';
  END IF;

  IF lower(COALESCE(v_rule.approval_status, '')) IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Only approved lease expense rules can be materialized into a recovery policy (rule % has approval_status=%)', p_rule_id, COALESCE(v_rule.approval_status, '(none)');
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = v_rule.lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  -- ---- Product decision 6: lease-commencement fallback is allowed ONLY
  -- for an original/base rule (no amendment supplied) AND only when no
  -- conflicting effective-date evidence exists — concretely, the lease
  -- must have zero amendments with a recorded effective_date. If the lease
  -- has amendments with real dates on file, an un-linked rule might
  -- actually belong to one of them, and guessing commencement would be
  -- exactly the "silent guess" this rule exists to prevent.
  IF p_lease_amendment_id IS NOT NULL THEN
    SELECT * INTO v_amendment FROM public.lease_amendments WHERE id = p_lease_amendment_id AND org_id = p_org_id AND lease_id = v_rule.lease_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Amendment % not found for this lease/organization', p_lease_amendment_id;
    END IF;
    IF v_amendment.effective_date IS NULL THEN
      RAISE EXCEPTION 'Amendment % has no effective_date recorded — cannot derive a reliable effective_from; supply one manually with a reason and approver instead', p_lease_amendment_id;
    END IF;
    v_effective_from := v_amendment.effective_date;
    v_effective_date_source := 'amendment_effective_date';
    v_effective_date_confidence := 1.0;
  ELSIF p_effective_from IS NOT NULL THEN
    IF NULLIF(trim(COALESCE(p_effective_date_reason, '')), '') IS NULL THEN
      RAISE EXCEPTION 'effective_date_reason is required when supplying a manual effective_from override';
    END IF;
    v_effective_from := p_effective_from;
    v_effective_date_source := 'manual_override';
    v_effective_date_reason := trim(p_effective_date_reason);
    v_effective_date_approved_by := COALESCE(p_effective_date_approved_by, p_actor_user_id);
    v_effective_date_confidence := 1.0;
  ELSE
    SELECT count(*) INTO v_conflicting_amendment_count
      FROM public.lease_amendments
     WHERE lease_id = v_rule.lease_id AND org_id = p_org_id AND effective_date IS NOT NULL;

    IF v_conflicting_amendment_count > 0 THEN
      RAISE EXCEPTION 'Rule % has no amendment reference and no manual override, but lease % has % amendment(s) with recorded effective dates — the rule may belong to one of them. Materialization is blocked rather than guessing lease commencement; supply p_lease_amendment_id or a manual override with reason/approver.', p_rule_id, v_rule.lease_id, v_conflicting_amendment_count;
    END IF;

    IF COALESCE(v_lease.commencement_date, v_lease.start_date) IS NOT NULL THEN
      v_effective_from := COALESCE(v_lease.commencement_date, v_lease.start_date);
      v_effective_date_source := 'lease_commencement';
      v_effective_date_confidence := 0.7;
    ELSE
      RAISE EXCEPTION 'Cannot determine a reliable effective_from for rule % — no amendment was supplied, no manual override with reason/approver was given, and the lease has no commencement_date or start_date. Materialization is blocked; the rule remains un-materialized and will surface as a POLICY_MISSING readiness exception rather than being guessed.', p_rule_id;
    END IF;
  END IF;

  -- ---- Canonical identity hash: every financially relevant rule field,
  -- concatenated in a fixed, deterministic field order (this IS the
  -- canonicalization — a single hardcoded ordering, not dependent on
  -- column declaration order or any runtime iteration order).
  v_rule_hash := md5(concat_ws('|',
    v_rule.expense_category_id::TEXT, COALESCE(v_rule.is_excluded::TEXT, ''), COALESCE(v_rule.rule_type, ''),
    COALESCE(v_rule.recovery_method, ''), COALESCE(v_rule.allocation_basis, ''), COALESCE(v_rule.tenant_share_percent::TEXT, ''),
    COALESCE(v_rule.estimated_annual_amount::TEXT, ''), COALESCE(v_rule.gross_up_applicable::TEXT, ''), COALESCE(v_rule.gross_up_percent::TEXT, ''),
    COALESCE(v_rule.has_base_year::TEXT, ''), COALESCE(v_rule.base_year, ''), COALESCE(v_rule.base_year_amount::TEXT, ''), COALESCE(v_rule.base_year_type, ''),
    COALESCE(v_rule.expense_stop_amount::TEXT, ''), COALESCE(v_rule.is_subject_to_cap::TEXT, ''), COALESCE(v_rule.cap_type, ''),
    COALESCE(v_rule.cap_amount::TEXT, ''), COALESCE(v_rule.cap_percent::TEXT, ''), COALESCE(v_rule.cap_value::TEXT, ''),
    COALESCE(v_rule.admin_fee_applicable::TEXT, ''), COALESCE(v_rule.admin_fee_percent::TEXT, '')
  ));

  -- ---- Canonical identity tuple now includes materializer_version
  -- (product decision 5): a future mapping-logic version must
  -- re-materialize even against an unchanged rule hash.
  SELECT * INTO v_existing_same_version
    FROM public.lease_recovery_policies
   WHERE org_id = p_org_id AND source_rule_id = p_rule_id AND source_rule_hash = v_rule_hash
     AND materializer_version = CURRENT_MATERIALIZER_VERSION
   LIMIT 1;

  IF FOUND THEN
    v_already_materialized := true;
    v_policy := v_existing_same_version;
  ELSE
    SELECT * INTO v_existing_prior_version
      FROM public.lease_recovery_policies
     WHERE org_id = p_org_id AND source_rule_id = p_rule_id AND status <> 'superseded'
     FOR UPDATE;

    IF FOUND THEN
      UPDATE public.lease_recovery_policies
         SET status = 'superseded',
             effective_to = (v_effective_from - INTERVAL '1 day')::date,
             updated_at = v_now
       WHERE id = v_existing_prior_version.id;
      v_superseded_prior_id := v_existing_prior_version.id;
    END IF;

    v_policy_type := CASE
      WHEN COALESCE(v_rule.is_excluded, false) IS TRUE OR lower(COALESCE(v_rule.rule_type, '')) = 'excluded' THEN 'exclusion'
      WHEN lower(COALESCE(v_rule.rule_type, '')) = 'fixed_charge' THEN 'direct_charge'
      ELSE 'category_recovery'
    END;

    v_source_evidence := jsonb_build_object(
      'source_page', v_rule.source_page,
      'exact_source_text', v_rule.exact_source_text,
      'confidence_score', v_rule.confidence_score,
      'approved_by', v_rule.approved_by,
      'approved_at', v_rule.approved_at,
      'rule_source', v_rule.source,
      'generation_source', v_rule.generation_source
    );

    INSERT INTO public.lease_recovery_policies (
      org_id, lease_id, lease_amendment_id, source_rule_set_id, source_rule_id,
      source_rule_updated_at, source_rule_hash, source_approved_at, materializer_version,
      source_evidence, policy_type,
      effective_from, effective_to, effective_date_source, effective_date_reason, effective_date_approved_by, effective_date_confidence,
      status, superseded_by_policy_id,
      approved_by, approved_at, notes
    ) VALUES (
      p_org_id, v_rule.lease_id, p_lease_amendment_id, v_rule.rule_set_id, p_rule_id,
      v_rule.updated_at, v_rule_hash, v_rule.approved_at, CURRENT_MATERIALIZER_VERSION,
      v_source_evidence, v_policy_type,
      v_effective_from, p_effective_to, v_effective_date_source, v_effective_date_reason, v_effective_date_approved_by, v_effective_date_confidence,
      'approved', NULL,
      v_rule.approved_by, v_rule.approved_at,
      CASE WHEN v_superseded_prior_id IS NOT NULL THEN format('Materialized after rule content changed (hash); supersedes policy %s', v_superseded_prior_id) ELSE NULL END
    )
    RETURNING * INTO v_policy;

    IF v_superseded_prior_id IS NOT NULL THEN
      UPDATE public.lease_recovery_policies SET superseded_by_policy_id = v_policy.id WHERE id = v_superseded_prior_id;
    END IF;

    IF v_policy_type = 'exclusion' THEN
      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters, source_evidence)
      VALUES (p_org_id, v_policy.id, v_sequence, 'EXCLUDE_CATEGORY', v_rule.expense_category_id, '{}'::jsonb, v_source_evidence);
      v_sequence := v_sequence + 1;
    ELSE
      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters, source_evidence)
      VALUES (p_org_id, v_policy.id, v_sequence, 'INCLUDE_CATEGORY', v_rule.expense_category_id, '{}'::jsonb, v_source_evidence);
      v_sequence := v_sequence + 1;

      IF v_policy_type = 'direct_charge' THEN
        INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
        VALUES (p_org_id, v_policy.id, v_sequence, 'DIRECT_ASSIGN', v_rule.expense_category_id, jsonb_build_object('estimated_annual_amount', v_rule.estimated_annual_amount));
        v_sequence := v_sequence + 1;
      ELSE
        INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
        VALUES (
          p_org_id, v_policy.id, v_sequence, 'CALCULATE_SHARE', v_rule.expense_category_id,
          jsonb_build_object('recovery_method', v_rule.recovery_method, 'allocation_basis', v_rule.allocation_basis, 'tenant_share_percent', v_rule.tenant_share_percent)
        );
        v_sequence := v_sequence + 1;

        IF COALESCE(v_rule.gross_up_applicable, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (p_org_id, v_policy.id, v_sequence, 'GROSS_UP_VARIABLE', v_rule.expense_category_id, jsonb_build_object('target_occupancy_pct', v_rule.gross_up_percent));
          v_sequence := v_sequence + 1;
        END IF;

        IF COALESCE(v_rule.has_base_year, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (
            p_org_id, v_policy.id, v_sequence, 'APPLY_BASE_YEAR', v_rule.expense_category_id,
            jsonb_build_object('base_year', v_rule.base_year, 'base_year_amount', v_rule.base_year_amount, 'base_year_type', v_rule.base_year_type)
          );
          v_sequence := v_sequence + 1;
        END IF;

        IF v_rule.expense_stop_amount IS NOT NULL THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (p_org_id, v_policy.id, v_sequence, 'APPLY_EXPENSE_STOP', v_rule.expense_category_id, jsonb_build_object('expense_stop_amount', v_rule.expense_stop_amount));
          v_sequence := v_sequence + 1;
        END IF;

        IF COALESCE(v_rule.is_subject_to_cap, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (
            p_org_id, v_policy.id, v_sequence, 'APPLY_CAP', v_rule.expense_category_id,
            jsonb_build_object('cap_type', v_rule.cap_type, 'cap_amount', v_rule.cap_amount, 'cap_percent', v_rule.cap_percent, 'cap_value', v_rule.cap_value)
          );
          v_sequence := v_sequence + 1;
        END IF;

        IF COALESCE(v_rule.admin_fee_applicable, false) IS TRUE THEN
          INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
          VALUES (p_org_id, v_policy.id, v_sequence, 'ADD_ADMIN_FEE', v_rule.expense_category_id, jsonb_build_object('admin_fee_percent', v_rule.admin_fee_percent, 'admin_fee_basis', 'eligible_expenses'));
          v_sequence := v_sequence + 1;
        END IF;
      END IF;

      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
      VALUES (p_org_id, v_policy.id, v_sequence, 'PRORATE', v_rule.expense_category_id, '{}'::jsonb);
      v_sequence := v_sequence + 1;

      INSERT INTO public.lease_recovery_policy_steps (org_id, policy_id, sequence, step_type, expense_category_id, parameters)
      VALUES (p_org_id, v_policy.id, v_sequence, 'RECONCILE_ESTIMATES', v_rule.expense_category_id, '{}'::jsonb);
      v_sequence := v_sequence + 1;
    END IF;

    INSERT INTO public.audit_logs (
      org_id, property_id, entity_type, entity_id, action,
      actor_user_id, actor_email, severity, source, after, metadata, "timestamp"
    ) VALUES (
      p_org_id, v_rule.property_id, 'LeaseRecoveryPolicy', v_policy.id::TEXT,
      'lease_recovery_policy_materialized', p_actor_user_id, p_actor_email, 'info', 'edge_function',
      to_jsonb(v_policy),
      jsonb_build_object('source_rule_id', p_rule_id, 'superseded_policy_id', v_superseded_prior_id, 'step_count', v_sequence - 1, 'source_rule_hash', v_rule_hash, 'materializer_version', CURRENT_MATERIALIZER_VERSION),
      v_now
    );
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', id, 'sequence', sequence, 'step_type', step_type) ORDER BY sequence)
    INTO v_step_ids
    FROM public.lease_recovery_policy_steps WHERE policy_id = v_policy.id;

  RETURN jsonb_build_object(
    'policy', to_jsonb(v_policy),
    'steps', COALESCE(v_step_ids, '[]'::jsonb),
    'already_materialized', v_already_materialized,
    'superseded_policy_id', v_superseded_prior_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.materialize_lease_recovery_policy(UUID, UUID, UUID, TEXT, UUID, DATE, TEXT, UUID, DATE) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.materialize_lease_recovery_policy(UUID, UUID, UUID, TEXT, UUID, DATE, TEXT, UUID, DATE) TO service_role;

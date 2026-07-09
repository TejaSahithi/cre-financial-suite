-- Enterprise hardening Phase 6D-1: save_lease_expense_rule_set.
--
-- Replaces leaseExpenseRuleService.js::saveRuleSet's mechanical persistence
-- step (today: 3 independent, unguarded Supabase calls -- rule_set
-- insert/update, a 12-attempt strip-missing-column rules upsert, then
-- separate lease_expense_values/lease_expense_rule_clauses delete+insert
-- pairs -- with ZERO audit logging anywhere in the file) with one RPC, one
-- transaction, one canonical audit_logs row.
--
-- Per the confirmed narrow-scope decision (see plan file Phase 6D-1): this
-- RPC does NOT re-derive any of the ~20 deriveRule*() decision functions,
-- the evidence-alignment version-bump detection, or the protected-human-row
-- merge/preservation logic -- all of that stays entirely client-side,
-- unchanged. The client still computes the exact same final rule/value/
-- clause payloads it does today; this RPC only performs the mechanical
-- multi-table write plus narrow org/lease boundary validation.
--
-- Two further narrowings decided during implementation (kept out of this
-- RPC deliberately, matching the "narrow persist+audit+atomicity" scope):
--   1. Rule-set STATUS RECALCULATION (recalculateRuleSetStatus /
--      deriveRuleSetStatusFromRules) is NOT ported here -- it depends on
--      ruleDecisionEngine.js's ~20-function decision cascade (the same
--      engine already judged too large/risky to port for classifyExpenses()
--      in Phase 3). It remains a separate, unchanged client-side call made
--      by the caller immediately after this RPC succeeds.
--   2. save_lease_config is NOT called from inside this RPC when
--      status='approved'. Its inputs are built by buildLeaseConfigFromRules()
--      (a derivation over the freshly-persisted rules), which is itself
--      client-side logic -- so that conditional call stays a separate,
--      unchanged client-side call made after this RPC returns and the
--      caller re-loads the rule set.
--
-- Rule/value/clause identity: p_values/p_clauses reference rules by
-- rule_key (not rule_id), since the client doesn't know newly-created
-- rules' ids in advance -- a deliberate improvement over the original
-- code's expense_category_id-based matching (rulesByCategoryId), which
-- was not guaranteed unique when multiple rules share a category.
--
-- Schema drift found during investigation (not fixed here, out of scope):
-- three fields the current client code sends per save --
-- lease_expense_rule_sets.extraction_version, and
-- lease_expense_rules.source_hash / approved_lease_abstract_id -- do not
-- exist as columns anywhere in this schema (confirmed via
-- information_schema.columns). For lease_expense_rules, the existing
-- strip-missing-column retry loop already silently drops these three
-- fields on every save. For lease_expense_rule_sets there is no such retry
-- loop, so the client's .insert()/.update() calls that include
-- extraction_version have always thrown PGRST204/42703 today -- this RPC
-- necessarily omits that column (there is nothing to "preserve", since it
-- has never successfully persisted). p_extraction_version is still threaded
-- into this RPC purely for audit metadata, where it's useful even without a
-- dedicated column.

CREATE OR REPLACE FUNCTION public.save_lease_expense_rule_set(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_rule_set_id UUID,
  p_version INTEGER,
  p_status TEXT,
  p_extraction_version TEXT,
  p_property_id UUID,
  p_rules JSONB,
  p_values JSONB,
  p_clauses JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_lease public.leases%ROWTYPE;
  v_rule_set_before JSONB;
  v_rule_set public.lease_expense_rule_sets%ROWTYPE;
  v_rule_set_action TEXT;
  v_rule_count INTEGER := 0;
  v_value_count INTEGER := 0;
  v_clause_count INTEGER := 0;
  v_rule_ids UUID[];
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_lease_id IS NULL THEN
    RAISE EXCEPTION 'lease_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF COALESCE(p_status, '') = '' THEN
    RAISE EXCEPTION 'status is required';
  END IF;

  SELECT * INTO v_lease FROM public.leases WHERE id = p_lease_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;

  -- ── Rule set: update if p_rule_set_id given, else create ──────────────
  IF p_rule_set_id IS NOT NULL THEN
    SELECT to_jsonb(s) INTO v_rule_set_before
      FROM public.lease_expense_rule_sets s
     WHERE s.id = p_rule_set_id AND s.org_id = p_org_id AND s.lease_id = p_lease_id;
    IF v_rule_set_before IS NULL THEN
      RAISE EXCEPTION 'Rule set not found for this lease/organization';
    END IF;

    UPDATE public.lease_expense_rule_sets
       SET status = p_status,
           property_id = p_property_id,
           approved_at = CASE WHEN p_status = 'approved' THEN v_now ELSE NULL END,
           updated_at = v_now
     WHERE id = p_rule_set_id AND org_id = p_org_id AND lease_id = p_lease_id
    RETURNING * INTO v_rule_set;

    v_rule_set_action := 'updated';
  ELSE
    INSERT INTO public.lease_expense_rule_sets (
      org_id, lease_id, property_id, version, status, created_by, approved_by, approved_at
    ) VALUES (
      p_org_id, p_lease_id, p_property_id, COALESCE(p_version, 1), p_status, p_actor_user_id,
      CASE WHEN p_status = 'approved' THEN p_actor_user_id ELSE NULL END,
      CASE WHEN p_status = 'approved' THEN v_now ELSE NULL END
    )
    RETURNING * INTO v_rule_set;

    v_rule_set_action := 'created';
    v_rule_set_before := NULL;
  END IF;

  -- ── Rules: upsert on (lease_id, rule_key), same conflict target as today ──
  CREATE TEMP TABLE IF NOT EXISTS tmp_save_rule_set_rules (id UUID, rule_key TEXT) ON COMMIT DROP;
  TRUNCATE tmp_save_rule_set_rules;

  WITH ins AS (
    INSERT INTO public.lease_expense_rules (
      id, rule_set_id, expense_category_id, row_status, mentioned_in_lease, is_recoverable, is_excluded,
      is_controllable, is_subject_to_cap, cap_type, cap_value, has_base_year, base_year_type,
      gross_up_applicable, admin_fee_applicable, admin_fee_percent, notes, confidence, source,
      org_id, lease_id, tenant_id, property_id, building_id, unit_id, expense_category, expense_subcategory,
      included_in_base_rent, recoverable_from_tenant, recovery_method, allocation_basis,
      cap_amount, cap_percent, gross_up_percent, base_year, base_year_amount, expense_stop_amount,
      billing_frequency, reconciliation_required, reconciliation_frequency, exact_source_text,
      confidence_score, extraction_status, review_status, approval_status, published_to_cam,
      operational_responsibility, payment_treatment, cam_eligible, billing_treatment, approved_by,
      approved_at, rule_key, rule_type, estimated_annual_amount, estimated_monthly_amount,
      tenant_share_percent, created_from, generation_source, source_field_key
    )
    SELECT
      COALESCE(r.id, gen_random_uuid()),
      v_rule_set.id,
      r.expense_category_id,
      r.row_status,
      COALESCE(r.mentioned_in_lease, false),
      COALESCE(r.is_recoverable, false),
      COALESCE(r.is_excluded, false),
      COALESCE(r.is_controllable, false),
      COALESCE(r.is_subject_to_cap, false),
      r.cap_type,
      r.cap_value,
      COALESCE(r.has_base_year, false),
      r.base_year_type,
      COALESCE(r.gross_up_applicable, false),
      COALESCE(r.admin_fee_applicable, false),
      r.admin_fee_percent,
      r.notes,
      r.confidence,
      r.source,
      COALESCE(r.org_id, p_org_id),
      COALESCE(r.lease_id, p_lease_id),
      r.tenant_id,
      r.property_id,
      r.building_id,
      r.unit_id,
      r.expense_category,
      r.expense_subcategory,
      COALESCE(r.included_in_base_rent, false),
      r.recoverable_from_tenant,
      r.recovery_method,
      r.allocation_basis,
      r.cap_amount,
      r.cap_percent,
      r.gross_up_percent,
      r.base_year,
      r.base_year_amount,
      r.expense_stop_amount,
      r.billing_frequency,
      COALESCE(r.reconciliation_required, false),
      r.reconciliation_frequency,
      r.exact_source_text,
      r.confidence_score,
      r.extraction_status,
      r.review_status,
      r.approval_status,
      COALESCE(r.published_to_cam, false),
      r.operational_responsibility,
      r.payment_treatment,
      r.cam_eligible,
      r.billing_treatment,
      r.approved_by,
      r.approved_at,
      r.rule_key,
      r.rule_type,
      r.estimated_annual_amount,
      r.estimated_monthly_amount,
      r.tenant_share_percent,
      r.created_from,
      r.generation_source,
      r.source_field_key
    FROM jsonb_to_recordset(COALESCE(p_rules, '[]'::jsonb)) AS r(
      id UUID, expense_category_id UUID, row_status TEXT, mentioned_in_lease BOOLEAN, is_recoverable BOOLEAN,
      is_excluded BOOLEAN, is_controllable BOOLEAN, is_subject_to_cap BOOLEAN, cap_type TEXT, cap_value NUMERIC,
      has_base_year BOOLEAN, base_year_type TEXT, gross_up_applicable BOOLEAN, admin_fee_applicable BOOLEAN,
      admin_fee_percent NUMERIC, notes TEXT, confidence NUMERIC, source TEXT, org_id UUID, lease_id UUID,
      tenant_id UUID, property_id UUID, building_id UUID, unit_id UUID, expense_category TEXT,
      expense_subcategory TEXT, included_in_base_rent BOOLEAN, recoverable_from_tenant TEXT,
      recovery_method TEXT, allocation_basis TEXT, cap_amount NUMERIC, cap_percent NUMERIC,
      gross_up_percent NUMERIC, base_year TEXT, base_year_amount NUMERIC, expense_stop_amount NUMERIC,
      billing_frequency TEXT, reconciliation_required BOOLEAN, reconciliation_frequency TEXT,
      exact_source_text TEXT, confidence_score NUMERIC, extraction_status TEXT, review_status TEXT,
      approval_status TEXT, published_to_cam BOOLEAN, operational_responsibility TEXT, payment_treatment TEXT,
      cam_eligible TEXT, billing_treatment TEXT, approved_by UUID, approved_at TIMESTAMPTZ, rule_key TEXT,
      rule_type TEXT, estimated_annual_amount NUMERIC, estimated_monthly_amount NUMERIC,
      tenant_share_percent NUMERIC, created_from TEXT, generation_source TEXT, source_field_key TEXT
    )
    ON CONFLICT (lease_id, rule_key) DO UPDATE SET
      rule_set_id = EXCLUDED.rule_set_id,
      expense_category_id = EXCLUDED.expense_category_id,
      row_status = EXCLUDED.row_status,
      mentioned_in_lease = EXCLUDED.mentioned_in_lease,
      is_recoverable = EXCLUDED.is_recoverable,
      is_excluded = EXCLUDED.is_excluded,
      is_controllable = EXCLUDED.is_controllable,
      is_subject_to_cap = EXCLUDED.is_subject_to_cap,
      cap_type = EXCLUDED.cap_type,
      cap_value = EXCLUDED.cap_value,
      has_base_year = EXCLUDED.has_base_year,
      base_year_type = EXCLUDED.base_year_type,
      gross_up_applicable = EXCLUDED.gross_up_applicable,
      admin_fee_applicable = EXCLUDED.admin_fee_applicable,
      admin_fee_percent = EXCLUDED.admin_fee_percent,
      notes = EXCLUDED.notes,
      confidence = EXCLUDED.confidence,
      source = EXCLUDED.source,
      org_id = EXCLUDED.org_id,
      tenant_id = EXCLUDED.tenant_id,
      property_id = EXCLUDED.property_id,
      building_id = EXCLUDED.building_id,
      unit_id = EXCLUDED.unit_id,
      expense_category = EXCLUDED.expense_category,
      expense_subcategory = EXCLUDED.expense_subcategory,
      included_in_base_rent = EXCLUDED.included_in_base_rent,
      recoverable_from_tenant = EXCLUDED.recoverable_from_tenant,
      recovery_method = EXCLUDED.recovery_method,
      allocation_basis = EXCLUDED.allocation_basis,
      cap_amount = EXCLUDED.cap_amount,
      cap_percent = EXCLUDED.cap_percent,
      gross_up_percent = EXCLUDED.gross_up_percent,
      base_year = EXCLUDED.base_year,
      base_year_amount = EXCLUDED.base_year_amount,
      expense_stop_amount = EXCLUDED.expense_stop_amount,
      billing_frequency = EXCLUDED.billing_frequency,
      reconciliation_required = EXCLUDED.reconciliation_required,
      reconciliation_frequency = EXCLUDED.reconciliation_frequency,
      exact_source_text = EXCLUDED.exact_source_text,
      confidence_score = EXCLUDED.confidence_score,
      extraction_status = EXCLUDED.extraction_status,
      review_status = EXCLUDED.review_status,
      approval_status = EXCLUDED.approval_status,
      published_to_cam = EXCLUDED.published_to_cam,
      operational_responsibility = EXCLUDED.operational_responsibility,
      payment_treatment = EXCLUDED.payment_treatment,
      cam_eligible = EXCLUDED.cam_eligible,
      billing_treatment = EXCLUDED.billing_treatment,
      approved_by = EXCLUDED.approved_by,
      approved_at = EXCLUDED.approved_at,
      rule_type = EXCLUDED.rule_type,
      estimated_annual_amount = EXCLUDED.estimated_annual_amount,
      estimated_monthly_amount = EXCLUDED.estimated_monthly_amount,
      tenant_share_percent = EXCLUDED.tenant_share_percent,
      created_from = EXCLUDED.created_from,
      generation_source = EXCLUDED.generation_source,
      source_field_key = EXCLUDED.source_field_key,
      updated_at = v_now
    RETURNING id, rule_key
  )
  INSERT INTO tmp_save_rule_set_rules (id, rule_key)
  SELECT id, rule_key FROM ins;
  GET DIAGNOSTICS v_rule_count = ROW_COUNT;

  SELECT array_agg(id) INTO v_rule_ids FROM tmp_save_rule_set_rules;

  -- ── Values: replace scoped to this save's rules, matched by rule_key ──
  DELETE FROM public.lease_expense_values
   WHERE rule_id = ANY(COALESCE(v_rule_ids, ARRAY[]::uuid[]));

  INSERT INTO public.lease_expense_values (
    rule_id, base_year_amount, extracted_value, manual_value, final_value, frequency, value_source
  )
  SELECT tsr.id, v.base_year_amount, v.extracted_value, v.manual_value, v.final_value, v.frequency, v.value_source
  FROM jsonb_to_recordset(COALESCE(p_values, '[]'::jsonb)) AS v(
    rule_key TEXT, base_year_amount NUMERIC, extracted_value NUMERIC, manual_value NUMERIC,
    final_value NUMERIC, frequency TEXT, value_source TEXT
  )
  JOIN tmp_save_rule_set_rules tsr ON tsr.rule_key = v.rule_key;
  GET DIAGNOSTICS v_value_count = ROW_COUNT;

  -- ── Clauses: replace scoped to this save's rules, matched by rule_key ──
  DELETE FROM public.lease_expense_rule_clauses
   WHERE lease_expense_rule_id = ANY(COALESCE(v_rule_ids, ARRAY[]::uuid[]));

  INSERT INTO public.lease_expense_rule_clauses (
    lease_expense_rule_id, lease_id, page_number, clause_type, clause_text, confidence
  )
  SELECT tsr.id, p_lease_id, c.page_number, c.clause_type, c.clause_text, c.confidence
  FROM jsonb_to_recordset(COALESCE(p_clauses, '[]'::jsonb)) AS c(
    rule_key TEXT, page_number INTEGER, clause_type TEXT, clause_text TEXT, confidence NUMERIC
  )
  JOIN tmp_save_rule_set_rules tsr ON tsr.rule_key = c.rule_key;
  GET DIAGNOSTICS v_clause_count = ROW_COUNT;

  -- ── One canonical audit row for the whole save ─────────────────────────
  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_rule_set.property_id,
    'LeaseExpenseRuleSet',
    v_rule_set.id::TEXT,
    'lease_expense_rule_set_saved',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_rule_set_before,
    to_jsonb(v_rule_set),
    jsonb_build_object(
      'lease_id', p_lease_id,
      'rule_set_action', v_rule_set_action,
      'status', p_status,
      'extraction_version', p_extraction_version,
      'rule_count', v_rule_count,
      'value_count', v_value_count,
      'clause_count', v_clause_count,
      'rule_ids', to_jsonb(COALESCE(v_rule_ids, ARRAY[]::uuid[]))
    ),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'rule_set_id', v_rule_set.id,
    'rule_set_version', v_rule_set.version,
    'rule_set_status', v_rule_set.status,
    'rule_ids', to_jsonb(COALESCE(v_rule_ids, ARRAY[]::uuid[])),
    'rule_count', v_rule_count,
    'value_count', v_value_count,
    'clause_count', v_clause_count,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- SECURITY DEFINER runs as the function owner and bypasses RLS entirely --
-- authorization is enforced solely by the save-lease-expense-rule-set edge
-- function's assertPageAccess() call, so EXECUTE must be restricted to
-- service_role only (matching the correction already applied to
-- review_expense_classification in 20260710000000). Granting authenticated
-- would let any org member call this RPC directly via the client SDK,
-- bypassing that check entirely.
REVOKE ALL ON FUNCTION public.save_lease_expense_rule_set(
  UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, TEXT, UUID, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_lease_expense_rule_set(
  UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, TEXT, UUID, JSONB, JSONB, JSONB
) TO service_role;

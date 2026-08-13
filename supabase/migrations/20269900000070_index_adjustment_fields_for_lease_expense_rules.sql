-- Add durable index/CPI adjustment terms to lease expense rules.
--
-- These fields are intentionally generic: CPI is one index-adjustment type,
-- but leases may reference another published index or an approved reviewed
-- assumption. Keeping this as contract data prevents CPI from being buried in
-- notes and lost before expense classification or CAM review.

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS index_adjustment_applicable BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS index_adjustment_type TEXT,
  ADD COLUMN IF NOT EXISTS index_name TEXT,
  ADD COLUMN IF NOT EXISTS index_base_period TEXT,
  ADD COLUMN IF NOT EXISTS index_current_period TEXT,
  ADD COLUMN IF NOT EXISTS index_adjustment_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS index_floor_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS index_cap_percent NUMERIC,
  ADD COLUMN IF NOT EXISTS index_adjustment_frequency TEXT,
  ADD COLUMN IF NOT EXISTS index_source TEXT;

CREATE OR REPLACE FUNCTION public.update_lease_expense_rule(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_rule_id UUID,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_rule public.lease_expense_rules%ROWTYPE;
  v_updated public.lease_expense_rules%ROWTYPE;
  v_key TEXT;
  v_audit_log_id UUID;
  v_response JSONB;
  v_allowed_keys TEXT[] := ARRAY[
    'expense_category', 'expense_subcategory', 'included_in_base_rent',
    'operational_responsibility', 'payment_treatment', 'recoverable_from_tenant',
    'cam_eligible', 'recovery_method', 'allocation_basis', 'cap_type', 'cap_percent',
    'cap_amount', 'admin_fee_applicable', 'admin_fee_percent', 'gross_up_applicable',
    'gross_up_percent', 'reconciliation_required',
    'index_adjustment_applicable', 'index_adjustment_type', 'index_name',
    'index_base_period', 'index_current_period', 'index_adjustment_percent',
    'index_floor_percent', 'index_cap_percent', 'index_adjustment_frequency',
    'index_source', 'notes'
  ];
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
  IF p_rule_id IS NULL THEN
    RAISE EXCEPTION 'rule_id is required';
  END IF;
  IF jsonb_typeof(COALESCE(p_patch, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'patch must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_patch) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'field % is not permitted', v_key;
    END IF;
  END LOOP;

  SELECT *
    INTO v_rule
    FROM public.lease_expense_rules
   WHERE id = p_rule_id AND org_id = p_org_id AND lease_id = p_lease_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this lease/organization';
  END IF;

  UPDATE public.lease_expense_rules SET
    expense_category = CASE WHEN p_patch ? 'expense_category' THEN p_patch->>'expense_category' ELSE expense_category END,
    expense_subcategory = CASE WHEN p_patch ? 'expense_subcategory' THEN p_patch->>'expense_subcategory' ELSE expense_subcategory END,
    included_in_base_rent = CASE WHEN p_patch ? 'included_in_base_rent' THEN (p_patch->>'included_in_base_rent')::boolean ELSE included_in_base_rent END,
    operational_responsibility = CASE WHEN p_patch ? 'operational_responsibility' THEN p_patch->>'operational_responsibility' ELSE operational_responsibility END,
    payment_treatment = CASE WHEN p_patch ? 'payment_treatment' THEN p_patch->>'payment_treatment' ELSE payment_treatment END,
    recoverable_from_tenant = CASE WHEN p_patch ? 'recoverable_from_tenant' THEN p_patch->>'recoverable_from_tenant' ELSE recoverable_from_tenant END,
    cam_eligible = CASE WHEN p_patch ? 'cam_eligible' THEN p_patch->>'cam_eligible' ELSE cam_eligible END,
    recovery_method = CASE WHEN p_patch ? 'recovery_method' THEN p_patch->>'recovery_method' ELSE recovery_method END,
    allocation_basis = CASE WHEN p_patch ? 'allocation_basis' THEN p_patch->>'allocation_basis' ELSE allocation_basis END,
    cap_type = CASE WHEN p_patch ? 'cap_type' THEN p_patch->>'cap_type' ELSE cap_type END,
    cap_percent = CASE WHEN p_patch ? 'cap_percent' THEN (p_patch->>'cap_percent')::numeric ELSE cap_percent END,
    cap_amount = CASE WHEN p_patch ? 'cap_amount' THEN (p_patch->>'cap_amount')::numeric ELSE cap_amount END,
    admin_fee_applicable = CASE WHEN p_patch ? 'admin_fee_applicable' THEN (p_patch->>'admin_fee_applicable')::boolean ELSE admin_fee_applicable END,
    admin_fee_percent = CASE WHEN p_patch ? 'admin_fee_percent' THEN (p_patch->>'admin_fee_percent')::numeric ELSE admin_fee_percent END,
    gross_up_applicable = CASE WHEN p_patch ? 'gross_up_applicable' THEN (p_patch->>'gross_up_applicable')::boolean ELSE gross_up_applicable END,
    gross_up_percent = CASE WHEN p_patch ? 'gross_up_percent' THEN (p_patch->>'gross_up_percent')::numeric ELSE gross_up_percent END,
    reconciliation_required = CASE WHEN p_patch ? 'reconciliation_required' THEN (p_patch->>'reconciliation_required')::boolean ELSE reconciliation_required END,
    index_adjustment_applicable = CASE WHEN p_patch ? 'index_adjustment_applicable' THEN COALESCE((p_patch->>'index_adjustment_applicable')::boolean, false) ELSE index_adjustment_applicable END,
    index_adjustment_type = CASE WHEN p_patch ? 'index_adjustment_type' THEN NULLIF(p_patch->>'index_adjustment_type', '') ELSE index_adjustment_type END,
    index_name = CASE WHEN p_patch ? 'index_name' THEN NULLIF(p_patch->>'index_name', '') ELSE index_name END,
    index_base_period = CASE WHEN p_patch ? 'index_base_period' THEN NULLIF(p_patch->>'index_base_period', '') ELSE index_base_period END,
    index_current_period = CASE WHEN p_patch ? 'index_current_period' THEN NULLIF(p_patch->>'index_current_period', '') ELSE index_current_period END,
    index_adjustment_percent = CASE WHEN p_patch ? 'index_adjustment_percent' THEN NULLIF(p_patch->>'index_adjustment_percent', '')::numeric ELSE index_adjustment_percent END,
    index_floor_percent = CASE WHEN p_patch ? 'index_floor_percent' THEN NULLIF(p_patch->>'index_floor_percent', '')::numeric ELSE index_floor_percent END,
    index_cap_percent = CASE WHEN p_patch ? 'index_cap_percent' THEN NULLIF(p_patch->>'index_cap_percent', '')::numeric ELSE index_cap_percent END,
    index_adjustment_frequency = CASE WHEN p_patch ? 'index_adjustment_frequency' THEN NULLIF(p_patch->>'index_adjustment_frequency', '') ELSE index_adjustment_frequency END,
    index_source = CASE WHEN p_patch ? 'index_source' THEN NULLIF(p_patch->>'index_source', '') ELSE index_source END,
    notes = CASE WHEN p_patch ? 'notes' THEN p_patch->>'notes' ELSE notes END,
    updated_at = v_now
   WHERE id = p_rule_id AND org_id = p_org_id AND lease_id = p_lease_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'LeaseExpenseRule', v_updated.id::TEXT,
    'lease_expense_rule_updated', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_rule), to_jsonb(v_updated),
    jsonb_build_object('rule_set_id', v_updated.rule_set_id, 'patch_keys', to_jsonb((SELECT array_agg(k) FROM jsonb_object_keys(p_patch) AS k))),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'rule', to_jsonb(v_updated),
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.update_lease_expense_rule(
  UUID, UUID, UUID, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_lease_expense_rule(
  UUID, UUID, UUID, TEXT, UUID, JSONB
) TO service_role;

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
  p_clauses JSONB,
  p_superseded_rule_ids UUID[] DEFAULT NULL
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
  v_superseded_count INTEGER := 0;
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

  -- Ã¢â€â‚¬Ã¢â€â‚¬ Rule set: update if p_rule_set_id given, else create Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

  -- Ã¢â€â‚¬Ã¢â€â‚¬ Supersede: delete stale unresolved rules the client has already
  -- identified as not-protected (isProtectedHumanRule filtering stays
  -- client-side) BEFORE the fresh upsert. Folded into this transaction
  -- (was previously a separate, unguarded client-side delete/update-fallback
  -- call before this RPC ever ran -- a genuine atomicity gap). SECURITY
  -- DEFINER bypasses RLS, so no update-fallback-for-RLS-denial is needed
  -- here; a plain DELETE always succeeds.
  IF p_superseded_rule_ids IS NOT NULL AND array_length(p_superseded_rule_ids, 1) > 0 THEN
    DELETE FROM public.lease_expense_rules
     WHERE id = ANY(p_superseded_rule_ids)
       AND lease_id = p_lease_id
       AND org_id = p_org_id;
    GET DIAGNOSTICS v_superseded_count = ROW_COUNT;
  END IF;

  -- Ã¢â€â‚¬Ã¢â€â‚¬ Rules: upsert on (lease_id, rule_key), same conflict target as today Ã¢â€â‚¬Ã¢â€â‚¬
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
      billing_frequency, reconciliation_required, reconciliation_frequency,
      index_adjustment_applicable, index_adjustment_type, index_name, index_base_period,
      index_current_period, index_adjustment_percent, index_floor_percent, index_cap_percent,
      index_adjustment_frequency, index_source, exact_source_text,
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
      COALESCE(r.index_adjustment_applicable, false),
      NULLIF(r.index_adjustment_type, ''),
      NULLIF(r.index_name, ''),
      NULLIF(r.index_base_period, ''),
      NULLIF(r.index_current_period, ''),
      r.index_adjustment_percent,
      r.index_floor_percent,
      r.index_cap_percent,
      NULLIF(r.index_adjustment_frequency, ''),
      NULLIF(r.index_source, ''),
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
      index_adjustment_applicable BOOLEAN, index_adjustment_type TEXT, index_name TEXT,
      index_base_period TEXT, index_current_period TEXT, index_adjustment_percent NUMERIC,
      index_floor_percent NUMERIC, index_cap_percent NUMERIC, index_adjustment_frequency TEXT,
      index_source TEXT, exact_source_text TEXT, confidence_score NUMERIC, extraction_status TEXT, review_status TEXT,
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
      index_adjustment_applicable = EXCLUDED.index_adjustment_applicable,
      index_adjustment_type = EXCLUDED.index_adjustment_type,
      index_name = EXCLUDED.index_name,
      index_base_period = EXCLUDED.index_base_period,
      index_current_period = EXCLUDED.index_current_period,
      index_adjustment_percent = EXCLUDED.index_adjustment_percent,
      index_floor_percent = EXCLUDED.index_floor_percent,
      index_cap_percent = EXCLUDED.index_cap_percent,
      index_adjustment_frequency = EXCLUDED.index_adjustment_frequency,
      index_source = EXCLUDED.index_source,
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

  -- Ã¢â€â‚¬Ã¢â€â‚¬ Values: replace scoped to this save's rules, matched by rule_key Ã¢â€â‚¬Ã¢â€â‚¬
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

  -- Ã¢â€â‚¬Ã¢â€â‚¬ Clauses: replace scoped to this save's rules, matched by rule_key Ã¢â€â‚¬Ã¢â€â‚¬
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

  -- Ã¢â€â‚¬Ã¢â€â‚¬ One canonical audit row for the whole save Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
      'superseded_count', v_superseded_count,
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
    'superseded_count', v_superseded_count,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.save_lease_expense_rule_set(
  UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, TEXT, UUID, JSONB, JSONB, JSONB, UUID[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.save_lease_expense_rule_set(
  UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, TEXT, UUID, JSONB, JSONB, JSONB, UUID[]
) TO service_role;

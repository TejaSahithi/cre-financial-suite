-- Enterprise hardening Phase 6R-2: lease-expense-rule cluster cleanup.
--
-- Closes the 4 remaining direct-write blockers on lease_expense_rule_sets /
-- lease_expense_rules found by Phase 6R's readiness audit:
--
--   1. recalculateRuleSetStatus() -- direct update to
--      lease_expense_rule_sets.status/approved_at, computed client-side via
--      deriveRuleSetStatusFromRules() (the ~20-function decision cascade
--      already judged too large to port, per save_lease_expense_rule_set's
--      own precedent). The DECISION stays client-side, unchanged; only the
--      mechanical write moves server-side -> new RPC
--      update_lease_expense_rule_set_status.
--   2. supersedeUnresolvedRules() -- direct delete (with an update-fallback
--      for RLS-denial) of stale unresolved lease_expense_rules rows, run
--      client-side BEFORE save_lease_expense_rule_set's RPC call. Which
--      rows are "stale/unresolved" is decided via isProtectedHumanRule()
--      (itself dependent on the large rule decision engine) -- that
--      decision stays client-side, unchanged. The mechanical delete moves
--      into save_lease_expense_rule_set itself (new p_superseded_rule_ids
--      param), closing a real atomicity gap: today this delete and the
--      RPC's upsert are two separate, unguarded calls, so a crash between
--      them could leave a rule_set with stale rows deleted but fresh rows
--      not yet written. Folding it into the same transaction also lets the
--      update-fallback-for-RLS-denial complexity be dropped entirely --
--      SECURITY DEFINER bypasses RLS, so a straightforward DELETE always
--      succeeds here.
--   3. LeaseExpenseRules.jsx's rule-editor dialog ("Save" button,
--      saveRuleEdits/updateRuleMutation) -- direct update of ~18 business
--      fields on one lease_expense_rules row -> new RPC
--      update_lease_expense_rule, with a fixed field whitelist matching
--      exactly what the dialog sends today (see LeaseExpenseRules.jsx's
--      saveRuleEdits). The 6 hierarchy fields the client also sends
--      (buildRuleHierarchyPatch: org_id/lease_id/property_id/building_id/
--      unit_id/tenant_id) are NOT in the whitelist -- they're always
--      re-stamped with the row's own existing (unchanged) values in
--      practice, so the RPC simply leaves them alone rather than accepting
--      them as arbitrary patch keys.
--   4. expenseService.js's createLeaseRuleAmountCamInput -- direct update
--      of estimated_annual_amount/estimated_monthly_amount only -> new RPC
--      update_lease_expense_rule_amount. That function ALSO writes
--      expense_classifications (a "rule_missing_actual" bookkeeping row)
--      -- that write is explicitly OUT of scope for this pass (belongs to
--      the separate "expense-workflow cluster" flagged in Phase 6R's
--      report, not the lease-expense-rule cluster) and stays direct,
--      unchanged.
--
-- None of lease_expense_rule_sets/lease_expense_rules/lease_expense_values/
-- lease_expense_rule_clauses have any audit-writing trigger (confirmed via
-- information_schema.triggers), so none of these RPCs need a
-- transaction-local GUC -- unlike the leases-table RPCs, there is no
-- trigger-duplicate-audit risk here.
--
-- Not ported: the ~20-function rule decision engine
-- (ruleDecisionEngine.js/deriveRuleSetStatusFromRules/isProtectedHumanRule)
-- stays entirely client-side. Not touched: lease_expense_values/
-- lease_expense_rule_clauses direct-write surfaces (already fully migrated
-- per Phase 6R's audit, aside from the lease-deletion cascade fallback,
-- which is a separate, already-flagged item).

-- ── 1. update_lease_expense_rule_set_status ─────────────────────────────
CREATE OR REPLACE FUNCTION public.update_lease_expense_rule_set_status(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_rule_set_id UUID,
  p_status TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_rule_set public.lease_expense_rule_sets%ROWTYPE;
  v_updated public.lease_expense_rule_sets%ROWTYPE;
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
  IF p_rule_set_id IS NULL THEN
    RAISE EXCEPTION 'rule_set_id is required';
  END IF;
  IF p_status NOT IN ('draft', 'needs_review', 'approved') THEN
    RAISE EXCEPTION 'status must be one of draft, needs_review, approved';
  END IF;

  SELECT *
    INTO v_rule_set
    FROM public.lease_expense_rule_sets
   WHERE id = p_rule_set_id AND org_id = p_org_id AND lease_id = p_lease_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Rule set not found for this lease/organization';
  END IF;

  UPDATE public.lease_expense_rule_sets
     SET status = p_status,
         approved_at = CASE WHEN p_status = 'approved' THEN v_now ELSE NULL END,
         updated_at = v_now
   WHERE id = p_rule_set_id AND org_id = p_org_id AND lease_id = p_lease_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'LeaseExpenseRuleSet', v_updated.id::TEXT,
    'lease_expense_rule_set_status_recalculated', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_rule_set), to_jsonb(v_updated),
    jsonb_build_object('status', p_status), v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'rule_set_id', v_updated.id,
    'status', v_updated.status,
    'approved_at', v_updated.approved_at,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.update_lease_expense_rule_set_status(
  UUID, UUID, UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_lease_expense_rule_set_status(
  UUID, UUID, UUID, TEXT, UUID, TEXT
) TO service_role;

-- ── 2. update_lease_expense_rule (rule-editor dialog) ───────────────────
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
    'gross_up_percent', 'reconciliation_required', 'notes'
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

-- ── 3. update_lease_expense_rule_amount (CAM amount input) ──────────────
CREATE OR REPLACE FUNCTION public.update_lease_expense_rule_amount(
  p_org_id UUID,
  p_lease_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_rule_id UUID,
  p_amount NUMERIC
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
  IF p_rule_id IS NULL THEN
    RAISE EXCEPTION 'rule_id is required';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN
    RAISE EXCEPTION 'amount must be a non-negative number';
  END IF;

  SELECT *
    INTO v_rule
    FROM public.lease_expense_rules
   WHERE id = p_rule_id AND org_id = p_org_id AND lease_id = p_lease_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Lease expense rule not found for this lease/organization';
  END IF;

  UPDATE public.lease_expense_rules
     SET estimated_annual_amount = p_amount,
         estimated_monthly_amount = p_amount / 12,
         updated_at = v_now
   WHERE id = p_rule_id AND org_id = p_org_id AND lease_id = p_lease_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'LeaseExpenseRule', v_updated.id::TEXT,
    'lease_expense_rule_amount_updated', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_rule), to_jsonb(v_updated),
    jsonb_build_object('amount', p_amount), v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'rule', to_jsonb(v_updated),
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.update_lease_expense_rule_amount(
  UUID, UUID, UUID, TEXT, UUID, NUMERIC
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_lease_expense_rule_amount(
  UUID, UUID, UUID, TEXT, UUID, NUMERIC
) TO service_role;

-- ── 4. save_lease_expense_rule_set: fold in the supersede-delete step ───
-- Adds p_superseded_rule_ids (new trailing param) -- the old 12-arg
-- signature must be dropped explicitly first (Postgres treats an added
-- parameter as a new overload, not a replacement -- the same gotcha this
-- session already hit for delete_lease_cascade and review_expense_classification).
DROP FUNCTION IF EXISTS public.save_lease_expense_rule_set(
  UUID, UUID, UUID, TEXT, UUID, INTEGER, TEXT, TEXT, UUID, JSONB, JSONB, JSONB
);

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

  -- ── Supersede: delete stale unresolved rules the client has already
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

-- Align all actual-expense write paths with the same persisted contract.
-- Manual entry, invoice review submit, and bulk import all write to public.expenses.
-- Lease-derived contract rules stay in lease_expense_rule_sets / lease_expense_rules.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES public.portfolios(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS building_id UUID REFERENCES public.buildings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES public.units(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lease_id UUID REFERENCES public.leases(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES public.tenants(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tenant_name TEXT,
  ADD COLUMN IF NOT EXISTS expense_category_id UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expense_subcategory TEXT,
  ADD COLUMN IF NOT EXISTS vendor_name TEXT,
  ADD COLUMN IF NOT EXISTS vendor_id UUID REFERENCES public.vendors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS gl_code TEXT,
  ADD COLUMN IF NOT EXISTS invoice_number TEXT,
  ADD COLUMN IF NOT EXISTS expense_date DATE,
  ADD COLUMN IF NOT EXISTS billing_period_start DATE,
  ADD COLUMN IF NOT EXISTS billing_period_end DATE,
  ADD COLUMN IF NOT EXISTS service_period_start DATE,
  ADD COLUMN IF NOT EXISTS service_period_end DATE,
  ADD COLUMN IF NOT EXISTS source_type TEXT,
  ADD COLUMN IF NOT EXISTS source_file_id UUID,
  ADD COLUMN IF NOT EXISTS attachment_url TEXT,
  ADD COLUMN IF NOT EXISTS approval_status TEXT DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS approved_status TEXT DEFAULT 'approved',
  ADD COLUMN IF NOT EXISTS review_status TEXT,
  ADD COLUMN IF NOT EXISTS recovery_status TEXT,
  ADD COLUMN IF NOT EXISTS recoverability_result TEXT,
  ADD COLUMN IF NOT EXISTS recovery_reason TEXT,
  ADD COLUMN IF NOT EXISTS recovery_method TEXT,
  ADD COLUMN IF NOT EXISTS rule_source TEXT,
  ADD COLUMN IF NOT EXISTS confidence_score NUMERIC,
  ADD COLUMN IF NOT EXISTS is_controllable BOOLEAN DEFAULT TRUE;

UPDATE public.expenses
SET
  expense_date = COALESCE(expense_date, date),
  service_period_start = COALESCE(service_period_start, date),
  service_period_end = COALESCE(service_period_end, date),
  billing_period_start = COALESCE(billing_period_start, service_period_start, date),
  billing_period_end = COALESCE(billing_period_end, service_period_end, date),
  vendor_name = COALESCE(vendor_name, vendor),
  source_type = COALESCE(source_type, source, 'manual'),
  recovery_status = COALESCE(recovery_status, classification, 'needs_review'),
  approval_status = COALESCE(approval_status, approved_status, 'approved'),
  approved_status = COALESCE(approved_status, approval_status, 'approved'),
  review_status = COALESCE(review_status, approval_status, approved_status, 'approved')
WHERE TRUE;

CREATE OR REPLACE FUNCTION public.create_expense_workflow(
  p_org_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_expense JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_expense public.expenses%ROWTYPE;
  v_audit_log_id UUID;
  v_key TEXT;
  v_property_id UUID;
  v_expense_category_id UUID;
  v_building_id UUID;
  v_unit_id UUID;
  v_vendor_id UUID;
  v_lease_id UUID;
  v_tenant_id UUID;
  v_portfolio_id UUID;
  v_date DATE;
  v_amount NUMERIC;
  v_approval_status TEXT;
  v_review_status TEXT;
  v_recovery_status TEXT;
  v_source TEXT;
  v_allowed_keys TEXT[] := ARRAY[
    'date', 'expense_date', 'amount', 'category', 'expense_category_id', 'expense_subcategory',
    'vendor', 'vendor_name', 'vendor_id', 'description', 'classification', 'recovery_status',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'lease_id', 'tenant_id', 'tenant_name',
    'attachment_url', 'gl_code', 'invoice_number', 'source', 'source_type', 'source_file_id',
    'fiscal_year', 'month', 'approval_status', 'approved_status', 'review_status',
    'service_period_start', 'service_period_end', 'billing_period_start', 'billing_period_end',
    'confidence_score', 'is_controllable'
  ];
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF jsonb_typeof(COALESCE(p_expense, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'expense must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_expense) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'field % is not permitted', v_key;
    END IF;
  END LOOP;

  v_date := COALESCE(NULLIF(p_expense->>'date', '')::DATE, NULLIF(p_expense->>'expense_date', '')::DATE);
  v_amount := NULLIF(p_expense->>'amount', '')::NUMERIC;
  v_property_id := NULLIF(p_expense->>'property_id', '')::UUID;
  v_expense_category_id := NULLIF(p_expense->>'expense_category_id', '')::UUID;
  v_building_id := NULLIF(p_expense->>'building_id', '')::UUID;
  v_unit_id := NULLIF(p_expense->>'unit_id', '')::UUID;
  v_vendor_id := NULLIF(p_expense->>'vendor_id', '')::UUID;
  v_lease_id := NULLIF(p_expense->>'lease_id', '')::UUID;
  v_tenant_id := NULLIF(p_expense->>'tenant_id', '')::UUID;
  v_portfolio_id := NULLIF(p_expense->>'portfolio_id', '')::UUID;
  v_source := COALESCE(NULLIF(p_expense->>'source', ''), NULLIF(p_expense->>'source_type', ''), 'manual');
  v_approval_status := COALESCE(NULLIF(p_expense->>'approval_status', ''), NULLIF(p_expense->>'approved_status', ''), 'approved');
  v_review_status := COALESCE(NULLIF(p_expense->>'review_status', ''), v_approval_status);
  v_recovery_status := COALESCE(NULLIF(p_expense->>'recovery_status', ''), NULLIF(p_expense->>'classification', ''), 'needs_review');

  IF v_date IS NULL THEN RAISE EXCEPTION 'date is required'; END IF;
  IF v_amount IS NULL THEN RAISE EXCEPTION 'amount is required'; END IF;
  IF v_amount < 0 THEN RAISE EXCEPTION 'amount must be a non-negative number'; END IF;
  IF NULLIF(trim(COALESCE(p_expense->>'category', '')), '') IS NULL THEN RAISE EXCEPTION 'category is required'; END IF;
  IF NULLIF(trim(COALESCE(p_expense->>'vendor', '')), '') IS NULL THEN RAISE EXCEPTION 'vendor is required'; END IF;
  IF v_property_id IS NULL THEN RAISE EXCEPTION 'property_id is required'; END IF;
  IF v_expense_category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = v_expense_category_id AND (org_id IS NULL OR org_id = p_org_id)) THEN
    RAISE EXCEPTION 'Expense category not found for this organization';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = v_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property not found for this organization';
  END IF;
  IF v_building_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.buildings WHERE id = v_building_id AND org_id = p_org_id AND property_id = v_property_id) THEN
    RAISE EXCEPTION 'Building not found for this organization/property';
  END IF;
  IF v_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.units WHERE id = v_unit_id AND org_id = p_org_id AND property_id = v_property_id AND (v_building_id IS NULL OR building_id = v_building_id)) THEN
    RAISE EXCEPTION 'Unit not found for this organization/property/building';
  END IF;
  IF v_vendor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = v_vendor_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Vendor not found for this organization';
  END IF;
  IF v_lease_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leases WHERE id = v_lease_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;
  IF v_tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = v_tenant_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Tenant not found for this organization';
  END IF;
  IF v_portfolio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.portfolios WHERE id = v_portfolio_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Portfolio not found for this organization';
  END IF;

  PERFORM set_config('app.skip_expense_audit_trigger', 'true', true);

  INSERT INTO public.expenses (
    org_id, portfolio_id, property_id, building_id, unit_id, lease_id, tenant_id, tenant_name,
    category, expense_category_id, expense_subcategory, amount, classification, recovery_status,
    vendor, vendor_name, vendor_id, gl_code, invoice_number,
    fiscal_year, month, date, expense_date, billing_period_start, billing_period_end,
    service_period_start, service_period_end, source, source_type, source_file_id,
    description, attachment_url, approval_status, approved_status, review_status,
    confidence_score, is_controllable
  ) VALUES (
    p_org_id, v_portfolio_id, v_property_id, v_building_id, v_unit_id, v_lease_id, v_tenant_id, NULLIF(p_expense->>'tenant_name', ''),
    p_expense->>'category', v_expense_category_id, NULLIF(p_expense->>'expense_subcategory', ''), v_amount, NULLIF(p_expense->>'classification', ''), v_recovery_status,
    p_expense->>'vendor', COALESCE(NULLIF(p_expense->>'vendor_name', ''), NULLIF(p_expense->>'vendor', '')), v_vendor_id, NULLIF(p_expense->>'gl_code', ''), NULLIF(p_expense->>'invoice_number', ''),
    NULLIF(p_expense->>'fiscal_year', '')::INT, COALESCE(NULLIF(p_expense->>'month', '')::INT, EXTRACT(MONTH FROM v_date)::INT),
    v_date, COALESCE(NULLIF(p_expense->>'expense_date', '')::DATE, v_date),
    COALESCE(NULLIF(p_expense->>'billing_period_start', '')::DATE, NULLIF(p_expense->>'service_period_start', '')::DATE, v_date),
    COALESCE(NULLIF(p_expense->>'billing_period_end', '')::DATE, NULLIF(p_expense->>'service_period_end', '')::DATE, v_date),
    COALESCE(NULLIF(p_expense->>'service_period_start', '')::DATE, v_date),
    COALESCE(NULLIF(p_expense->>'service_period_end', '')::DATE, v_date),
    v_source, COALESCE(NULLIF(p_expense->>'source_type', ''), v_source), NULLIF(p_expense->>'source_file_id', '')::UUID,
    NULLIF(p_expense->>'description', ''), NULLIF(p_expense->>'attachment_url', ''),
    v_approval_status, v_approval_status, v_review_status,
    NULLIF(p_expense->>'confidence_score', '')::NUMERIC,
    COALESCE(NULLIF(p_expense->>'is_controllable', '')::BOOLEAN, TRUE)
  ) RETURNING * INTO v_expense;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  ) VALUES (
    p_org_id, v_expense.property_id, 'Expense', v_expense.id::TEXT, 'expense_created',
    p_actor_user_id, p_actor_email, 'info', 'edge_function', NULL, to_jsonb(v_expense),
    jsonb_build_object('source', v_expense.source, 'source_type', v_expense.source_type), v_now
  ) RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object('expense', to_jsonb(v_expense), 'audit_log_id', v_audit_log_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_expense_details(
  p_org_id UUID,
  p_expense_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_expense JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_before public.expenses%ROWTYPE;
  v_updated public.expenses%ROWTYPE;
  v_audit_log_id UUID;
  v_key TEXT;
  v_property_id UUID;
  v_expense_category_id UUID;
  v_building_id UUID;
  v_unit_id UUID;
  v_vendor_id UUID;
  v_lease_id UUID;
  v_tenant_id UUID;
  v_portfolio_id UUID;
  v_date DATE;
  v_amount NUMERIC;
  v_approval_status TEXT;
  v_review_status TEXT;
  v_recovery_status TEXT;
  v_source TEXT;
  v_allowed_keys TEXT[] := ARRAY[
    'date', 'expense_date', 'amount', 'category', 'expense_category_id', 'expense_subcategory',
    'vendor', 'vendor_name', 'vendor_id', 'description', 'classification', 'recovery_status',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'lease_id', 'tenant_id', 'tenant_name',
    'attachment_url', 'gl_code', 'invoice_number', 'source', 'source_type', 'source_file_id',
    'fiscal_year', 'month', 'approval_status', 'approved_status', 'review_status',
    'service_period_start', 'service_period_end', 'billing_period_start', 'billing_period_end',
    'confidence_score', 'is_controllable'
  ];
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_expense_id IS NULL THEN RAISE EXCEPTION 'expense_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF jsonb_typeof(COALESCE(p_expense, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'expense must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_expense) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'field % is not permitted', v_key;
    END IF;
  END LOOP;

  SELECT * INTO v_before FROM public.expenses WHERE id = p_expense_id AND org_id = p_org_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found for this organization'; END IF;

  v_date := COALESCE(NULLIF(p_expense->>'date', '')::DATE, NULLIF(p_expense->>'expense_date', '')::DATE, v_before.date);
  v_amount := COALESCE(NULLIF(p_expense->>'amount', '')::NUMERIC, v_before.amount);
  v_property_id := COALESCE(NULLIF(p_expense->>'property_id', '')::UUID, v_before.property_id);
  v_expense_category_id := CASE WHEN p_expense ? 'expense_category_id' THEN NULLIF(p_expense->>'expense_category_id', '')::UUID ELSE v_before.expense_category_id END;
  v_building_id := CASE WHEN p_expense ? 'building_id' THEN NULLIF(p_expense->>'building_id', '')::UUID ELSE v_before.building_id END;
  v_unit_id := CASE WHEN p_expense ? 'unit_id' THEN NULLIF(p_expense->>'unit_id', '')::UUID ELSE v_before.unit_id END;
  v_vendor_id := CASE WHEN p_expense ? 'vendor_id' THEN NULLIF(p_expense->>'vendor_id', '')::UUID ELSE v_before.vendor_id END;
  v_lease_id := CASE WHEN p_expense ? 'lease_id' THEN NULLIF(p_expense->>'lease_id', '')::UUID ELSE v_before.lease_id END;
  v_tenant_id := CASE WHEN p_expense ? 'tenant_id' THEN NULLIF(p_expense->>'tenant_id', '')::UUID ELSE v_before.tenant_id END;
  v_portfolio_id := CASE WHEN p_expense ? 'portfolio_id' THEN NULLIF(p_expense->>'portfolio_id', '')::UUID ELSE v_before.portfolio_id END;
  v_source := COALESCE(NULLIF(p_expense->>'source', ''), NULLIF(p_expense->>'source_type', ''), v_before.source, 'manual');
  v_approval_status := COALESCE(NULLIF(p_expense->>'approval_status', ''), NULLIF(p_expense->>'approved_status', ''), v_before.approval_status, v_before.approved_status, 'approved');
  v_review_status := COALESCE(NULLIF(p_expense->>'review_status', ''), v_before.review_status, v_approval_status);
  v_recovery_status := COALESCE(NULLIF(p_expense->>'recovery_status', ''), NULLIF(p_expense->>'classification', ''), v_before.recovery_status, v_before.classification, 'needs_review');

  IF v_date IS NULL THEN RAISE EXCEPTION 'date is required'; END IF;
  IF v_amount IS NULL THEN RAISE EXCEPTION 'amount is required'; END IF;
  IF v_amount < 0 THEN RAISE EXCEPTION 'amount must be a non-negative number'; END IF;
  IF NULLIF(trim(COALESCE(p_expense->>'category', v_before.category, '')), '') IS NULL THEN RAISE EXCEPTION 'category is required'; END IF;
  IF NULLIF(trim(COALESCE(p_expense->>'vendor', v_before.vendor, '')), '') IS NULL THEN RAISE EXCEPTION 'vendor is required'; END IF;
  IF v_property_id IS NULL THEN RAISE EXCEPTION 'property_id is required'; END IF;
  IF v_expense_category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = v_expense_category_id AND (org_id IS NULL OR org_id = p_org_id)) THEN
    RAISE EXCEPTION 'Expense category not found for this organization';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = v_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property not found for this organization';
  END IF;
  IF v_building_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.buildings WHERE id = v_building_id AND org_id = p_org_id AND property_id = v_property_id) THEN
    RAISE EXCEPTION 'Building not found for this organization/property';
  END IF;
  IF v_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.units WHERE id = v_unit_id AND org_id = p_org_id AND property_id = v_property_id AND (v_building_id IS NULL OR building_id = v_building_id)) THEN
    RAISE EXCEPTION 'Unit not found for this organization/property/building';
  END IF;
  IF v_vendor_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = v_vendor_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Vendor not found for this organization';
  END IF;
  IF v_lease_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leases WHERE id = v_lease_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Lease not found for this organization';
  END IF;
  IF v_tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = v_tenant_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Tenant not found for this organization';
  END IF;
  IF v_portfolio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.portfolios WHERE id = v_portfolio_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Portfolio not found for this organization';
  END IF;

  UPDATE public.expenses SET
    portfolio_id = v_portfolio_id,
    property_id = v_property_id,
    building_id = v_building_id,
    unit_id = v_unit_id,
    lease_id = v_lease_id,
    tenant_id = v_tenant_id,
    tenant_name = CASE WHEN p_expense ? 'tenant_name' THEN NULLIF(p_expense->>'tenant_name', '') ELSE tenant_name END,
    category = COALESCE(NULLIF(p_expense->>'category', ''), category),
    expense_category_id = v_expense_category_id,
    expense_subcategory = CASE WHEN p_expense ? 'expense_subcategory' THEN NULLIF(p_expense->>'expense_subcategory', '') ELSE expense_subcategory END,
    amount = v_amount,
    classification = CASE WHEN p_expense ? 'classification' THEN NULLIF(p_expense->>'classification', '') ELSE classification END,
    recovery_status = v_recovery_status,
    vendor = COALESCE(NULLIF(p_expense->>'vendor', ''), vendor),
    vendor_name = COALESCE(NULLIF(p_expense->>'vendor_name', ''), NULLIF(p_expense->>'vendor', ''), vendor_name, vendor),
    vendor_id = v_vendor_id,
    gl_code = CASE WHEN p_expense ? 'gl_code' THEN NULLIF(p_expense->>'gl_code', '') ELSE gl_code END,
    invoice_number = CASE WHEN p_expense ? 'invoice_number' THEN NULLIF(p_expense->>'invoice_number', '') ELSE invoice_number END,
    fiscal_year = COALESCE(NULLIF(p_expense->>'fiscal_year', '')::INT, fiscal_year),
    month = COALESCE(NULLIF(p_expense->>'month', '')::INT, EXTRACT(MONTH FROM v_date)::INT, month),
    date = v_date,
    expense_date = COALESCE(NULLIF(p_expense->>'expense_date', '')::DATE, v_date),
    billing_period_start = COALESCE(NULLIF(p_expense->>'billing_period_start', '')::DATE, NULLIF(p_expense->>'service_period_start', '')::DATE, v_date),
    billing_period_end = COALESCE(NULLIF(p_expense->>'billing_period_end', '')::DATE, NULLIF(p_expense->>'service_period_end', '')::DATE, v_date),
    service_period_start = COALESCE(NULLIF(p_expense->>'service_period_start', '')::DATE, v_date),
    service_period_end = COALESCE(NULLIF(p_expense->>'service_period_end', '')::DATE, v_date),
    source = v_source,
    source_type = COALESCE(NULLIF(p_expense->>'source_type', ''), v_source),
    source_file_id = CASE WHEN p_expense ? 'source_file_id' THEN NULLIF(p_expense->>'source_file_id', '')::UUID ELSE source_file_id END,
    description = CASE WHEN p_expense ? 'description' THEN NULLIF(p_expense->>'description', '') ELSE description END,
    attachment_url = CASE WHEN p_expense ? 'attachment_url' THEN NULLIF(p_expense->>'attachment_url', '') ELSE attachment_url END,
    approval_status = v_approval_status,
    approved_status = v_approval_status,
    review_status = v_review_status,
    confidence_score = CASE WHEN p_expense ? 'confidence_score' THEN NULLIF(p_expense->>'confidence_score', '')::NUMERIC ELSE confidence_score END,
    is_controllable = COALESCE(NULLIF(p_expense->>'is_controllable', '')::BOOLEAN, is_controllable, TRUE),
    updated_at = v_now
  WHERE id = p_expense_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  IF (to_jsonb(v_updated) - 'updated_at') IS NOT DISTINCT FROM (to_jsonb(v_before) - 'updated_at') THEN
    RETURN jsonb_build_object('expense', to_jsonb(v_before), 'changed', false);
  END IF;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  ) VALUES (
    p_org_id, v_updated.property_id, 'Expense', p_expense_id::TEXT,
    'expense_details_updated', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_before), to_jsonb(v_updated),
    jsonb_build_object('updated_fields', to_jsonb((SELECT array_agg(k) FROM jsonb_object_keys(p_expense) AS k))),
    v_now
  ) RETURNING id INTO v_audit_log_id;

  RETURN jsonb_build_object('expense', to_jsonb(v_updated), 'changed', true, 'audit_log_id', v_audit_log_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.bulk_create_expenses_workflow(
  p_org_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_expenses JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_allowed_keys TEXT[] := ARRAY[
    'date', 'expense_date', 'amount', 'category', 'expense_category_id', 'expense_subcategory',
    'vendor', 'vendor_name', 'description', 'classification', 'recovery_status',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'lease_id', 'tenant_id', 'tenant_name',
    'gl_code', 'invoice_number', 'source', 'source_type', 'source_file_id',
    'fiscal_year', 'month', 'approval_status', 'approved_status', 'review_status',
    'service_period_start', 'service_period_end', 'billing_period_start', 'billing_period_end',
    'confidence_score', 'is_controllable'
  ];
  v_count INT;
  v_row JSONB;
  v_key TEXT;
  i INT;
  v_amount NUMERIC;
  v_property_id UUID;
  v_expense_category_id UUID;
  v_building_id UUID;
  v_unit_id UUID;
  v_lease_id UUID;
  v_tenant_id UUID;
  v_portfolio_id UUID;
  v_created_ids UUID[];
  v_created_rows JSONB;
BEGIN
  IF p_org_id IS NULL THEN RAISE EXCEPTION 'org_id is required'; END IF;
  IF p_actor_user_id IS NULL THEN RAISE EXCEPTION 'actor_user_id is required'; END IF;
  IF jsonb_typeof(COALESCE(p_expenses, 'null'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'expenses must be a JSON array';
  END IF;

  v_count := jsonb_array_length(p_expenses);
  IF v_count = 0 THEN RAISE EXCEPTION 'expenses must contain at least one row'; END IF;

  FOR i IN 0..v_count - 1 LOOP
    v_row := p_expenses -> i;
    IF jsonb_typeof(v_row) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'row %: expense must be a JSON object', i + 1;
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(v_row) LOOP
      IF NOT (v_key = ANY(v_allowed_keys)) THEN
        RAISE EXCEPTION 'row %: field % is not permitted', i + 1, v_key;
      END IF;
    END LOOP;

    IF NULLIF(v_row ->> 'amount', '') IS NULL THEN RAISE EXCEPTION 'row %: amount is required', i + 1; END IF;
    v_amount := (v_row ->> 'amount')::NUMERIC;
    IF v_amount < 0 THEN RAISE EXCEPTION 'row %: amount must be a non-negative number', i + 1; END IF;
    IF NULLIF(trim(COALESCE(v_row ->> 'category', '')), '') IS NULL THEN RAISE EXCEPTION 'row %: category is required', i + 1; END IF;
    IF v_row ? 'date' AND NULLIF(v_row ->> 'date', '') IS NOT NULL THEN PERFORM (v_row ->> 'date')::DATE; END IF;

    v_property_id := NULLIF(v_row ->> 'property_id', '')::UUID;
    v_expense_category_id := NULLIF(v_row ->> 'expense_category_id', '')::UUID;
    v_building_id := NULLIF(v_row ->> 'building_id', '')::UUID;
    v_unit_id := NULLIF(v_row ->> 'unit_id', '')::UUID;
    v_lease_id := NULLIF(v_row ->> 'lease_id', '')::UUID;
    v_tenant_id := NULLIF(v_row ->> 'tenant_id', '')::UUID;
    v_portfolio_id := NULLIF(v_row ->> 'portfolio_id', '')::UUID;

    IF v_expense_category_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.expense_categories WHERE id = v_expense_category_id AND (org_id IS NULL OR org_id = p_org_id)) THEN
      RAISE EXCEPTION 'row %: Expense category not found for this organization', i + 1;
    END IF;
    IF v_property_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.properties WHERE id = v_property_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'row %: Property not found for this organization', i + 1;
    END IF;
    IF v_building_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.buildings WHERE id = v_building_id AND org_id = p_org_id AND (v_property_id IS NULL OR property_id = v_property_id)) THEN
      RAISE EXCEPTION 'row %: Building not found for this organization/property', i + 1;
    END IF;
    IF v_unit_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.units WHERE id = v_unit_id AND org_id = p_org_id AND (v_property_id IS NULL OR property_id = v_property_id) AND (v_building_id IS NULL OR building_id = v_building_id)) THEN
      RAISE EXCEPTION 'row %: Unit not found for this organization/property/building', i + 1;
    END IF;
    IF v_lease_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.leases WHERE id = v_lease_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'row %: Lease not found for this organization', i + 1;
    END IF;
    IF v_tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = v_tenant_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'row %: Tenant not found for this organization', i + 1;
    END IF;
    IF v_portfolio_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.portfolios WHERE id = v_portfolio_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'row %: Portfolio not found for this organization', i + 1;
    END IF;
  END LOOP;

  PERFORM set_config('app.skip_expense_audit_trigger', 'true', true);

  WITH inserted AS (
    INSERT INTO public.expenses (
      org_id, portfolio_id, property_id, building_id, unit_id, lease_id, tenant_id, tenant_name,
      category, expense_category_id, expense_subcategory, amount, classification, recovery_status,
      vendor, vendor_name, gl_code, invoice_number,
      fiscal_year, month, date, expense_date, billing_period_start, billing_period_end,
      service_period_start, service_period_end, source, source_type, source_file_id,
      description, approval_status, approved_status, review_status,
      confidence_score, is_controllable
    )
    SELECT
      p_org_id,
      NULLIF(elem ->> 'portfolio_id', '')::UUID,
      NULLIF(elem ->> 'property_id', '')::UUID,
      NULLIF(elem ->> 'building_id', '')::UUID,
      NULLIF(elem ->> 'unit_id', '')::UUID,
      NULLIF(elem ->> 'lease_id', '')::UUID,
      NULLIF(elem ->> 'tenant_id', '')::UUID,
      NULLIF(elem ->> 'tenant_name', ''),
      elem ->> 'category',
      NULLIF(elem ->> 'expense_category_id', '')::UUID,
      NULLIF(elem ->> 'expense_subcategory', ''),
      (elem ->> 'amount')::NUMERIC,
      NULLIF(elem ->> 'classification', ''),
      COALESCE(NULLIF(elem ->> 'recovery_status', ''), NULLIF(elem ->> 'classification', ''), 'needs_review'),
      COALESCE(elem ->> 'vendor', ''),
      COALESCE(NULLIF(elem ->> 'vendor_name', ''), NULLIF(elem ->> 'vendor', '')),
      NULLIF(elem ->> 'gl_code', ''),
      NULLIF(elem ->> 'invoice_number', ''),
      NULLIF(elem ->> 'fiscal_year', '')::INT,
      COALESCE(NULLIF(elem ->> 'month', '')::INT, EXTRACT(MONTH FROM COALESCE(NULLIF(elem ->> 'date', '')::DATE, now()::DATE))::INT),
      NULLIF(elem ->> 'date', '')::DATE,
      COALESCE(NULLIF(elem ->> 'expense_date', '')::DATE, NULLIF(elem ->> 'date', '')::DATE),
      COALESCE(NULLIF(elem ->> 'billing_period_start', '')::DATE, NULLIF(elem ->> 'service_period_start', '')::DATE, NULLIF(elem ->> 'date', '')::DATE),
      COALESCE(NULLIF(elem ->> 'billing_period_end', '')::DATE, NULLIF(elem ->> 'service_period_end', '')::DATE, NULLIF(elem ->> 'date', '')::DATE),
      COALESCE(NULLIF(elem ->> 'service_period_start', '')::DATE, NULLIF(elem ->> 'date', '')::DATE),
      COALESCE(NULLIF(elem ->> 'service_period_end', '')::DATE, NULLIF(elem ->> 'date', '')::DATE),
      COALESCE(NULLIF(elem ->> 'source', ''), NULLIF(elem ->> 'source_type', ''), 'bulk_import'),
      COALESCE(NULLIF(elem ->> 'source_type', ''), NULLIF(elem ->> 'source', ''), 'bulk_import'),
      NULLIF(elem ->> 'source_file_id', '')::UUID,
      NULLIF(elem ->> 'description', ''),
      COALESCE(NULLIF(elem ->> 'approval_status', ''), NULLIF(elem ->> 'approved_status', ''), 'approved'),
      COALESCE(NULLIF(elem ->> 'approved_status', ''), NULLIF(elem ->> 'approval_status', ''), 'approved'),
      COALESCE(NULLIF(elem ->> 'review_status', ''), NULLIF(elem ->> 'approval_status', ''), NULLIF(elem ->> 'approved_status', ''), 'approved'),
      NULLIF(elem ->> 'confidence_score', '')::NUMERIC,
      COALESCE(NULLIF(elem ->> 'is_controllable', '')::BOOLEAN, TRUE)
    FROM jsonb_array_elements(p_expenses) AS elem
    RETURNING *
  )
  SELECT array_agg(id), jsonb_agg(to_jsonb(inserted)) INTO v_created_ids, v_created_rows FROM inserted;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  SELECT
    p_org_id,
    (elem ->> 'property_id')::UUID,
    'Expense',
    elem ->> 'id',
    'expense_created',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    NULL,
    elem,
    jsonb_build_object('source', elem ->> 'source', 'source_type', elem ->> 'source_type', 'batch_size', array_length(v_created_ids, 1), 'batch_ids', to_jsonb(v_created_ids)),
    v_now
  FROM jsonb_array_elements(v_created_rows) AS elem;

  RETURN jsonb_build_object('created_ids', to_jsonb(v_created_ids), 'created_count', array_length(v_created_ids, 1));
END;
$$;

REVOKE ALL ON FUNCTION public.create_expense_workflow(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_expense_details(UUID, UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bulk_create_expenses_workflow(UUID, UUID, TEXT, JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_expense_workflow(UUID, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.update_expense_details(UUID, UUID, UUID, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.bulk_create_expenses_workflow(UUID, UUID, TEXT, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
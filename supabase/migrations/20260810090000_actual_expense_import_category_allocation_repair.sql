-- Actual Expenses V1 import repair: persist canonical category IDs and allocation metadata.
-- Category text from imports remains evidence; expense_category_id is the authoritative accounting category.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS expense_category_id UUID REFERENCES public.expense_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_expense_category
  ON public.expenses(org_id, property_id, expense_category_id);

CREATE OR REPLACE FUNCTION public.actual_expense_import_category_alias(
  p_category TEXT,
  p_gl_code TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  WITH normalized AS (
    SELECT lower(regexp_replace(concat_ws(' ', p_category, p_gl_code, p_description), '[^a-zA-Z0-9]+', ' ', 'g')) AS text
  )
  SELECT CASE
    WHEN text ~ '(premises property tax|real estate tax|property tax|\bre tax\b|assessment)' THEN 'real_estate_taxes'
    WHEN text ~ '(landlord property policy|landlord property insurance|property insurance|property policy|prop ins|insurance premium|annual property insurance)' THEN 'property_insurance'
    WHEN text ~ '(electricity and water|utilities electric|util elec|electric service|water sewer|\butilities\b|\butility\b)' THEN 'utilities'
    WHEN text ~ '(tenant service contract|hvac service|hvac maintenance|\bhvac\b)' THEN 'hvac_maintenance'
    WHEN text ~ '(tenant caused damage|tenant caused repair|damage by tenant)' THEN 'tenant_repairs'
    WHEN text ~ '(legal review|legal assign|assignment review|consent review)' THEN 'assignment_review_fee'
    WHEN text ~ '(resurfacing|parking lot|park resur|paving|parking maintenance)' THEN 'common_area_operations'
    WHEN text ~ '(tenant improvement|\bti allowance\b|\bti\b)' THEN 'tenant_improvements'
    WHEN text ~ '(janitorial|cleaning)' THEN 'janitorial'
    WHEN text ~ '(security|patrol|gate monitoring)' THEN 'security'
    WHEN text ~ '(landscaping|landscape)' THEN 'landscaping'
    ELSE NULL
  END
  FROM normalized;
$$;

CREATE OR REPLACE FUNCTION public.resolve_actual_expense_category_id(
  p_org_id UUID,
  p_category TEXT,
  p_gl_code TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_alias TEXT;
  v_resolved JSONB;
  v_id UUID;
BEGIN
  v_alias := public.actual_expense_import_category_alias(p_category, p_gl_code, p_description);
  IF v_alias IS NOT NULL THEN
    v_resolved := public.resolve_expense_category_id(p_org_id, v_alias);
    IF (v_resolved ->> 'expense_category_id') IS NOT NULL THEN
      RETURN (v_resolved ->> 'expense_category_id')::UUID;
    END IF;
  END IF;

  v_resolved := public.resolve_expense_category_id(p_org_id, p_category);
  IF (v_resolved ->> 'expense_category_id') IS NOT NULL THEN
    RETURN (v_resolved ->> 'expense_category_id')::UUID;
  END IF;

  SELECT c.id INTO v_id
    FROM public.expense_categories c
   WHERE (c.org_id = p_org_id OR c.org_id IS NULL)
     AND lower(regexp_replace(coalesce(c.normalized_key, c.category_name, c.subcategory_name), '[^a-zA-Z0-9]+', ' ', 'g')) =
         lower(regexp_replace(coalesce(p_category, ''), '[^a-zA-Z0-9]+', ' ', 'g'))
   ORDER BY CASE WHEN c.org_id = p_org_id THEN 0 ELSE 1 END, c.display_order NULLS LAST, c.category_name
   LIMIT 1;

  RETURN v_id;
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
    'vendor', 'vendor_name', 'description', 'classification', 'recovery_status', 'linked_expense_rule_id', 'recovery_rule_id',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'lease_id', 'tenant_id', 'tenant_name',
    'gl_code', 'invoice_number', 'source', 'source_type', 'source_file_id',
    'fiscal_year', 'month', 'approval_status', 'approved_status', 'review_status',
    'service_period_start', 'service_period_end', 'billing_period_start', 'billing_period_end',
    'confidence_score', 'is_controllable',
    'allocation_type', 'allocation_method', 'allocation_meta', 'direct_tenant_ids'
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
    IF v_row ? 'allocation_meta' AND NULLIF(v_row ->> 'allocation_meta', '') IS NOT NULL THEN PERFORM (v_row ->> 'allocation_meta')::JSONB; END IF;

    v_property_id := NULLIF(v_row ->> 'property_id', '')::UUID;
    v_expense_category_id := COALESCE(
      NULLIF(v_row ->> 'expense_category_id', '')::UUID,
      public.resolve_actual_expense_category_id(p_org_id, v_row ->> 'category', v_row ->> 'gl_code', concat_ws(' ', v_row ->> 'description', v_row ->> 'expense_subcategory'))
    );
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
      confidence_score, is_controllable, allocation_type, allocation_meta, direct_tenant_ids
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
      COALESCE(NULLIF(elem ->> 'expense_category_id', '')::UUID, public.resolve_actual_expense_category_id(p_org_id, elem ->> 'category', elem ->> 'gl_code', concat_ws(' ', elem ->> 'description', elem ->> 'expense_subcategory'))),
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
      COALESCE(NULLIF(elem ->> 'is_controllable', '')::BOOLEAN, TRUE),
      COALESCE(NULLIF(elem ->> 'allocation_type', ''), NULLIF(elem ->> 'allocation_method', '')),
      COALESCE(NULLIF(elem ->> 'allocation_meta', '')::JSONB, '{}'::JSONB),
      CASE WHEN jsonb_typeof(elem -> 'direct_tenant_ids') = 'array'
           THEN ARRAY(SELECT jsonb_array_elements_text(elem -> 'direct_tenant_ids')::UUID)
           ELSE NULL END
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

UPDATE public.expenses e
   SET expense_category_id = public.resolve_actual_expense_category_id(e.org_id, e.category, e.gl_code, concat_ws(' ', e.description, e.expense_subcategory)),
       updated_at = now()
 WHERE e.expense_category_id IS NULL
   AND public.resolve_actual_expense_category_id(e.org_id, e.category, e.gl_code, concat_ws(' ', e.description, e.expense_subcategory)) IS NOT NULL;

NOTIFY pgrst, 'reload schema';

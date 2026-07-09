-- Enterprise hardening Phase 6X-3: server-own the AddExpense.jsx edit path.
--
-- AddExpense.jsx's "Edit Expense" form currently saves via
-- expenseService.update(id, data) -> baseExpenseService.update() (the
-- generic createEntityService('Expense') factory): a direct client
-- .update() write under the caller's own RLS session. Already
-- permission-checked (assertCurrentUserCanWrite) and already calls
-- logAudit(), but that audit is client-side, fire-and-forget, and its
-- failure is silently swallowed -- the same unreliable-audit pattern
-- already replaced for create (Phase 6D-7), amount correction (Phase
-- 6X-2), and the paired classification workflows (Phase 6X-1).
--
-- Payload whitelist matches AddExpense.jsx's exact current edit payload --
-- confirmed by reading handleSubmit's isEditing branch directly. This is a
-- narrower set than create_expense_workflow's (Phase 6D-7): the edit form
-- never sets approval_status/review_status, so those two are deliberately
-- NOT in this whitelist (out of scope -- do not broaden into a generic
-- update). org_id is deliberately NOT in the whitelist: resolved
-- server-side from the authenticated caller, never trusted from the
-- client payload, matching create_expense_workflow's convention.
--
-- amount IS included here, matching AddExpense.jsx's actual edit-form
-- behavior (the form always includes amount) -- this is a completely
-- separate RPC/workflow from update_expense_amount (Phase 6X-2, the
-- dedicated amount-correction dialogs in Expenses.jsx/
-- LeaseExpenseClassification.jsx). Neither calls the other.
--
-- Cross-org reference validation goes further than create_expense_workflow
-- did (which only validated property_id) -- per this phase's explicit
-- scope, every FK-shaped field in the whitelist (property_id, building_id,
-- unit_id, vendor_id, lease_id, tenant_id, portfolio_id) is validated to
-- belong to the same org, with building_id/unit_id additionally checked
-- against the resolved property_id where both are present. category is a
-- plain text value (from a fixed client-side list), not a foreign key --
-- only checked for presence, matching create's own validation.
--
-- Idempotent: if every whitelisted field's resolved new value is
-- identical to the expense's current value, this is a no-op -- no write,
-- no audit row, changed:false in the response (same pattern as
-- link_lease_space_assignment/update_expense_amount).
--
-- fn_on_expense_added is AFTER INSERT only (confirmed in Phase 6D-7's own
-- migration header) -- it never fires for this UPDATE, so no GUC-skip is
-- needed here, unlike the leases-table RPCs.

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
  v_expense public.expenses%ROWTYPE;
  v_updated public.expenses%ROWTYPE;
  v_key TEXT;
  v_audit_log_id UUID;
  v_response JSONB;
  v_allowed_keys TEXT[] := ARRAY[
    'date', 'amount', 'category', 'vendor', 'vendor_id', 'description', 'classification',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'attachment_url',
    'lease_id', 'tenant_id', 'source', 'fiscal_year',
    'service_period_start', 'service_period_end'
  ];
  v_next_date DATE;
  v_next_amount NUMERIC;
  v_next_category TEXT;
  v_next_vendor TEXT;
  v_next_vendor_id UUID;
  v_next_description TEXT;
  v_next_classification TEXT;
  v_next_portfolio_id UUID;
  v_next_property_id UUID;
  v_next_building_id UUID;
  v_next_unit_id UUID;
  v_next_attachment_url TEXT;
  v_next_lease_id UUID;
  v_next_tenant_id UUID;
  v_next_source TEXT;
  v_next_fiscal_year INT;
  v_next_service_period_start DATE;
  v_next_service_period_end DATE;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_expense_id IS NULL THEN
    RAISE EXCEPTION 'expense_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF jsonb_typeof(COALESCE(p_expense, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'expense must be a JSON object';
  END IF;

  FOR v_key IN SELECT jsonb_object_keys(p_expense) LOOP
    IF NOT (v_key = ANY(v_allowed_keys)) THEN
      RAISE EXCEPTION 'field % is not permitted', v_key;
    END IF;
  END LOOP;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found for this organization';
  END IF;

  -- Resolve each whitelisted field's next value: patch value if the key
  -- was submitted, otherwise the expense's current value (sparse-patch
  -- safe, matching persist_expense_classification's Phase 6X-1 fix).
  v_next_date := CASE WHEN p_expense ? 'date' THEN NULLIF(p_expense->>'date', '')::DATE ELSE v_expense.date END;
  v_next_amount := CASE WHEN p_expense ? 'amount' THEN NULLIF(p_expense->>'amount', '')::NUMERIC ELSE v_expense.amount END;
  v_next_category := CASE WHEN p_expense ? 'category' THEN NULLIF(p_expense->>'category', '') ELSE v_expense.category END;
  v_next_vendor := CASE WHEN p_expense ? 'vendor' THEN NULLIF(p_expense->>'vendor', '') ELSE v_expense.vendor END;
  v_next_vendor_id := CASE WHEN p_expense ? 'vendor_id' THEN NULLIF(p_expense->>'vendor_id', '')::UUID ELSE v_expense.vendor_id END;
  v_next_description := CASE WHEN p_expense ? 'description' THEN NULLIF(p_expense->>'description', '') ELSE v_expense.description END;
  v_next_classification := CASE WHEN p_expense ? 'classification' THEN NULLIF(p_expense->>'classification', '') ELSE v_expense.classification END;
  v_next_portfolio_id := CASE WHEN p_expense ? 'portfolio_id' THEN NULLIF(p_expense->>'portfolio_id', '')::UUID ELSE v_expense.portfolio_id END;
  v_next_property_id := CASE WHEN p_expense ? 'property_id' THEN NULLIF(p_expense->>'property_id', '')::UUID ELSE v_expense.property_id END;
  v_next_building_id := CASE WHEN p_expense ? 'building_id' THEN NULLIF(p_expense->>'building_id', '')::UUID ELSE v_expense.building_id END;
  v_next_unit_id := CASE WHEN p_expense ? 'unit_id' THEN NULLIF(p_expense->>'unit_id', '')::UUID ELSE v_expense.unit_id END;
  v_next_attachment_url := CASE WHEN p_expense ? 'attachment_url' THEN NULLIF(p_expense->>'attachment_url', '') ELSE v_expense.attachment_url END;
  v_next_lease_id := CASE WHEN p_expense ? 'lease_id' THEN NULLIF(p_expense->>'lease_id', '')::UUID ELSE v_expense.lease_id END;
  v_next_tenant_id := CASE WHEN p_expense ? 'tenant_id' THEN NULLIF(p_expense->>'tenant_id', '')::UUID ELSE v_expense.tenant_id END;
  v_next_source := CASE WHEN p_expense ? 'source' THEN COALESCE(NULLIF(p_expense->>'source', ''), 'manual') ELSE v_expense.source END;
  v_next_fiscal_year := CASE WHEN p_expense ? 'fiscal_year' THEN NULLIF(p_expense->>'fiscal_year', '')::INT ELSE v_expense.fiscal_year END;
  v_next_service_period_start := CASE WHEN p_expense ? 'service_period_start' THEN NULLIF(p_expense->>'service_period_start', '')::DATE ELSE v_expense.service_period_start END;
  v_next_service_period_end := CASE WHEN p_expense ? 'service_period_end' THEN NULLIF(p_expense->>'service_period_end', '')::DATE ELSE v_expense.service_period_end END;

  -- Requiredness, matching create_expense_workflow's (and the edit form's
  -- own client-side validation) rules for the same entity.
  IF v_next_date IS NULL THEN
    RAISE EXCEPTION 'date is required';
  END IF;
  IF v_next_amount IS NULL THEN
    RAISE EXCEPTION 'amount is required';
  END IF;
  IF v_next_amount < 0 THEN
    RAISE EXCEPTION 'amount must be a non-negative number';
  END IF;
  IF v_next_category IS NULL THEN
    RAISE EXCEPTION 'category is required';
  END IF;
  IF v_next_vendor IS NULL THEN
    RAISE EXCEPTION 'vendor is required';
  END IF;
  IF v_next_property_id IS NULL THEN
    RAISE EXCEPTION 'property_id is required';
  END IF;

  -- Cross-org / cross-property reference validation.
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = v_next_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property not found for this organization';
  END IF;

  IF v_next_building_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.buildings
       WHERE id = v_next_building_id AND org_id = p_org_id AND property_id = v_next_property_id
    ) THEN
      RAISE EXCEPTION 'Building not found for this organization/property';
    END IF;
  END IF;

  IF v_next_unit_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.units u
       WHERE u.id = v_next_unit_id
         AND u.org_id = p_org_id
         AND u.property_id = v_next_property_id
         AND (v_next_building_id IS NULL OR u.building_id = v_next_building_id)
    ) THEN
      RAISE EXCEPTION 'Unit not found for this organization/property/building';
    END IF;
  END IF;

  IF v_next_vendor_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.vendors WHERE id = v_next_vendor_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'Vendor not found for this organization';
    END IF;
  END IF;

  IF v_next_lease_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.leases WHERE id = v_next_lease_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'Lease not found for this organization';
    END IF;
  END IF;

  IF v_next_tenant_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.tenants WHERE id = v_next_tenant_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'Tenant not found for this organization';
    END IF;
  END IF;

  IF v_next_portfolio_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM public.portfolios WHERE id = v_next_portfolio_id AND org_id = p_org_id) THEN
      RAISE EXCEPTION 'Portfolio not found for this organization';
    END IF;
  END IF;

  -- Idempotent no-op: nothing would actually change.
  IF v_next_date IS NOT DISTINCT FROM v_expense.date
     AND v_next_amount IS NOT DISTINCT FROM v_expense.amount
     AND v_next_category IS NOT DISTINCT FROM v_expense.category
     AND v_next_vendor IS NOT DISTINCT FROM v_expense.vendor
     AND v_next_vendor_id IS NOT DISTINCT FROM v_expense.vendor_id
     AND v_next_description IS NOT DISTINCT FROM v_expense.description
     AND v_next_classification IS NOT DISTINCT FROM v_expense.classification
     AND v_next_portfolio_id IS NOT DISTINCT FROM v_expense.portfolio_id
     AND v_next_property_id IS NOT DISTINCT FROM v_expense.property_id
     AND v_next_building_id IS NOT DISTINCT FROM v_expense.building_id
     AND v_next_unit_id IS NOT DISTINCT FROM v_expense.unit_id
     AND v_next_attachment_url IS NOT DISTINCT FROM v_expense.attachment_url
     AND v_next_lease_id IS NOT DISTINCT FROM v_expense.lease_id
     AND v_next_tenant_id IS NOT DISTINCT FROM v_expense.tenant_id
     AND v_next_source IS NOT DISTINCT FROM v_expense.source
     AND v_next_fiscal_year IS NOT DISTINCT FROM v_expense.fiscal_year
     AND v_next_service_period_start IS NOT DISTINCT FROM v_expense.service_period_start
     AND v_next_service_period_end IS NOT DISTINCT FROM v_expense.service_period_end
  THEN
    RETURN jsonb_build_object(
      'expense', to_jsonb(v_expense),
      'changed', false
    );
  END IF;

  UPDATE public.expenses SET
    date = v_next_date,
    amount = v_next_amount,
    category = v_next_category,
    vendor = v_next_vendor,
    vendor_id = v_next_vendor_id,
    description = v_next_description,
    classification = v_next_classification,
    portfolio_id = v_next_portfolio_id,
    property_id = v_next_property_id,
    building_id = v_next_building_id,
    unit_id = v_next_unit_id,
    attachment_url = v_next_attachment_url,
    lease_id = v_next_lease_id,
    tenant_id = v_next_tenant_id,
    source = v_next_source,
    fiscal_year = v_next_fiscal_year,
    service_period_start = v_next_service_period_start,
    service_period_end = v_next_service_period_end,
    updated_at = v_now
   WHERE id = p_expense_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'Expense', p_expense_id::TEXT,
    'expense_details_updated', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_expense), to_jsonb(v_updated),
    jsonb_build_object('updated_fields', to_jsonb((SELECT array_agg(k) FROM jsonb_object_keys(p_expense) AS k))),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'expense', to_jsonb(v_updated),
    'changed', true,
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

REVOKE ALL ON FUNCTION public.update_expense_details(
  UUID, UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_expense_details(
  UUID, UUID, UUID, TEXT, JSONB
) TO service_role;

-- Enterprise hardening Phase 6X-5: server-own BulkImport.jsx's CSV/Excel
-- expense import path.
--
-- BulkImport.jsx's importData() currently loops the client-validated rows
-- and calls expenseService.create(row) once per row -- a direct client
-- write under the caller's own RLS session (baseExpenseService.create(),
-- the generic createEntityService('Expense') factory), sequentially
-- awaited with no transaction, no try/catch per row, and no toast/error
-- surface in this file at all. If row N of M throws, rows 1..N-1 are
-- already committed, rows N+1..M are never attempted, and the failure
-- becomes an unhandled promise rejection -- accidental partial success,
-- not a designed one. User decision (this phase): the new RPC is
-- all-or-nothing -- every row is validated before anything is inserted;
-- if any row fails, zero rows are created.
--
-- Reuse-vs-new decision: create_expense_workflow (Phase 6D-7) was
-- considered first but its 20-key whitelist does not include gl_code or
-- invoice_number -- both of which BulkImport writes today when present
-- (and both of which the Yardi/MRI import presets explicitly map CSV
-- columns onto). Reusing it unchanged would either silently drop that
-- data or hard-reject every row carrying a GL code or invoice number.
-- create_expense_workflow also REQUIRES vendor and property_id -- neither
-- of which BulkImport's own client-side validation requires (an org-wide
-- import with no property/building/unit scope selected sends no
-- property_id at all; a row with an empty vendor column still passes
-- validation and imports with vendor=''). A new, purpose-built bulk RPC
-- avoids both mismatches instead of changing BulkImport's real behavior
-- to fit the older single-row RPC's stricter rules.
--
-- Field whitelist derived by reading importData()'s exact payload plus
-- what resolveExpenseLeaseLink() (called inside expenseService.create(),
-- unchanged, stays client-side) can add on top: applyLeaseLinkToExpense()
-- sets lease_id/tenant_id/tenant_name/property_id/building_id/unit_id
-- when a single matching lease is found. tenant_name is therefore included
-- here even though create_expense_workflow's own whitelist omits it (a
-- pre-existing gap in that RPC, not repeated here, so bulk-imported rows
-- don't silently lose tenant_name the way a single AddExpense create
-- currently would).

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
    'date', 'amount', 'category', 'vendor', 'description', 'classification', 'source',
    'gl_code', 'invoice_number', 'portfolio_id', 'property_id', 'building_id', 'unit_id',
    'lease_id', 'tenant_id', 'tenant_name', 'fiscal_year'
  ];
  v_count INT;
  v_row JSONB;
  v_key TEXT;
  i INT;
  v_amount NUMERIC;
  v_property_id UUID;
  v_building_id UUID;
  v_unit_id UUID;
  v_lease_id UUID;
  v_tenant_id UUID;
  v_portfolio_id UUID;
  v_created_ids UUID[];
  v_created_rows JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF jsonb_typeof(COALESCE(p_expenses, 'null'::jsonb)) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'expenses must be a JSON array';
  END IF;

  v_count := jsonb_array_length(p_expenses);
  IF v_count = 0 THEN
    RAISE EXCEPTION 'expenses must contain at least one row';
  END IF;

  -- Validate every row up front -- whitelist, requiredness, cross-org/
  -- cross-property references -- before inserting anything. All-or-
  -- nothing: the first invalid row aborts the whole batch with zero writes.
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

    -- amount and category are required, matching BulkImport's own
    -- client-side blocking validation (runValidation()'s only two error
    -- conditions). date is intentionally NOT required here -- BulkImport
    -- only warns on a malformed date, it never blocks a missing one.
    IF NULLIF(v_row ->> 'amount', '') IS NULL THEN
      RAISE EXCEPTION 'row %: amount is required', i + 1;
    END IF;
    v_amount := (v_row ->> 'amount')::NUMERIC;
    IF v_amount < 0 THEN
      RAISE EXCEPTION 'row %: amount must be a non-negative number', i + 1;
    END IF;

    IF NULLIF(trim(COALESCE(v_row ->> 'category', '')), '') IS NULL THEN
      RAISE EXCEPTION 'row %: category is required', i + 1;
    END IF;

    IF v_row ? 'date' AND NULLIF(v_row ->> 'date', '') IS NOT NULL THEN
      -- Cast-and-discard: raises a clear error naturally if malformed.
      PERFORM (v_row ->> 'date')::DATE;
    END IF;

    v_property_id := NULLIF(v_row ->> 'property_id', '')::UUID;
    IF v_property_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.properties WHERE id = v_property_id AND org_id = p_org_id
    ) THEN
      RAISE EXCEPTION 'row %: Property not found for this organization', i + 1;
    END IF;

    v_building_id := NULLIF(v_row ->> 'building_id', '')::UUID;
    IF v_building_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.buildings
         WHERE id = v_building_id AND org_id = p_org_id
           AND (v_property_id IS NULL OR property_id = v_property_id)
      ) THEN
        RAISE EXCEPTION 'row %: Building not found for this organization/property', i + 1;
      END IF;
    END IF;

    v_unit_id := NULLIF(v_row ->> 'unit_id', '')::UUID;
    IF v_unit_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.units u
         WHERE u.id = v_unit_id AND u.org_id = p_org_id
           AND (v_property_id IS NULL OR u.property_id = v_property_id)
           AND (v_building_id IS NULL OR u.building_id = v_building_id)
      ) THEN
        RAISE EXCEPTION 'row %: Unit not found for this organization/property/building', i + 1;
      END IF;
    END IF;

    v_lease_id := NULLIF(v_row ->> 'lease_id', '')::UUID;
    IF v_lease_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.leases WHERE id = v_lease_id AND org_id = p_org_id
    ) THEN
      RAISE EXCEPTION 'row %: Lease not found for this organization', i + 1;
    END IF;

    v_tenant_id := NULLIF(v_row ->> 'tenant_id', '')::UUID;
    IF v_tenant_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.tenants WHERE id = v_tenant_id AND org_id = p_org_id
    ) THEN
      RAISE EXCEPTION 'row %: Tenant not found for this organization', i + 1;
    END IF;

    v_portfolio_id := NULLIF(v_row ->> 'portfolio_id', '')::UUID;
    IF v_portfolio_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.portfolios WHERE id = v_portfolio_id AND org_id = p_org_id
    ) THEN
      RAISE EXCEPTION 'row %: Portfolio not found for this organization', i + 1;
    END IF;
  END LOOP;

  -- Skip fn_on_expense_added's own audit_logs insert for every row in this
  -- batch -- this RPC writes its own canonical row per created expense
  -- below, in the same transaction. Reuses the exact GUC
  -- create_expense_workflow already established (Phase 6D-7); SET LOCAL
  -- semantics (third arg true) auto-revert at COMMIT/ROLLBACK. The
  -- trigger's per-row variance-notification logic is untouched and still
  -- fires once per inserted row.
  PERFORM set_config('app.skip_expense_audit_trigger', 'true', true);

  WITH inserted AS (
    INSERT INTO public.expenses (
      org_id, property_id, building_id, unit_id, category, amount, classification,
      vendor, gl_code, invoice_number, fiscal_year, date, source, description,
      portfolio_id, lease_id, tenant_id, tenant_name
    )
    SELECT
      p_org_id,
      NULLIF(elem ->> 'property_id', '')::UUID,
      NULLIF(elem ->> 'building_id', '')::UUID,
      NULLIF(elem ->> 'unit_id', '')::UUID,
      elem ->> 'category',
      (elem ->> 'amount')::NUMERIC,
      NULLIF(elem ->> 'classification', ''),
      COALESCE(elem ->> 'vendor', ''),
      NULLIF(elem ->> 'gl_code', ''),
      NULLIF(elem ->> 'invoice_number', ''),
      NULLIF(elem ->> 'fiscal_year', '')::INT,
      NULLIF(elem ->> 'date', '')::DATE,
      COALESCE(NULLIF(elem ->> 'source', ''), 'import'),
      NULLIF(elem ->> 'description', ''),
      NULLIF(elem ->> 'portfolio_id', '')::UUID,
      NULLIF(elem ->> 'lease_id', '')::UUID,
      NULLIF(elem ->> 'tenant_id', '')::UUID,
      NULLIF(elem ->> 'tenant_name', '')
    FROM jsonb_array_elements(p_expenses) AS elem
    RETURNING *
  )
  SELECT array_agg(id), jsonb_agg(to_jsonb(inserted))
    INTO v_created_ids, v_created_rows
    FROM inserted;

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
    jsonb_build_object(
      'source', elem ->> 'source',
      'batch_size', array_length(v_created_ids, 1),
      'batch_ids', to_jsonb(v_created_ids)
    ),
    v_now
  FROM jsonb_array_elements(v_created_rows) AS elem;

  RETURN jsonb_build_object(
    'created_ids', to_jsonb(v_created_ids),
    'created_count', array_length(v_created_ids, 1)
  );
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by bulk-create-expenses's assertPageAccess() call, so EXECUTE must be
-- restricted to service_role only (matching every other RPC introduced
-- this hardening pass).
REVOKE ALL ON FUNCTION public.bulk_create_expenses_workflow(
  UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.bulk_create_expenses_workflow(
  UUID, UUID, TEXT, JSONB
) TO service_role;

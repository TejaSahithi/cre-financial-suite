-- Enterprise hardening Phase 6D-7: create_expense_workflow.
--
-- Moves the manual/single expense-create path (AddExpense.jsx's "Add
-- Expense" form -> expenseService.create()) behind a server-owned, audited
-- RPC. Today this is a direct client insert via the generic
-- createEntityService('Expense') factory -- audited/permission-checked
-- client-side, but not backend-owned (SECURITY DEFINER) and not
-- transactional with the audit row.
--
-- Explicitly OUT of scope for this pass (per Phase 6D-7 scope):
--   - BulkImport.jsx's CSV-import loop (still calls expenseService.create()
--     directly, per-row, unchanged) -- a genuine "bulk create" path with a
--     different risk profile (N rows, dedup-check UX) than this narrow
--     single-create slice.
--   - BulkImportModal.jsx -- already routes through the real
--     upload-handler/ingest-file/review-approve server pipeline, not a
--     direct client write at all; nothing to migrate there.
--   - expenseService.update()/delete() -- untouched, not part of this
--     create-only slice.
--   - No expense_classifications row is created here, matching current
--     behavior exactly: AddExpense.jsx's create flow never writes
--     expense_classifications (that's a separate, later step owned by
--     classifyExpenses()/persist_expense_classification).
--
-- Payload whitelist matches AddExpense.jsx's exact current create payload
-- (date, amount, category, vendor, vendor_id, description, classification,
-- portfolio_id, property_id, building_id, unit_id, attachment_url,
-- lease_id, tenant_id, source, fiscal_year, approval_status, review_status,
-- service_period_start, service_period_end) -- org_id is deliberately NOT
-- in the whitelist: it is resolved server-side from the authenticated
-- caller (p_org_id), never trusted from the client payload. The lease-link
-- derivation (resolveExpenseLeaseLink/findMatchingLeasesForExpense in
-- expenseService.js -- matching a lease by property/date-range overlap)
-- stays entirely client-side, unchanged; this RPC only persists whatever
-- lease_id/tenant_id the client already resolved.
--
-- Trigger reconciliation: tr_expense_added (AFTER INSERT ON expenses) has
-- fired unconditionally on every expense insert since 20260322_add_core_tables.sql,
-- writing its own (legacy-shaped) audit_logs row plus a budget-variance
-- notification. Phase 6A-3 (this session) found no actionable work existed
-- yet because no RPC inserted into `expenses` -- this RPC is that
-- previously-deferred trigger point. Same reconciliation pattern as
-- fn_on_lease_changed/fn_on_budget_changed: skip only the trigger's own
-- audit insert via a new transaction-local app.skip_expense_audit_trigger
-- GUC, leaving the variance-notification logic fully intact (and fully
-- active for the still-unmigrated BulkImport.jsx/BulkImportModal.jsx paths,
-- which never set this GUC).

CREATE OR REPLACE FUNCTION public.fn_on_expense_added()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    total_actual   NUMERIC;
    total_budgeted NUMERIC;
    variance_pct   NUMERIC;
BEGIN
    -- Audit Log (skipped when the RPC-covered create path already wrote
    -- its own canonical audit row in the same transaction).
    IF current_setting('app.skip_expense_audit_trigger', true) IS DISTINCT FROM 'true' THEN
        INSERT INTO public.audit_logs (org_id, entity_type, entity_id, action, property_id, user_email)
        VALUES (NEW.org_id, 'Expense', NEW.id::text, 'create', NEW.property_id, COALESCE(NEW.created_by, 'system'));
    END IF;

    -- Recalculate Variance for this property and year
    IF NEW.property_id IS NOT NULL AND NEW.fiscal_year IS NOT NULL THEN
        SELECT SUM(amount)        INTO total_actual   FROM public.expenses WHERE property_id = NEW.property_id AND fiscal_year = NEW.fiscal_year;
        SELECT SUM(total_expenses) INTO total_budgeted FROM public.budgets  WHERE property_id = NEW.property_id AND budget_year = NEW.fiscal_year;

        IF total_budgeted > 0 THEN
            variance_pct := ((total_actual - total_budgeted) / total_budgeted) * 100;

            IF ABS(variance_pct) > 10 THEN
                INSERT INTO public.notifications (org_id, type, title, message, priority)
                VALUES (
                    NEW.org_id,
                    'cam_variance',
                    'Expense Variance Alert',
                    format(
                        'Total actual expenses ($%s) now %s%% %s budget ($%s) for FY %s.',
                        ROUND(total_actual, 2),
                        ROUND(ABS(variance_pct), 1),
                        CASE WHEN variance_pct > 0 THEN 'over' ELSE 'under' END,
                        ROUND(total_budgeted, 2),
                        NEW.fiscal_year
                    ),
                    CASE WHEN ABS(variance_pct) > 20 THEN 'high' ELSE 'medium' END
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

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
  v_property_id UUID;
  v_expense public.expenses%ROWTYPE;
  v_audit_log_id UUID;
  v_response JSONB;
  v_key TEXT;
  v_allowed_keys TEXT[] := ARRAY[
    'date', 'amount', 'category', 'vendor', 'vendor_id', 'description', 'classification',
    'portfolio_id', 'property_id', 'building_id', 'unit_id', 'attachment_url',
    'lease_id', 'tenant_id', 'source', 'fiscal_year', 'approval_status', 'review_status',
    'service_period_start', 'service_period_end'
  ];
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
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

  IF NULLIF(trim(COALESCE(p_expense->>'date', '')), '') IS NULL THEN
    RAISE EXCEPTION 'date is required';
  END IF;
  IF p_expense->>'amount' IS NULL THEN
    RAISE EXCEPTION 'amount is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_expense->>'category', '')), '') IS NULL THEN
    RAISE EXCEPTION 'category is required';
  END IF;
  IF NULLIF(trim(COALESCE(p_expense->>'vendor', '')), '') IS NULL THEN
    RAISE EXCEPTION 'vendor is required';
  END IF;

  v_property_id := NULLIF(p_expense->>'property_id', '')::uuid;
  IF v_property_id IS NULL THEN
    RAISE EXCEPTION 'property_id is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.properties WHERE id = v_property_id AND org_id = p_org_id) THEN
    RAISE EXCEPTION 'Property not found for this organization';
  END IF;

  IF p_expense ? 'approval_status' AND (p_expense->>'approval_status') NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'approval_status must be one of draft, approved';
  END IF;
  IF p_expense ? 'review_status' AND (p_expense->>'review_status') NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'review_status must be one of draft, approved';
  END IF;

  -- Skip fn_on_expense_added's own audit_logs insert -- this RPC writes its
  -- own canonical row below in the same transaction. Transaction-local
  -- (SET LOCAL semantics): reverts automatically at COMMIT/ROLLBACK. The
  -- trigger's variance-notification logic is untouched and still fires.
  PERFORM set_config('app.skip_expense_audit_trigger', 'true', true);

  INSERT INTO public.expenses (
    org_id, property_id, category, amount, classification, vendor, vendor_id,
    fiscal_year, date, source, description, portfolio_id, building_id, unit_id,
    lease_id, tenant_id, attachment_url, approval_status, review_status,
    service_period_start, service_period_end
  ) VALUES (
    p_org_id,
    v_property_id,
    p_expense->>'category',
    (p_expense->>'amount')::numeric,
    NULLIF(p_expense->>'classification', ''),
    p_expense->>'vendor',
    NULLIF(p_expense->>'vendor_id', '')::uuid,
    NULLIF(p_expense->>'fiscal_year', '')::int,
    (p_expense->>'date')::date,
    COALESCE(NULLIF(p_expense->>'source', ''), 'manual'),
    NULLIF(p_expense->>'description', ''),
    NULLIF(p_expense->>'portfolio_id', '')::uuid,
    NULLIF(p_expense->>'building_id', '')::uuid,
    NULLIF(p_expense->>'unit_id', '')::uuid,
    NULLIF(p_expense->>'lease_id', '')::uuid,
    NULLIF(p_expense->>'tenant_id', '')::uuid,
    NULLIF(p_expense->>'attachment_url', ''),
    COALESCE(NULLIF(p_expense->>'approval_status', ''), 'pending'),
    NULLIF(p_expense->>'review_status', ''),
    NULLIF(p_expense->>'service_period_start', '')::date,
    NULLIF(p_expense->>'service_period_end', '')::date
  )
  RETURNING * INTO v_expense;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_expense.property_id,
    'Expense',
    v_expense.id::TEXT,
    'expense_created',
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    NULL,
    to_jsonb(v_expense),
    jsonb_build_object('source', v_expense.source),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object(
    'expense', to_jsonb(v_expense),
    'audit_log_id', v_audit_log_id
  );
  RETURN v_response;
END;
$$;

-- SECURITY DEFINER bypasses RLS entirely; authorization is enforced solely
-- by create-expense-workflow's assertPageAccess() call, so EXECUTE must be
-- restricted to service_role only (matching every other RPC introduced
-- this hardening pass).
REVOKE ALL ON FUNCTION public.create_expense_workflow(
  UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_expense_workflow(
  UUID, UUID, TEXT, JSONB
) TO service_role;

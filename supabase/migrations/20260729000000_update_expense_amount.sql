-- Enterprise hardening Phase 6X-2: server-own expense amount correction.
--
-- expenseService.js::updateExpenseAmount currently writes `expenses.amount`
-- directly via the generic createEntityService('Expense') factory
-- (baseExpenseService.update). That path is already permission-checked
-- (assertCurrentUserCanWrite) and already calls logAudit() -- but that
-- audit call is client-side, fire-and-forget, and its failure is silently
-- swallowed (`.catch(() => {})`), the same unreliable-audit-trail pattern
-- already replaced everywhere else in this epic (delete_lease_cascade in
-- Phase 5B-1, the lease-family RPCs, persist_expense_classification in
-- Phase 6X-1). This migration replaces only that one write (the amount
-- correction itself) with a narrow RPC that writes a guaranteed
-- transactional audit row. The subsequent classifyExpenses() re-run that
-- updateExpenseAmount already triggers (re-deriving classification/CAM
-- fields off the new amount) stays completely unchanged, client-side, and
-- itself already routes its own expenses/expense_classifications writes
-- through persist_expense_classification (Phase 6X-1) -- untouched here.
--
-- Whitelisted to exactly the one column this workflow has ever written:
-- expenses.amount. Idempotent: if the submitted amount equals the current
-- amount, this is a no-op -- no write, no audit row, changed:false in the
-- response (same pattern as link_lease_space_assignment, Phase 6R-13).

CREATE OR REPLACE FUNCTION public.update_expense_amount(
  p_org_id UUID,
  p_expense_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_amount NUMERIC
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
  v_audit_log_id UUID;
  v_response JSONB;
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
  IF p_amount IS NULL OR NOT (p_amount = p_amount) OR p_amount < 0 THEN
    RAISE EXCEPTION 'amount must be a non-negative number';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id AND org_id = p_org_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found for this organization';
  END IF;

  -- Idempotent no-op: nothing would actually change.
  IF v_expense.amount IS NOT DISTINCT FROM p_amount THEN
    RETURN jsonb_build_object(
      'expense', to_jsonb(v_expense),
      'changed', false
    );
  END IF;

  UPDATE public.expenses
     SET amount = p_amount,
         updated_at = v_now
   WHERE id = p_expense_id AND org_id = p_org_id
  RETURNING * INTO v_updated;

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id, v_updated.property_id, 'Expense', p_expense_id::TEXT,
    'expense_amount_corrected', p_actor_user_id, p_actor_email,
    'info', 'edge_function', to_jsonb(v_expense), to_jsonb(v_updated),
    jsonb_build_object('previous_amount', v_expense.amount, 'new_amount', p_amount),
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

REVOKE ALL ON FUNCTION public.update_expense_amount(
  UUID, UUID, UUID, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.update_expense_amount(
  UUID, UUID, UUID, TEXT, NUMERIC
) TO service_role;

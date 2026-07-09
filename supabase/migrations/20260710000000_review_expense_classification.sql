-- Enterprise hardening Phase 6E-1: server-owned Finalize/Reopen for
-- expense classifications.
--
-- src/services/expenseService.js's finalizeExpenseClassification()/
-- reopenExpenseClassification() write directly to expenses and
-- expense_classifications with zero audit logging and zero server-side
-- permission check -- confirmed via a full-file grep of expenseService.js.
-- Finalize in particular promotes a row to CAM-ready ("finalized"), one of
-- the most consequential state transitions in the app.
--
-- Scope note: this does NOT re-implement the eligibility gate
-- (isActualClassificationEligible/isRuleClassificationEligible in
-- src/lib/expenseEligibility.js + src/services/utils/ruleDecisionEngine.js)
-- that finalizeExpenseClassification() runs client-side before calling
-- this RPC. That gate pulls in ~10 more helper functions from the same
-- ~2000-line matching/decision engine this session already decided (Phase
-- 3, persist_expense_classification) was too large/risky to port
-- server-side in this pass. This RPC instead adds its own narrow,
-- complementary checks (org boundary, row existence, actor identity) that
-- don't exist at all today -- the same "narrow consistency gate, not full
-- re-derivation" precedent as persist_expense_classification.
--
-- Also fixes a latent bug found while reading the current code:
-- reopenExpenseClassification()'s first write targets the `expenses` table
-- with columns (classification_status/finalized_at/cam_status/next_step/
-- reviewed_at) that do not exist there at all (confirmed via \d expenses)
-- -- only on expense_classifications. The generic factory silently strips
-- unknown columns, so that call has only ever bumped `updated_at`. This
-- RPC does not replicate that no-op.
CREATE OR REPLACE FUNCTION public.review_expense_classification(
  p_org_id UUID,
  p_classification_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_action TEXT,
  p_recovery_status TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_action TEXT := lower(COALESCE(p_action, ''));
  v_recovery_status TEXT := lower(COALESCE(p_recovery_status, ''));
  v_classification public.expense_classifications%ROWTYPE;
  v_expense public.expenses%ROWTYPE;
  v_expense_id UUID;
  v_before JSONB;
  v_after public.expense_classifications%ROWTYPE;
  v_after_json JSONB;
  v_next_step TEXT;
  v_recoverable_amount NUMERIC := 0;
  v_non_recoverable_amount NUMERIC := 0;
  v_conditional_amount NUMERIC := 0;
  v_excluded_amount NUMERIC := 0;
  v_audit_log_id UUID;
  v_response JSONB;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'org_id is required';
  END IF;
  IF p_classification_id IS NULL THEN
    RAISE EXCEPTION 'classification_id is required';
  END IF;
  IF p_actor_user_id IS NULL THEN
    RAISE EXCEPTION 'actor_user_id is required';
  END IF;
  IF v_action NOT IN ('finalize', 'reopen') THEN
    RAISE EXCEPTION 'action must be finalize or reopen';
  END IF;
  IF v_action = 'finalize' AND v_recovery_status NOT IN ('recoverable', 'non_recoverable', 'conditional', 'excluded') THEN
    RAISE EXCEPTION 'recovery_status must be one of recoverable, non_recoverable, conditional, excluded for finalize';
  END IF;

  SELECT * INTO v_classification
    FROM public.expense_classifications
   WHERE id = p_classification_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense classification not found for this organization';
  END IF;

  v_expense_id := COALESCE(v_classification.expense_id, v_classification.actual_expense_id);
  IF v_expense_id IS NULL THEN
    RAISE EXCEPTION 'Expense classification has no linked expense';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = v_expense_id AND org_id = p_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Linked expense not found for this organization';
  END IF;

  v_before := to_jsonb(v_classification);

  IF v_action = 'finalize' THEN
    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN COALESCE(v_classification.amount, v_expense.amount, 0) ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN COALESCE(v_classification.amount, v_expense.amount, 0) ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN COALESCE(v_classification.amount, v_expense.amount, 0) ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN COALESCE(v_classification.amount, v_expense.amount, 0) ELSE 0 END;
    v_next_step := CASE
      WHEN lower(COALESCE(v_classification.cam_eligible, '')) = 'yes' AND v_recovery_status = 'recoverable' THEN 'Send to CAM'
      ELSE 'Ready for projection'
    END;

    UPDATE public.expenses
       SET classification_updated_at = v_now,
           classification_updated_by = p_actor_user_id,
           recovery_status = v_recovery_status,
           recoverability_result = v_recovery_status,
           classification = v_recovery_status
     WHERE id = v_expense_id AND org_id = p_org_id;

    UPDATE public.expense_classifications
       SET recoverability_result = v_recovery_status,
           recovery_status = v_recovery_status,
           approved_status = 'approved',
           classification_status = 'finalized',
           exception_type = NULL,
           reviewed_at = v_now,
           reviewed_by = p_actor_user_id,
           approved_at = v_now,
           approved_by = p_actor_user_id,
           finalized_at = v_now,
           recoverable_amount = v_recoverable_amount,
           non_recoverable_amount = v_non_recoverable_amount,
           conditional_amount = v_conditional_amount,
           excluded_amount = v_excluded_amount,
           next_step = v_next_step
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;
  ELSE
    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           finalized_at = NULL,
           cam_status = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;
  END IF;

  v_after_json := to_jsonb(v_after);

  INSERT INTO public.audit_logs (
    org_id, property_id, entity_type, entity_id, action,
    actor_user_id, actor_email, severity, source, before, after, metadata, "timestamp"
  )
  VALUES (
    p_org_id,
    v_after.property_id,
    'ExpenseClassification',
    v_after.id::TEXT,
    CASE WHEN v_action = 'finalize' THEN 'expense_classification_finalized' ELSE 'expense_classification_reopened' END,
    p_actor_user_id,
    p_actor_email,
    'info',
    'edge_function',
    v_before,
    v_after_json,
    jsonb_build_object('expense_id', v_expense_id, 'action', v_action),
    v_now
  )
  RETURNING id INTO v_audit_log_id;

  v_response := jsonb_build_object('row', v_after_json, 'audit_log_id', v_audit_log_id);
  RETURN v_response;
END;
$$;

-- This RPC is SECURITY DEFINER and does not itself re-check page-level
-- write permission (only org boundary + row existence) -- the edge
-- function's assertPageAccess() is the sole authorization gate. Granting
-- `authenticated` EXECUTE would let any org member call this RPC directly
-- via the client SDK, bypassing that gate entirely (RLS does not apply to
-- SECURITY DEFINER functions). Only service_role -- i.e. only the edge
-- function -- may execute it.
REVOKE ALL ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT
) TO service_role;

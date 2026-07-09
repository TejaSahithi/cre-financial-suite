-- Enterprise hardening Phase 6E-2: extend review_expense_classification
-- (20260710000000) to cover the Exception Queue actions (approve/reject/
-- mark_na/resolve) in src/pages/ExpenseReview.jsx, plus that same page's
-- main classification-review table (ExpenseBucketTable, wired to
-- reviewMutation -- distinct from the Exception Queue's exceptionMutation
-- but calling the exact same expenseService.updateExpenseClassification()
-- / raw updateExpenseClassificationRecord() with the same
-- buildClassificationReviewPatch() shape). Both are still direct,
-- unaudited, permission-check-free writes today -- same gap Finalize/
-- Reopen had before 20260710000000.
--
-- 'approve' ports buildClassificationReviewPatch()'s full branching logic
-- (ExpenseReview.jsx:45-67) verbatim: classification_status depends on
-- BOTH the submitted recovery_status and approved_status (ExpenseBucketTable's
-- buttons send approved_status of 'approved', 'needs_review', or 'rejected'
-- -- the JS function only branches on approved_status==='approved' vs not,
-- so 'needs_review'/'rejected' behave identically there). 'reject'/
-- 'mark_na'/'resolve' are fixed-target transitions with no client input
-- beyond the classification id, ported directly from
-- ExpenseReview.jsx's exceptionMutation (lines ~346-377).
--
-- Unlike finalize/reopen, none of these four touch the `expenses` table --
-- confirmed via the current code, which calls
-- expenseService.updateExpenseClassification() exclusively (a thin wrapper
-- over updateExpenseClassificationRecord(), which only ever writes
-- expense_classifications).
--
-- The old 6-parameter signature must be dropped explicitly first: Postgres
-- identifies functions by their full parameter signature, so CREATE OR
-- REPLACE with an added parameter (even one with a DEFAULT) creates a
-- second, overloaded function rather than replacing the original -- the
-- exact same gotcha already hit and fixed once this session for
-- delete_lease_cascade (20260707020000_lease_cascade_delete_audit.sql).
DROP FUNCTION IF EXISTS public.review_expense_classification(UUID, UUID, UUID, TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION public.review_expense_classification(
  p_org_id UUID,
  p_classification_id UUID,
  p_actor_user_id UUID,
  p_actor_email TEXT,
  p_action TEXT,
  p_recovery_status TEXT DEFAULT NULL,
  p_approved_status TEXT DEFAULT NULL
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
  v_approved_status TEXT := lower(COALESCE(p_approved_status, ''));
  v_classification public.expense_classifications%ROWTYPE;
  v_expense public.expenses%ROWTYPE;
  v_expense_id UUID;
  v_before JSONB;
  v_after public.expense_classifications%ROWTYPE;
  v_after_json JSONB;
  v_next_step TEXT;
  v_next_status TEXT;
  v_amount NUMERIC;
  v_recoverable_amount NUMERIC := 0;
  v_non_recoverable_amount NUMERIC := 0;
  v_conditional_amount NUMERIC := 0;
  v_excluded_amount NUMERIC := 0;
  v_audit_action TEXT;
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
  IF v_action NOT IN ('finalize', 'reopen', 'approve', 'reject', 'mark_na', 'resolve') THEN
    RAISE EXCEPTION 'action must be one of finalize, reopen, approve, reject, mark_na, resolve';
  END IF;
  IF v_action IN ('finalize', 'approve') AND v_recovery_status NOT IN ('recoverable', 'non_recoverable', 'conditional', 'excluded') THEN
    RAISE EXCEPTION 'recovery_status must be one of recoverable, non_recoverable, conditional, excluded for %', v_action;
  END IF;
  IF v_action = 'approve' AND v_approved_status NOT IN ('approved', 'needs_review', 'rejected') THEN
    RAISE EXCEPTION 'approved_status must be one of approved, needs_review, rejected for approve';
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
  v_amount := COALESCE(v_classification.amount, v_expense.amount, 0);

  IF v_action = 'finalize' THEN
    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN v_amount ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN v_amount ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN v_amount ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN v_amount ELSE 0 END;
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

    v_audit_action := 'expense_classification_finalized';
  ELSIF v_action = 'reopen' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           finalized_at = NULL,
           cam_status = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_reopened';
  ELSIF v_action = 'approve' THEN
    v_next_status := CASE
      WHEN v_approved_status = 'approved' THEN
        CASE WHEN v_recovery_status IN ('recoverable', 'non_recoverable', 'excluded') THEN 'finalized' ELSE 'conditional' END
      ELSE
        CASE
          WHEN v_recovery_status = 'conditional' THEN 'conditional'
          WHEN v_recovery_status IN ('non_recoverable', 'excluded') THEN 'excluded'
          ELSE 'matched'
        END
    END;
    v_recoverable_amount := CASE WHEN v_recovery_status = 'recoverable' THEN v_amount ELSE 0 END;
    v_non_recoverable_amount := CASE WHEN v_recovery_status = 'non_recoverable' THEN v_amount ELSE 0 END;
    v_conditional_amount := CASE WHEN v_recovery_status = 'conditional' THEN v_amount ELSE 0 END;
    v_excluded_amount := CASE WHEN v_recovery_status = 'excluded' THEN v_amount ELSE 0 END;

    UPDATE public.expense_classifications
       SET recoverability_result = v_recovery_status,
           recovery_status = v_recovery_status,
           approved_status = p_approved_status,
           classification_status = v_next_status,
           exception_type = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN NULL ELSE exception_type END,
           reviewed_at = v_now,
           finalized_at = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN v_now ELSE NULL END,
           recoverable_amount = v_recoverable_amount,
           non_recoverable_amount = v_non_recoverable_amount,
           conditional_amount = v_conditional_amount,
           excluded_amount = v_excluded_amount,
           next_step = CASE WHEN v_next_status IN ('finalized', 'excluded') THEN 'Ready for projection' ELSE 'Finalize row' END
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_approved';
  ELSIF v_action = 'reject' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'excluded',
           recoverability_result = 'excluded',
           recovery_status = 'excluded',
           exception_type = NULL,
           recoverable_amount = 0,
           non_recoverable_amount = 0,
           conditional_amount = 0,
           excluded_amount = v_amount,
           next_step = 'Ready for projection'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_rejected';
  ELSIF v_action = 'mark_na' THEN
    UPDATE public.expense_classifications
       SET classification_status = 'excluded',
           recoverability_result = 'non_recoverable',
           recovery_status = 'non_recoverable',
           exception_type = NULL,
           recoverable_amount = 0,
           non_recoverable_amount = v_amount,
           conditional_amount = 0,
           excluded_amount = 0,
           next_step = 'Ready for projection'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_marked_na';
  ELSE -- resolve
    UPDATE public.expense_classifications
       SET classification_status = 'matched',
           exception_type = NULL,
           next_step = 'Finalize row'
     WHERE id = p_classification_id AND org_id = p_org_id
    RETURNING * INTO v_after;

    v_audit_action := 'expense_classification_resolved';
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
    v_audit_action,
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

REVOKE ALL ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.review_expense_classification(
  UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

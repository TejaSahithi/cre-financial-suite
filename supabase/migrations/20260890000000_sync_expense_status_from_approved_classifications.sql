-- Keep actual expense workflow columns in sync with already-approved
-- expense_classifications rows. Older client/RPC versions approved the
-- classification row but left expenses.approval_status/review_status as
-- needs_review, which hid approved actuals from Expense Classification.

UPDATE public.expenses e
SET
  approval_status = 'approved',
  approved_status = 'approved',
  review_status = 'approved',
  classification = CASE
    WHEN COALESCE(c.recoverability_result, c.recovery_status, e.recovery_status) = 'excluded' THEN 'non_recoverable'
    ELSE COALESCE(c.recoverability_result, c.recovery_status, e.classification)
  END,
  recovery_status = COALESCE(c.recoverability_result, c.recovery_status, e.recovery_status),
  approved_at = COALESCE(e.approved_at, c.approved_at, c.reviewed_at, now()),
  updated_at = now()
FROM public.expense_classifications c
WHERE e.org_id = c.org_id
  AND e.id = COALESCE(c.expense_id, c.actual_expense_id)
  AND (
    lower(coalesce(c.approved_status, '')) = 'approved'
    OR lower(coalesce(c.classification_status, '')) IN ('finalized', 'excluded')
  )
  AND lower(coalesce(e.approval_status, '')) <> 'rejected'
  AND lower(coalesce(e.review_status, '')) <> 'rejected'
  AND (
    lower(coalesce(e.approval_status, '')) <> 'approved'
    OR lower(coalesce(e.approved_status, '')) <> 'approved'
    OR lower(coalesce(e.review_status, '')) <> 'approved'
  );

NOTIFY pgrst, 'reload schema';
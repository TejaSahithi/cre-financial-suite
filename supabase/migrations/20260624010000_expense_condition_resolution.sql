-- Migration: 20260624010000_expense_condition_resolution.sql
-- Description: Adds condition resolution tracking to expense_classifications.
-- Conditional expenses cannot enter CAM until condition_resolved = true.
-- All pre-existing conditional rows default to unresolved (manual_review required).

ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS condition_resolved BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS condition_result   TEXT;

COMMENT ON COLUMN public.expense_classifications.condition_resolved IS
  'True when a human reviewer or automation has resolved the conditional status. '
  'Conditional expenses with condition_resolved=false are blocked from CAM publish.';

COMMENT ON COLUMN public.expense_classifications.condition_result IS
  'Outcome of condition resolution: recoverable | non_recoverable | manual_review. '
  'NULL while condition is unresolved.';

-- Backfill: any existing conditional rows become explicitly unresolved.
UPDATE public.expense_classifications
   SET condition_resolved = false,
       condition_result   = 'manual_review',
       exception_type     = COALESCE(exception_type, 'manual_review')
 WHERE (recoverability_result = 'conditional' OR classification_status = 'conditional')
   AND condition_resolved IS DISTINCT FROM true;

CREATE INDEX IF NOT EXISTS idx_expense_classifications_condition_unresolved
  ON public.expense_classifications (org_id, property_id, condition_resolved)
  WHERE condition_resolved = false
    AND (recoverability_result = 'conditional' OR classification_status = 'conditional');

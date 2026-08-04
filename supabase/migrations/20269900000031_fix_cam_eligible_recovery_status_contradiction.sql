-- Root cause (confirmed against real production data): expense_classifications
-- row 825fdb72-b13b-40ba-a58a-ad60314c6f41 (org 7d16919f-6587-4fbc-b21f-e27e15a752ee,
-- property A1, Summit HVAC RTU-4 repair, $1,084.12) has
-- recovery_status='non_recoverable' AND recoverability_result='non_recoverable'
-- but cam_eligible='yes' -- an internal contradiction on the same row. Traced
-- to expenseService.js's classifyExpenses(): when preserveManualReview is
-- true, recovery_status is recomputed from
-- existingClassification.recoverability_result, but cam_eligible was taken
-- from existingClassification.cam_eligible unconditionally -- a stale 'yes'
-- from an earlier classification pass could survive a later pass that
-- correctly flips recovery_status to non_recoverable. Fixed at the source in
-- expenseService.js (camEligible can no longer be 'yes' when the freshly
-- computed recoveryStatus is non_recoverable/excluded).
--
-- This row was never actually published (cam_status='needs_review',
-- sent_to_cam=false, and there is zero corresponding row in
-- cam_expense_inputs for property A1) -- so no downstream CAM run consumed
-- the bad flag. Correcting it here is a data-integrity fix, not an
-- undo of a real business decision: cam_eligible is a derived field, and
-- 'non_recoverable' already reflects the reviewed, approved determination
-- for this row.
UPDATE public.expense_classifications
   SET cam_eligible = 'no'
 WHERE cam_eligible = 'yes'
   AND (recovery_status IN ('non_recoverable', 'excluded') OR recoverability_result IN ('non_recoverable', 'excluded'));

-- Prevent recurrence from ANY write path (client, edge function, or future
-- RPC), not just the one client code path this instance was traced to.
-- NOT VALID: only new/updated rows are checked going forward -- this
-- migration does not attempt to retroactively validate every historical
-- row, matching this codebase's established principle of never bulk-fixing
-- historical data beyond what's evidenced.
ALTER TABLE public.expense_classifications
  DROP CONSTRAINT IF EXISTS expense_classifications_cam_eligible_recovery_status_check;

ALTER TABLE public.expense_classifications
  ADD CONSTRAINT expense_classifications_cam_eligible_recovery_status_check
  CHECK (
    cam_eligible IS DISTINCT FROM 'yes'
    OR (
      recovery_status IS DISTINCT FROM 'non_recoverable' AND recovery_status IS DISTINCT FROM 'excluded'
      AND recoverability_result IS DISTINCT FROM 'non_recoverable' AND recoverability_result IS DISTINCT FROM 'excluded'
    )
  ) NOT VALID;

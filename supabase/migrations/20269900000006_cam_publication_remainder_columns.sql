-- Small additive follow-up to 20269900000004/20269900000005: two columns
-- needed to enforce "allocated amount total must not exceed the approved
-- expense amount" and "unresolved remainder exists without an accepted
-- exception" from this PR's finalize/publish readiness checks. No new
-- table — expense_classifications.amount (already a real, independent
-- column, distinct from the linked expense's own amount) remains the
-- single allocation figure for this PR's scope; these columns only record
-- a reviewer's explicit acknowledgement when that figure is deliberately
-- less than the full expense amount (a partial allocation).
ALTER TABLE public.expense_classifications
  ADD COLUMN IF NOT EXISTS remainder_accepted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS remainder_reason TEXT;

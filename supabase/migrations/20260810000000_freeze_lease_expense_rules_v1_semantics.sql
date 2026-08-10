-- Lease Expense Rules V1 frozen semantic contract columns.
-- These columns preserve the business interpretation produced by the
-- approved-lease rule normalizer so downstream classification does not have
-- to infer UI/workflow route from legacy CAM fields alone.

ALTER TABLE public.lease_expense_rules
  ADD COLUMN IF NOT EXISTS recovery_treatment TEXT,
  ADD COLUMN IF NOT EXISTS cam_participation TEXT,
  ADD COLUMN IF NOT EXISTS actual_expense_expected TEXT,
  ADD COLUMN IF NOT EXISTS vendor_payment_party TEXT,
  ADD COLUMN IF NOT EXISTS amount_formula TEXT,
  ADD COLUMN IF NOT EXISTS applies_when TEXT,
  ADD COLUMN IF NOT EXISTS condition_type TEXT,
  ADD COLUMN IF NOT EXISTS coverage_requirement_amount NUMERIC,
  ADD COLUMN IF NOT EXISTS insurance_coverage_amount NUMERIC;

CREATE INDEX IF NOT EXISTS idx_lease_expense_rules_v1_semantics
  ON public.lease_expense_rules(recovery_treatment, actual_expense_expected, cam_participation);

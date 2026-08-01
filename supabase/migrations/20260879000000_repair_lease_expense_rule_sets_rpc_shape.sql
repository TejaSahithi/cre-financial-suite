-- Repair deployed lease_expense_rule_sets shape for save_lease_expense_rule_set.
-- Some environments have the rule-set table without the ownership/approval
-- columns that the canonical RPC writes. Without these columns, approved lease
-- expense-rule sync reaches persistence and then fails with 42703 on
-- lease_expense_rule_sets.created_by, leaving the Lease Expense Rules UI empty.

ALTER TABLE public.lease_expense_rule_sets
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_sets_created_by
  ON public.lease_expense_rule_sets(created_by);

CREATE INDEX IF NOT EXISTS idx_lease_expense_rule_sets_approved_by
  ON public.lease_expense_rule_sets(approved_by);
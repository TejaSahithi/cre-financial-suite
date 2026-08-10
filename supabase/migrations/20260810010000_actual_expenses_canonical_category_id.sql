-- Actual Expenses V1: persist canonical category separately from raw imported text.
-- `expenses.category` remains supporting source evidence; downstream matching uses
-- `expenses.expense_category_id` only when explicitly resolved.

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS expense_category_id UUID
  REFERENCES public.expense_categories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_expenses_org_expense_category
  ON public.expenses(org_id, expense_category_id);

COMMENT ON COLUMN public.expenses.expense_category_id IS
  'Actual Expenses V1 canonical category. Raw imported category text remains in category and is supporting evidence only.';

NOTIFY pgrst, 'reload schema';
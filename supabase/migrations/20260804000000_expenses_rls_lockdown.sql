-- Enterprise hardening Phase 6X-9: hard RLS lockdown on public.expenses
-- (INSERT/UPDATE/DELETE).
--
-- Phase 6X-8's investigation confirmed, via exhaustive grep across all of
-- src/, that every live write path to `expenses` is already server-owned:
--   * create_expense_workflow / bulk_create_expenses_workflow (INSERT)
--   * update_expense_details / update_expense_amount /
--     persist_expense_classification (p_expense_patch) (UPDATE)
--   * delete_expenses_workflow (DELETE, called directly by Expenses.jsx's
--     single/bulk delete and by syncLeaseDerivedExpenses' legacy cleanup
--     since Phase 6X-7A)
-- The only remaining direct-write code (Expenses.jsx's updateExpenseMutation
-- fallback branch calling ExpenseService.update(), and the generic
-- expenseService.create()/update()/baseExpenseService.delete() methods) is
-- confirmed unreachable from any live call site -- every real caller always
-- routes through one of the RPCs above. This migration makes the RPC-only
-- path the only possible one at the database layer too.
--
-- Why this is safe: every RPC above runs via the service-role admin client
-- inside its edge function, and the `service_role` Postgres role has
-- rolbypassrls = true -- RLS policies (including these WITH CHECK (false)
-- ones) are never evaluated for that role, so this change has zero effect
-- on any of the RPCs' own writes. Confirmed identically for the prior
-- budgets lockdown (20260707000000_budgets_rls_lockdown.sql).
--
-- Confirmed before writing this migration (read-only, both environments):
-- local and remote both have exactly the same 5 expenses policies by name
-- (expenses_insert, expenses_update, expenses_delete, expenses_select,
-- expenses_select_super_admin) -- no expenses_all or other broad FOR ALL
-- policy exists on either environment (the earlier expenses_all drift was
-- already cleaned up in Phase 6B-1). Local and remote's existing
-- expenses_insert/_update/_delete bodies differ (can_write_any_page with a
-- 3-page array locally vs. can_write_page with a single page on remote --
-- a known, separately-documented drift), but since this migration replaces
-- each policy by name with WITH CHECK (false) / USING (false), the old
-- body's content is irrelevant once replaced -- it works identically on
-- both environments regardless of that drift.
--
-- Scope: expenses only. expenses_select and expenses_select_super_admin
-- are untouched -- read access is unchanged. No other table's RLS is
-- touched (expense_classifications explicitly deferred to a future phase,
-- per Phase 6X-8's finding that its remote policy shape isn't ready yet).
--
-- Originally defined in 20260422000200_enterprise_access_control.sql, last
-- redefined in 20260423002000_phase3_permission_alignment.sql -- this
-- migration replaces expenses_insert/_update/_delete again rather than
-- editing either historical file, matching the budgets lockdown precedent.

DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;
CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "expenses_update" ON public.expenses;
CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "expenses_delete" ON public.expenses;
CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE USING (false);

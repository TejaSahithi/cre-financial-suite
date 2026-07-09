-- Enterprise hardening Phase 6 (budget-only RLS lockdown, cleanup step):
-- lock down direct authenticated DELETE on public.budgets.
--
-- Checked first: no UI code path deletes a budget anywhere in src/ (no
-- BudgetService.delete/budgetService.delete call site, no "Delete Budget"
-- UI text). There is also no server-owned "archive" action in compute-budget
-- for the same reason — nothing in the product currently removes or hides a
-- budget, so one wasn't added speculatively. If a remove/hide capability is
-- needed later, it should be a compute-budget action (e.g. "archive",
-- setting status = 'archived') rather than a real DELETE — budgets are
-- audit-relevant financial records; the product convention going forward
-- should be "archive, don't delete."
--
-- Originally defined in 20260422000200_enterprise_access_control.sql, last
-- redefined in 20260423002000_phase3_permission_alignment.sql alongside
-- budgets_insert/budgets_update (already locked down in
-- 20260707000000_budgets_rls_lockdown.sql) — this migration replaces
-- budgets_delete the same way, rather than editing either historical file.
--
-- service_role (which compute-budget runs as) is unaffected: rolbypassrls
-- = true for that role, so RLS is not evaluated for it regardless of policy
-- content — confirmed directly against pg_roles in the prior lockdown step.

DROP POLICY IF EXISTS "budgets_delete" ON public.budgets;
CREATE POLICY "budgets_delete" ON public.budgets
  FOR DELETE USING (false);

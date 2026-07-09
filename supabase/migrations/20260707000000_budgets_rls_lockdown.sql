-- Enterprise hardening Phase 6 (budget-only, first module): hard RLS
-- lockdown on public.budgets.
--
-- Phase 4/4B confirmed (via grep across all of src/, plus a source-level
-- regression test at src/pages/__tests__/CreateBudget.write-path.test.js)
-- that no UI code path writes to `budgets` directly anymore — every
-- transition (generate, mark_reviewed, approve, reject, lock) goes through
-- the compute-budget edge function's action handlers. This migration makes
-- that the only possible path at the database layer too, closing the gap
-- explicitly flagged at the end of Phase 4B: RLS previously permitted any
-- authenticated user with BudgetDashboard/CreateBudget write access to
-- insert or update a budgets row directly (e.g. via the Supabase REST API
-- or a raw client call), bypassing compute-budget's precondition checks
-- entirely.
--
-- Why this is safe for compute-budget: the edge function always writes via
-- the service-role admin client (createAdminClient() / supabaseAdmin), and
-- the `service_role` Postgres role has rolbypassrls = true (confirmed
-- directly: SELECT rolname, rolbypassrls FROM pg_roles). RLS policies —
-- including these WITH CHECK (false) ones — are not evaluated at all for a
-- role with BYPASSRLS, so this change has zero effect on compute-budget's
-- own writes.
--
-- Scope: INSERT and UPDATE only, matching this phase's explicit scope.
-- budgets_delete, budgets_select, and budgets_select_super_admin are
-- untouched — DELETE wasn't in scope, and SELECT must remain exactly as-is.
--
-- Originally defined in 20260422000200_enterprise_access_control.sql,
-- last redefined in 20260423002000_phase3_permission_alignment.sql — this
-- migration replaces them again rather than editing either historical file.

DROP POLICY IF EXISTS "budgets_insert" ON public.budgets;
CREATE POLICY "budgets_insert" ON public.budgets
  FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "budgets_update" ON public.budgets;
CREATE POLICY "budgets_update" ON public.budgets
  FOR UPDATE USING (false) WITH CHECK (false);

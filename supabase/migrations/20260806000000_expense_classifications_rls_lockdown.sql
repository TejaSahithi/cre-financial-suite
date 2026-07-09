-- Enterprise hardening Phase 6X-11: hard RLS lockdown on
-- public.expense_classifications (INSERT/UPDATE/DELETE).
--
-- Prerequisites confirmed complete before this migration:
--   * Phase 6X-8's investigation confirmed every live application write
--     path to expense_classifications is already server-owned
--     (persist_expense_classification, review_expense_classification,
--     manual_override_expense_classification,
--     save_lease_rule_amount_cam_input) -- the one remaining direct-write
--     branch (upsertExpenseClassification's hasExpense=false fallback) is
--     confirmed unreachable from any live UI call site.
--   * Phase 6X-10 repaired the policy-shape drift: remote's legacy
--     expense_classifications_org_write (FOR ALL, bare membership check,
--     no role gating) and expense_classifications_org_select are gone,
--     replaced on both environments with the canonical 5 per-command
--     policies under names that now match exactly.
--   * Phase 6X-7B/6X-6 reconciled expense_id to nullable with
--     expense_classifications_expense_id_fkey -> expenses(id) ON DELETE
--     CASCADE, validated, on both environments.
--
-- Confirmed before writing this migration (read-only, both environments):
-- local and remote both have exactly the same 5 expense_classifications
-- policies by name (expense_classifications_insert, _update, _delete,
-- _select, _select_super_admin) -- no FOR ALL or other broad policy
-- exists on either environment, and expense_classifications_org_write is
-- confirmed gone from remote.
--
-- Why this is safe: every RPC above runs via the service-role admin
-- client inside its edge function, and the `service_role` Postgres role
-- has rolbypassrls = true -- RLS policies (including these WITH CHECK
-- (false) ones) are never evaluated for that role, so this change has
-- zero effect on any of the RPCs' own writes. Confirmed identically for
-- the prior budgets and expenses lockdowns.
--
-- Scope: expense_classifications only. expense_classifications_select and
-- expense_classifications_select_super_admin are untouched -- read access
-- is unchanged. expense_id's nullability and its FK to expenses(id)
-- ON DELETE CASCADE are untouched by this migration (a policy-only
-- change). No other table's RLS is touched.
--
-- Originally defined (canonical shape) in
-- 20260805000000_expense_classifications_rls_shape_repair.sql -- this
-- migration replaces expense_classifications_insert/_update/_delete again
-- rather than editing that migration, matching the budgets and expenses
-- lockdown precedent.

DROP POLICY IF EXISTS "expense_classifications_insert" ON public.expense_classifications;
CREATE POLICY "expense_classifications_insert" ON public.expense_classifications
  FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "expense_classifications_update" ON public.expense_classifications;
CREATE POLICY "expense_classifications_update" ON public.expense_classifications
  FOR UPDATE USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "expense_classifications_delete" ON public.expense_classifications;
CREATE POLICY "expense_classifications_delete" ON public.expense_classifications
  FOR DELETE USING (false);

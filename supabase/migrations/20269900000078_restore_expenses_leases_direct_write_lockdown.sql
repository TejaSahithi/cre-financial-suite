-- QA Pass 2C: restore direct-write lockdown overwritten by later role-policy repair.
--
-- Expenses must remain server-owned through audited workflow RPCs/Edge
-- Functions. Leases keep direct INSERT/DELETE policy compatibility, but direct
-- authenticated UPDATE remains blocked so lease mutations flow through
-- server-owned review/approval commands.

DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;
DROP POLICY IF EXISTS expenses_insert ON public.expenses;
CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT WITH CHECK (false);

DROP POLICY IF EXISTS "expenses_update" ON public.expenses;
DROP POLICY IF EXISTS expenses_update ON public.expenses;
CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "expenses_delete" ON public.expenses;
DROP POLICY IF EXISTS expenses_delete ON public.expenses;
CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE USING (false);

DROP POLICY IF EXISTS "leases_update" ON public.leases;
DROP POLICY IF EXISTS leases_update ON public.leases;
CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE USING (false) WITH CHECK (false);

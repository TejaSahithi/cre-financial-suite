-- Enterprise hardening Phase 6R-11: DELETE lockdown for eligible lease
-- child tables.
--
-- Phase 6R-10 removed leaseService.js::deleteLeaseCascadeFallback entirely
-- -- lease deletion (and the cascade delete of its child rows) is now
-- exclusively owned by delete_lease_cascade (SECURITY DEFINER, bypasses
-- RLS), with a clear "workflow unavailable" error thrown client-side if the
-- RPC is ever missing (Phase 6R-10A further tightened that error
-- classification). That was the only remaining reason DELETE was left
-- unlocked on these three tables.
--
--   lease_critical_dates      -- DELETE locked. INSERT/UPDATE already
--                                 locked in Phase 6R-4; SELECT untouched.
--   lease_expense_rule_sets   -- DELETE locked. INSERT/UPDATE already
--                                 locked in Phase 6R-8; SELECT untouched.
--   lease_expense_rules       -- DELETE locked. INSERT/UPDATE already
--                                 locked in Phase 6R-8; SELECT untouched.
--
-- lease_expense_values and lease_expense_rule_clauses are deliberately NOT
-- touched here -- neither has ever had a DELETE policy at all (confirmed in
-- Phase 6R-5's shape repair), so there is no existing policy to replace and
-- direct DELETE on them is already denied by RLS's default-deny behavior.
--
-- service_role bypasses RLS entirely, so delete_lease_cascade is completely
-- unaffected by this migration.

DROP POLICY IF EXISTS "lease_critical_dates_delete" ON public.lease_critical_dates;
CREATE POLICY "lease_critical_dates_delete" ON public.lease_critical_dates
  FOR DELETE USING (false);

DROP POLICY IF EXISTS "lease_expense_rule_sets_delete" ON public.lease_expense_rule_sets;
CREATE POLICY "lease_expense_rule_sets_delete" ON public.lease_expense_rule_sets
  FOR DELETE USING (false);

DROP POLICY IF EXISTS "lease_expense_rules_delete" ON public.lease_expense_rules;
CREATE POLICY "lease_expense_rules_delete" ON public.lease_expense_rules
  FOR DELETE USING (false);

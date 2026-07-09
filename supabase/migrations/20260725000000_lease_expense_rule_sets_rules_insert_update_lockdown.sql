-- Enterprise hardening Phase 6R-8: lease_expense_rule_sets /
-- lease_expense_rules INSERT/UPDATE lockdown.
--
-- Continues the rule-family lockdown started in Phase 6R-7
-- (lease_expense_values/lease_expense_rule_clauses INSERT/UPDATE), now that
-- the remaining two tables are also confirmed ready:
--   - all live writes are RPC-owned (save_lease_expense_rule_set owns
--     rule-set/rule creation and replacement; update_lease_expense_rule_set_status
--     owns status persistence; update_lease_expense_rule owns rule-editor
--     saves; update_lease_expense_rule_amount owns CAM amount updates -- all
--     four SECURITY DEFINER, service_role-only, confirmed in Phases 6D-1/6R-2),
--   - policy shape was repaired in Phase 6R-5 (redundant _org_write/_org_select
--     dropped, canonical per-command policies in place on both environments),
--   - the last remaining direct-write code (dead-code inserts/upserts in
--     leaseAbstractService.js) was deleted in Phase 6R-6.
--
-- service_role bypasses RLS entirely, so none of the four RPCs above are
-- affected by this migration.
--
-- DELETE is deliberately left untouched on both tables -- leaseService.js's
-- deleteLeaseCascadeFallback still issues direct DELETEs against
-- lease_expense_rule_sets/lease_expense_rules (and lease_expense_rule_clauses)
-- as a fallback tier when delete_lease_cascade is unavailable; that
-- decision needs its own resolution before any DELETE lockdown. SELECT is
-- untouched on both tables.
--
-- Scoped to lease_expense_rule_sets/lease_expense_rules only -- no other
-- table's policies (including lease_expense_values/lease_expense_rule_clauses,
-- already locked in 6R-7) are touched by this migration.

DROP POLICY IF EXISTS "lease_expense_rule_sets_insert" ON public.lease_expense_rule_sets;
DROP POLICY IF EXISTS "lease_expense_rule_sets_update" ON public.lease_expense_rule_sets;

CREATE POLICY "lease_expense_rule_sets_insert" ON public.lease_expense_rule_sets
  FOR INSERT WITH CHECK (false);
CREATE POLICY "lease_expense_rule_sets_update" ON public.lease_expense_rule_sets
  FOR UPDATE USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "lease_expense_rules_insert" ON public.lease_expense_rules;
DROP POLICY IF EXISTS "lease_expense_rules_update" ON public.lease_expense_rules;

CREATE POLICY "lease_expense_rules_insert" ON public.lease_expense_rules
  FOR INSERT WITH CHECK (false);
CREATE POLICY "lease_expense_rules_update" ON public.lease_expense_rules
  FOR UPDATE USING (false) WITH CHECK (false);

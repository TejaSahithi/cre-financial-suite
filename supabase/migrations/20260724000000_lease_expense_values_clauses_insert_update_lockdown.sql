-- Enterprise hardening Phase 6R-7: first rule-family selective RLS lockdown.
--
-- Locks INSERT/UPDATE (where a policy exists) on the two rule-family
-- tables confirmed to have zero live or dead-code direct-write callers,
-- per Phase 6R-3's readiness matrix and Phase 6R-6's dead-code removal:
--
--   lease_expense_values      -- INSERT + UPDATE locked. No DELETE policy
--                                 has ever existed for this table (confirmed
--                                 in Phase 6R-5's shape repair) and this
--                                 table is not touched by
--                                 leaseService.js::deleteLeaseCascadeFallback
--                                 at all -- so there is nothing DELETE-side
--                                 to reconsider here.
--   lease_expense_rule_clauses -- INSERT locked. No UPDATE or DELETE policy
--                                 has ever existed for this table either
--                                 (confirmed in Phase 6R-5) -- only SELECT
--                                 and the now-locked INSERT were ever
--                                 granted, so this migration locks the one
--                                 remaining open command.
--
-- Not included in this phase: lease_expense_rule_sets / lease_expense_rules
-- (larger blast radius, saved for a later phase per the established
-- sequence) and any DELETE lockdown anywhere (leaseService.js's cascade
-- delete fallback still directly deletes lease_expense_rule_clauses,
-- lease_expense_rules, and lease_expense_rule_sets when
-- delete_lease_cascade is unavailable -- that fallback's fate is still an
-- open decision, deliberately not resolved by this migration; DELETE
-- policies for rule_sets/rules are therefore left exactly as Phase 6R-5
-- set them).
--
-- service_role bypasses RLS entirely, so save_lease_expense_rule_set (the
-- sole live writer of these two tables today) is completely unaffected.
-- SELECT is untouched on both tables.

DROP POLICY IF EXISTS "lease_expense_values_insert" ON public.lease_expense_values;
DROP POLICY IF EXISTS "lease_expense_values_update" ON public.lease_expense_values;

CREATE POLICY "lease_expense_values_insert" ON public.lease_expense_values
  FOR INSERT WITH CHECK (false);
CREATE POLICY "lease_expense_values_update" ON public.lease_expense_values
  FOR UPDATE USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "lease_expense_rule_clauses_insert" ON public.lease_expense_rule_clauses;

CREATE POLICY "lease_expense_rule_clauses_insert" ON public.lease_expense_rule_clauses
  FOR INSERT WITH CHECK (false);

-- Enterprise hardening Phase 6X-10: expense_classifications RLS
-- policy-shape repair (parity repair only -- not a lockdown).
--
-- Confirmed via direct inspection (local: docker exec psql; remote:
-- `supabase db query --linked`, read-only):
--
-- Local has the canonical 5 per-command policies (from
-- 20260424000000_expense_classifications.sql):
--   expense_classifications_select:             is_super_admin() OR org_id IN (SELECT get_my_org_ids())
--   expense_classifications_select_super_admin:  is_super_admin()
--   expense_classifications_insert:              is_super_admin() OR can_write_org_data(org_id)
--   expense_classifications_update:              is_super_admin() OR can_write_org_data(org_id)
--   expense_classifications_delete:              is_super_admin() OR can_write_org_data(org_id)
--
-- Remote instead has the older two-policy shape, never migrated forward:
--   expense_classifications_org_write (FOR ALL -- covers INSERT+UPDATE+DELETE
--     in one policy): is_super_admin() OR org_id IN (SELECT org_id FROM
--     memberships WHERE user_id = auth.uid()) -- no page/role gating at all,
--     more permissive than local's can_write_org_data(org_id) (which
--     requires manager/editor/finance/property_manager role or org_admin).
--   expense_classifications_org_select (FOR SELECT): same bare-membership
--     check, no is_member_of_org.
-- This predates this session's migration history entirely -- the same
-- manual-drift pattern already found and repaired for lease_critical_dates
-- (20260721000000_lease_critical_dates_rls_parity_repair.sql) and the
-- *_all remote-only blanket policies (20260709020000). Because RLS
-- policies are permissive OR'd together, expense_classifications_org_write
-- being FOR ALL under a name local doesn't share would silently survive
-- and defeat any future same-named INSERT/UPDATE/DELETE lockdown attempt
-- (the exact budgets_all mistake this session already made once and fixed)
-- -- it must be dropped by name, explicitly, as its own step, which is
-- exactly what this migration does. Confirmed via Phase 6X-8's read-only
-- investigation that this table's application-level write paths are
-- otherwise ready (every live caller already routes through
-- persist_expense_classification / review_expense_classification /
-- manual_override_expense_classification / save_lease_rule_amount_cam_input)
-- -- this migration is the prerequisite repair, not the lockdown itself.
--
-- local's SELECT policy uses "org_id IN (SELECT get_my_org_ids())" -- safe
-- on local (get_my_org_ids() there is SETOF uuid) but the exact pattern
-- already confirmed incompatible with remote's get_my_org_ids() (returns
-- uuid[] there, ERROR: operator does not exist: uuid = uuid[], SQLSTATE
-- 42883 -- see 20260706130000_lease_abstract_versions.sql's investigation).
-- Reusing the portable is_member_of_org(uuid) helper (already live on both
-- environments, confirmed via a fresh remote dump: plain boolean, no
-- set/array ambiguity, already includes an internal is_super_admin() OR
-- check) avoids reintroducing that failure here, matching the
-- lease_critical_dates repair's approach exactly.
--
-- can_write_org_data(org_id) is confirmed identical, byte-for-byte, on
-- both environments (plain boolean, no get_my_org_ids() dependency) -- the
-- insert/update/delete policies are carried over verbatim from local's
-- already-tracked intended behavior, per this phase's explicit preference.
--
-- This is a parity repair only: INSERT/UPDATE/DELETE remain allowed for
-- org members with write-capable roles (is_super_admin() OR
-- can_write_org_data(org_id)) on both environments -- not WITH CHECK
-- (false) / USING (false). No lockdown starts here. No application code,
-- RPC body, FK, or schema is touched. No other table's RLS is touched.

DROP POLICY IF EXISTS "expense_classifications_org_write" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_org_select" ON public.expense_classifications;

DROP POLICY IF EXISTS "expense_classifications_select" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_select_super_admin" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_insert" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_update" ON public.expense_classifications;
DROP POLICY IF EXISTS "expense_classifications_delete" ON public.expense_classifications;

CREATE POLICY "expense_classifications_select" ON public.expense_classifications
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY "expense_classifications_select_super_admin" ON public.expense_classifications
  FOR SELECT USING (public.is_super_admin());
CREATE POLICY "expense_classifications_insert" ON public.expense_classifications
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "expense_classifications_update" ON public.expense_classifications
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "expense_classifications_delete" ON public.expense_classifications
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

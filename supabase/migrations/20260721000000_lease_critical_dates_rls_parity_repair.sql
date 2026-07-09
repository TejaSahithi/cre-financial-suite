-- Enterprise hardening Phase 6R-0B: lease_critical_dates RLS parity repair.
--
-- Bug (remote-only, confirmed via a fresh read-only `supabase db dump
-- --linked --schema public`): public.lease_critical_dates has
-- ENABLE ROW LEVEL SECURITY set, but carries ZERO policies of any kind.
-- Postgres defaults to deny-all for every role that isn't the table owner
-- and doesn't bypass RLS once RLS is enabled with no matching policy --
-- so on remote today, ordinary authenticated org users get zero rows back
-- on SELECT and every INSERT/UPDATE/DELETE is rejected, for a table that
-- was always intended to be readable/writable by org members. This
-- predates this session's migration history entirely (no migration in
-- this repo ever disabled/dropped these policies on remote) -- the same
-- manual-drift pattern already found for audit_logs.user_id, the missing
-- audit_logs.property_id, budgets_all, and the *_all remote-only blanket
-- policies.
--
-- Local carries the originally-intended 4 named per-command policies
-- (from 20260514130000_lease_critical_dates.sql, never revised since):
--   lease_critical_dates_select: is_super_admin() OR org_id IN (SELECT get_my_org_ids())
--   lease_critical_dates_insert: is_super_admin() OR can_write_org_data(org_id)
--   lease_critical_dates_update: is_super_admin() OR can_write_org_data(org_id)
--   lease_critical_dates_delete: is_super_admin() OR can_write_org_data(org_id)
--
-- The SELECT policy's "org_id IN (SELECT get_my_org_ids())" form is safe on
-- local (get_my_org_ids() there is SETOF uuid) but is the exact pattern
-- already confirmed incompatible with remote's get_my_org_ids() (returns
-- uuid[] there) -- see the get_my_org_ids() investigation documented for
-- 20260706130000_lease_abstract_versions.sql, which hit `ERROR: operator
-- does not exist: uuid = uuid[]` (SQLSTATE 42883) on push. Reusing the
-- portable is_member_of_org(uuid) helper added for that repair (already
-- live on both environments, confirmed via a fresh remote dump: plain
-- boolean, no set/array ambiguity, already includes an internal
-- is_super_admin() OR check) avoids reintroducing that failure here.
--
-- can_write_org_data(org_id) is unchanged from local -- confirmed via the
-- same remote dump that it exists on remote with an identical, fully
-- portable (plain boolean, no get_my_org_ids() dependency) definition, so
-- the insert/update/delete policies are carried over verbatim.
--
-- This is a parity repair only: it restores the same non-lockdown,
-- org-scoped read/write behavior local already has (any org member can
-- read/write rows in their own org; super admins can read/write any org).
-- It does not change access semantics from what local has always allowed,
-- and it does not start RLS lockdown -- INSERT/UPDATE/DELETE remain
-- allowed for org members, not WITH CHECK(false)/USING(false).

ALTER TABLE public.lease_critical_dates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lease_critical_dates_select" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_insert" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_update" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_delete" ON public.lease_critical_dates;

CREATE POLICY "lease_critical_dates_select" ON public.lease_critical_dates
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY "lease_critical_dates_insert" ON public.lease_critical_dates
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "lease_critical_dates_update" ON public.lease_critical_dates
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "lease_critical_dates_delete" ON public.lease_critical_dates
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

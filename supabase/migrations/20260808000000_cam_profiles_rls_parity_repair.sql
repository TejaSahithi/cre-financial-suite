-- Enterprise hardening Phase 6CAM-1A: cam_profiles RLS parity repair.
--
-- Bug (remote-only, confirmed via a fresh read-only `supabase db dump
-- --linked --schema public`): public.cam_profiles has
-- ENABLE ROW LEVEL SECURITY set, but carries ZERO policies of any kind.
-- Postgres defaults to deny-all for every role that isn't the table owner
-- and doesn't bypass RLS once RLS is enabled with no matching policy --
-- so on remote today, ordinary authenticated org users get zero rows back
-- on SELECT and every INSERT/UPDATE/DELETE is rejected, for a table that
-- was always intended to be readable/writable by org members. This
-- predates this session's migration history entirely -- discovered during
-- Phase 6CAM-1 deployment verification, not caused by that migration (which
-- contains zero ALTER TABLE/policy statements). Same manual-drift pattern
-- already found and repaired for lease_critical_dates (Phase 6R-0B),
-- audit_logs.user_id, the missing audit_logs.property_id, budgets_all, and
-- the *_all remote-only blanket policies.
--
-- Confirmed via a repo-wide grep, this affects at least 6 read call sites
-- across 5 files (CAMSetup.jsx, AdminControlSurfaces.jsx,
-- BudgetPreviewTabs.jsx, ChargeScheduleAndPreview.jsx x2,
-- ApprovalWorkflows.jsx x2 counts) -- all silently degrade to empty
-- results/zero counts on remote today, since each uses the plain
-- user-session client (not service_role) and swallows the resulting
-- empty-result state without surfacing an error.
--
-- Local carries the originally-intended 4 named per-command policies:
--   cam_profiles_select: is_super_admin() OR org_id IN (SELECT get_my_org_ids())
--   cam_profiles_insert: is_super_admin() OR can_write_org_data(org_id)
--   cam_profiles_update: is_super_admin() OR can_write_org_data(org_id)
--   cam_profiles_delete: is_super_admin() OR can_write_org_data(org_id)
--
-- The SELECT policy's "org_id IN (SELECT get_my_org_ids())" form is safe on
-- local (get_my_org_ids() there is SETOF uuid) but is the exact pattern
-- already confirmed incompatible with remote's get_my_org_ids() (returns
-- uuid[] there) -- see the get_my_org_ids() investigation documented for
-- 20260706130000_lease_abstract_versions.sql, which hit `ERROR: operator
-- does not exist: uuid = uuid[]` (SQLSTATE 42883) on push. Reusing the
-- portable is_member_of_org(uuid) helper (already live on both
-- environments: plain boolean, no set/array ambiguity, already includes an
-- internal is_super_admin() OR check) avoids reintroducing that failure
-- here.
--
-- can_write_org_data(org_id) is unchanged from local -- confirmed via the
-- same class of remote dump used for lease_critical_dates that it exists on
-- remote with an identical, fully portable (plain boolean, no
-- get_my_org_ids() dependency) definition, so the insert/update/delete
-- policies are carried over verbatim.
--
-- This is a parity repair only: it restores the same non-lockdown,
-- org-scoped read/write behavior local already has (any org member can
-- read/write cam_profiles rows in their own org; super admins can read/
-- write any org). It does not change access semantics from what local has
-- always allowed, and it does not start RLS lockdown -- INSERT/UPDATE/
-- DELETE remain allowed for org members, not WITH CHECK(false)/USING(false).
-- save_cam_profile/approve_cam_profile (Phase 6CAM-1) are unaffected either
-- way -- both are SECURITY DEFINER RPCs called via service_role, which
-- bypasses RLS entirely.

ALTER TABLE public.cam_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cam_profiles_select" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_insert" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_update" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_delete" ON public.cam_profiles;

CREATE POLICY "cam_profiles_select" ON public.cam_profiles
  FOR SELECT USING (public.is_member_of_org(org_id));
CREATE POLICY "cam_profiles_insert" ON public.cam_profiles
  FOR INSERT WITH CHECK (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "cam_profiles_update" ON public.cam_profiles
  FOR UPDATE USING (public.is_super_admin() OR public.can_write_org_data(org_id));
CREATE POLICY "cam_profiles_delete" ON public.cam_profiles
  FOR DELETE USING (public.is_super_admin() OR public.can_write_org_data(org_id));

-- Enterprise hardening Phase HARD-1: cam_profiles RLS lockdown.
--
-- cam_profiles is the last of the six originally-scoped hardened tables
-- (budgets, expenses, expense_classifications, lease_critical_dates,
-- lease_expense_rule_*, cam_profiles) still non-locked-down. Phase 6CAM-1A
-- already restored parity (4 canonical policies, non-false, matching
-- local's intended shape). save_cam_profile/approve_cam_profile have owned
-- the table's only intended write paths since Phase 6CAM-1.
--
-- Pre-implementation investigation (this phase) confirmed:
--   - CAMSetup.jsx's save/approve mutations call only saveCamProfile/
--     approveCamProfile (server-owned via SECURITY DEFINER RPCs).
--   - AdminControlSurfaces.jsx, BudgetPreviewTabs.jsx,
--     ChargeScheduleAndPreview.jsx, ApprovalWorkflows.jsx all read-only
--     (.select() only) against cam_profiles.
--   - CAMDashboard.jsx and CustomCAMRulesTab.jsx have zero cam_profiles
--     references at all.
--   - camConfig.js has zero direct table writes anywhere (only invokes
--     edge functions).
--   - review-approve/index.ts upserts cam_profiles via the service_role
--     admin client -- not browser/authenticated-reachable, so RLS lockdown
--     has no effect on it (service_role bypasses RLS, rolbypassrls=true).
--   - leaseService.js's deleteLeaseCascadeFallback() directly deletes
--     cam_profiles rows (among ~15 other tables) via the authenticated
--     client, but only as a degraded-mode fallback exercised solely when
--     the primary delete_lease_cascade RPC call itself fails/is
--     unavailable -- not a normal user action. This is the exact same
--     class of residual risk already accepted for lease_critical_dates,
--     lease_expense_values, lease_expense_rule_clauses, and
--     lease_expense_rule_sets/rules in prior lockdown phases (6R-4, 6R-7,
--     6R-8, 6R-11) -- all of which locked down anyway with this fallback
--     documented as a known, accepted degraded-mode risk rather than a
--     blocker. Treating cam_profiles differently here would be
--     inconsistent with that established precedent.
--   - Local and remote policies confirmed identical (fresh queries against
--     both): exactly cam_profiles_select/_insert/_update/_delete, no
--     FOR ALL/broad policy on either environment.
--
-- This migration locks INSERT/UPDATE/DELETE only. cam_profiles_select is
-- untouched -- all read behavior for authorized org members and super
-- admins is unaffected. RLS remains enabled (already was).
-- save_cam_profile/approve_cam_profile (SECURITY DEFINER, service_role
-- grant only) are unaffected -- RLS lockdown only blocks the anon/
-- authenticated roles that a direct browser write would use.

DROP POLICY IF EXISTS "cam_profiles_insert" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_update" ON public.cam_profiles;
DROP POLICY IF EXISTS "cam_profiles_delete" ON public.cam_profiles;

CREATE POLICY "cam_profiles_insert" ON public.cam_profiles
  FOR INSERT WITH CHECK (false);
CREATE POLICY "cam_profiles_update" ON public.cam_profiles
  FOR UPDATE USING (false) WITH CHECK (false);
CREATE POLICY "cam_profiles_delete" ON public.cam_profiles
  FOR DELETE USING (false);

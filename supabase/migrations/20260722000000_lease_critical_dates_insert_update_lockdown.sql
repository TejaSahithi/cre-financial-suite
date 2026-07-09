-- Enterprise hardening Phase 6R-4: lease_critical_dates INSERT/UPDATE lockdown.
--
-- All live create/update/mark_complete writes to lease_critical_dates now
-- route through manage_lease_critical_date (Phase 6D-4 RPC, SECURITY
-- DEFINER, service_role-only grant) via the manage-lease-critical-date edge
-- function -- confirmed via Phase 6R-3's fresh inventory: zero live direct
-- INSERT/UPDATE call sites remain anywhere in src/. service_role bypasses
-- RLS entirely (confirmed earlier this session via pg_roles.rolbypassrls),
-- so locking these two commands down does not affect the RPC path at all.
--
-- DELETE is deliberately left untouched this phase -- leaseService.js's
-- deleteLeaseCascadeFallback still issues a direct DELETE against this
-- table as a fallback tier when delete_lease_cascade is unavailable; that
-- decision needs its own resolution before DELETE lockdown, per Phase
-- 6R-3's readiness matrix. SELECT is untouched.
--
-- Scoped to lease_critical_dates only -- no other table's policies are
-- touched by this migration.

DROP POLICY IF EXISTS "lease_critical_dates_insert" ON public.lease_critical_dates;
DROP POLICY IF EXISTS "lease_critical_dates_update" ON public.lease_critical_dates;

CREATE POLICY "lease_critical_dates_insert" ON public.lease_critical_dates
  FOR INSERT WITH CHECK (false);
CREATE POLICY "lease_critical_dates_update" ON public.lease_critical_dates
  FOR UPDATE USING (false) WITH CHECK (false);

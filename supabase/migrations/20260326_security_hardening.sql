-- ============================================================
-- CRE Financial Suite — Security Hardening Migration
-- Fixes: privilege escalation, insecure defaults, broad RLS
-- Date: 2026-03-26
-- ============================================================

-- ============================================================
-- FIX 1: MEMBERSHIPS INSERT — Prevent Privilege Escalation
-- 
-- PROBLEM: The old policy allowed any authenticated user to
-- insert a membership with ANY role (including super_admin)
-- for ANY organization, by simply setting user_id = auth.uid().
--
-- FIX: When a user creates their own membership (onboarding),
-- force the role to 'org_admin' (org creator). Only existing
-- org_admin/super_admin can assign arbitrary roles.
-- ============================================================

DROP POLICY IF EXISTS "memberships_insert" ON public.memberships;

CREATE POLICY "memberships_insert_secure" ON public.memberships
  FOR INSERT WITH CHECK (
    -- Case 1: Admin-initiated invite — org_admin or super_admin can assign any role
    public.is_org_admin(org_id)
    OR (
      -- Case 2: Self-registration during onboarding — user creates their OWN membership
      -- but ONLY with 'org_admin' role (the org creator role) and ONLY if they
      -- don't already have a membership in that org.
      user_id = auth.uid()
      AND role = 'org_admin'
      AND NOT EXISTS (
        SELECT 1 FROM public.memberships m
        WHERE m.user_id = auth.uid() AND m.org_id = memberships.org_id
      )
    )
  );


-- ============================================================
-- FIX 2: ORGANIZATIONS INSERT — Require Authentication
--
-- PROBLEM: `WITH CHECK (true)` allowed unauthenticated inserts,
-- enabling spam/bot org creation.
--
-- FIX: Require an authenticated user (auth.uid() IS NOT NULL).
-- ============================================================

DROP POLICY IF EXISTS "orgs_insert" ON public.organizations;

CREATE POLICY "orgs_insert_authenticated" ON public.organizations
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);


-- ============================================================
-- FIX 3: GRANULAR RLS FOR ORG ASSETS
--
-- PROBLEM: The dynamic loop in 20260322_add_core_tables.sql
-- created `FOR ALL` policies, meaning any org member (viewer)
-- could INSERT, UPDATE, or DELETE data like leases, expenses.
--
-- FIX: Replace `FOR ALL` with separate SELECT and write
-- policies. Write operations require org_admin, manager, or
-- editor roles.
-- ============================================================

-- Helper function: can the current user write to this org's data?
CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.memberships
    WHERE user_id = auth.uid()
      AND org_id = check_org_id
      AND role IN ('super_admin', 'org_admin', 'manager', 'editor')
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER;


-- Apply granular policies to each asset table
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN SELECT unnest(ARRAY[
      'portfolios', 'properties', 'buildings', 'units',
      'tenants', 'leases', 'expenses', 'budgets',
      'vendors', 'invoices'
    ])
    LOOP
        -- Drop the old overly-permissive policies
        EXECUTE format('DROP POLICY IF EXISTS "%s_all" ON public.%I', t, t);

        -- Keep the SELECT policy (any org member can read)
        -- It may already exist from the previous migration, so drop+recreate
        EXECUTE format('DROP POLICY IF EXISTS "%s_select" ON public.%I', t, t);
        EXECUTE format(
          'CREATE POLICY "%s_select" ON public.%I FOR SELECT USING (org_id = ANY(public.get_my_org_ids()))',
          t, t
        );

        -- INSERT: only org_admin, manager, editor
        EXECUTE format('DROP POLICY IF EXISTS "%s_insert" ON public.%I', t, t);
        EXECUTE format(
          'CREATE POLICY "%s_insert" ON public.%I FOR INSERT WITH CHECK (public.can_write_org_data(org_id))',
          t, t
        );

        -- UPDATE: only org_admin, manager, editor
        EXECUTE format('DROP POLICY IF EXISTS "%s_update" ON public.%I', t, t);
        EXECUTE format(
          'CREATE POLICY "%s_update" ON public.%I FOR UPDATE USING (public.can_write_org_data(org_id))',
          t, t
        );

        -- DELETE: only org_admin
        EXECUTE format('DROP POLICY IF EXISTS "%s_delete" ON public.%I', t, t);
        EXECUTE format(
          'CREATE POLICY "%s_delete" ON public.%I FOR DELETE USING (public.is_org_admin(org_id))',
          t, t
        );
    END LOOP;
END $$;


-- ============================================================
-- FIX 4: NOTIFICATIONS — Add INSERT policy
-- 
-- Notifications table had SELECT and UPDATE but no INSERT
-- policy for regular users, only SECURITY DEFINER triggers
-- could insert. This is correct but let's make it explicit.
-- ============================================================

-- Only allow system (SECURITY DEFINER triggers) to insert notifications
-- Regular users should not be able to create arbitrary notifications
DROP POLICY IF EXISTS "notifications_insert_system" ON public.notifications;
-- No user-facing INSERT policy needed — triggers use SECURITY DEFINER


-- ============================================================
-- FIX 5: AUDIT LOGS — Prevent user tampering
--
-- Audit logs should be append-only from triggers.
-- No user should be able to UPDATE or DELETE audit records.
-- ============================================================

-- Explicitly deny update/delete (no policies = denied by default with RLS enabled)
-- The existing SELECT policy is already admin-only, which is correct.
-- Just ensure no ALL/UPDATE/DELETE policies exist:
DROP POLICY IF EXISTS "audit_logs_all" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_update" ON public.audit_logs;
DROP POLICY IF EXISTS "audit_logs_delete" ON public.audit_logs;

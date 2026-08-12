-- Migration: 20269900000066_fix_write_role_rls_for_non_admin_roles.sql
--
-- Problem:
--   Migration 20260874000000_update_expenses_and_audit_logs.sql overwrote
--   can_write_page() with a version that only allows super_admin, org_admin,
--   and owner roles — blocking portfolio_manager, property_manager,
--   lease_admin, leasing_agent, finance, and custom_role from writing data
--   even when their role clearly grants it (e.g. "Failed to create property:
--   new row violates row-level security policy for table 'properties'").
--
--   Additionally, schema-rebuild migrations (20260869–20260873) replaced the
--   correct can_write_page()-based RLS on leases, tenants, and vendors with
--   hard is_org_admin()-only policies, blocking those same roles.
--
-- Fix:
--   1. Restore can_write_page() to the correct implementation from
--      20260908000200_canonical_cre_roles_only.sql.
--   2. Drop and recreate INSERT/UPDATE/DELETE policies on properties, leases,
--      tenants, vendors, expenses, buildings, and units using can_write_page()
--      so that all canonical write roles work correctly.
--   3. Fix membership status drift: update invited members who have signed in
--      (or have an approved profile) to 'active' so they are not excluded by
--      the membership status checks inside membership_page_access().

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 1: Restore can_write_page() to canonical implementation.
--         Delegates entirely to membership_page_access() which uses
--         role_default_page_access() — the function that correctly grants
--         'write' access to portfolio_manager, property_manager, etc.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.can_write_page(check_org_id uuid, page_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 2;
$$;

CREATE OR REPLACE FUNCTION public.can_write_any_page(check_org_id uuid, page_names text[])
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(page_names, ARRAY[]::text[])) AS page_name
    WHERE public.can_write_page(check_org_id, page_name)
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 2: Fix membership status drift.
--         Invited members who have accepted and signed in should be 'active'.
--         Without this, membership_page_access() returns 'none' because it
--         requires status IN ('active', 'owner', 'approved', 'accepted').
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE public.memberships m
SET    status     = 'active',
       updated_at = now()
FROM   public.profiles p
WHERE  p.id       = m.user_id
  AND  m.status   = 'invited'
  AND  (
         p.status IN ('active', 'approved')
      OR p.onboarding_complete = true
      OR p.last_sign_in_at IS NOT NULL
  );

-- Also accept pending invitations for members who are now active.
UPDATE public.invitations i
SET    status     = 'accepted',
       updated_at = now()
FROM   public.memberships m
JOIN   public.profiles p ON p.id = m.user_id
WHERE  i.org_id      = m.org_id
  AND  lower(i.email) = lower(p.email)
  AND  m.status      IN ('active', 'owner')
  AND  i.status      IN ('pending', 'pending_approval');

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 3: Rebuild properties INSERT / UPDATE / DELETE policies.
--         Drop both quoted and unquoted variants to ensure a clean slate.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "properties_insert" ON public.properties;
DROP POLICY IF EXISTS properties_insert   ON public.properties;
DROP POLICY IF EXISTS "properties_update" ON public.properties;
DROP POLICY IF EXISTS properties_update   ON public.properties;
DROP POLICY IF EXISTS "properties_delete" ON public.properties;
DROP POLICY IF EXISTS properties_delete   ON public.properties;

CREATE POLICY "properties_insert" ON public.properties
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Properties'));

CREATE POLICY "properties_update" ON public.properties
  FOR UPDATE USING  (public.can_write_page(org_id, 'Properties'))
  WITH CHECK        (public.can_write_page(org_id, 'Properties'));

CREATE POLICY "properties_delete" ON public.properties
  FOR DELETE USING  (public.can_write_page(org_id, 'Properties'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 4: Rebuild buildings INSERT / UPDATE / DELETE policies.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "buildings_insert" ON public.buildings;
DROP POLICY IF EXISTS buildings_insert   ON public.buildings;
DROP POLICY IF EXISTS "buildings_update" ON public.buildings;
DROP POLICY IF EXISTS buildings_update   ON public.buildings;
DROP POLICY IF EXISTS "buildings_delete" ON public.buildings;
DROP POLICY IF EXISTS buildings_delete   ON public.buildings;

CREATE POLICY "buildings_insert" ON public.buildings
  FOR INSERT WITH CHECK (
    public.can_write_page(org_id, 'Buildings')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  );

CREATE POLICY "buildings_update" ON public.buildings
  FOR UPDATE USING (
    public.can_write_page(org_id, 'Buildings')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  )
  WITH CHECK (
    public.can_write_page(org_id, 'Buildings')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  );

CREATE POLICY "buildings_delete" ON public.buildings
  FOR DELETE USING (
    public.can_write_page(org_id, 'Buildings')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 5: Rebuild units INSERT / UPDATE / DELETE policies.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "units_insert" ON public.units;
DROP POLICY IF EXISTS units_insert   ON public.units;
DROP POLICY IF EXISTS "units_update" ON public.units;
DROP POLICY IF EXISTS units_update   ON public.units;
DROP POLICY IF EXISTS "units_delete" ON public.units;
DROP POLICY IF EXISTS units_delete   ON public.units;

CREATE POLICY "units_insert" ON public.units
  FOR INSERT WITH CHECK (
    public.can_write_page(org_id, 'Units')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  );

CREATE POLICY "units_update" ON public.units
  FOR UPDATE USING (
    public.can_write_page(org_id, 'Units')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  )
  WITH CHECK (
    public.can_write_page(org_id, 'Units')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  );

CREATE POLICY "units_delete" ON public.units
  FOR DELETE USING (
    public.can_write_page(org_id, 'Units')
    OR public.can_write_page(org_id, 'BuildingsUnits')
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 6: Rebuild leases INSERT / UPDATE / DELETE policies.
--         20260873000000 locked these to is_org_admin() only.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "leases_insert" ON public.leases;
DROP POLICY IF EXISTS leases_insert   ON public.leases;
DROP POLICY IF EXISTS "leases_update" ON public.leases;
DROP POLICY IF EXISTS leases_update   ON public.leases;
DROP POLICY IF EXISTS "leases_delete" ON public.leases;
DROP POLICY IF EXISTS leases_delete   ON public.leases;

CREATE POLICY "leases_insert" ON public.leases
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "leases_delete" ON public.leases
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 7: Rebuild tenants INSERT / UPDATE / DELETE policies.
--         20260870000000 locked these to is_org_admin() only.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "tenants_insert" ON public.tenants;
DROP POLICY IF EXISTS tenants_insert   ON public.tenants;
DROP POLICY IF EXISTS "tenants_update" ON public.tenants;
DROP POLICY IF EXISTS tenants_update   ON public.tenants;
DROP POLICY IF EXISTS "tenants_delete" ON public.tenants;
DROP POLICY IF EXISTS tenants_delete   ON public.tenants;

CREATE POLICY "tenants_insert" ON public.tenants
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Tenants'));

CREATE POLICY "tenants_update" ON public.tenants
  FOR UPDATE USING  (public.can_write_page(org_id, 'Tenants'))
  WITH CHECK        (public.can_write_page(org_id, 'Tenants'));

CREATE POLICY "tenants_delete" ON public.tenants
  FOR DELETE USING  (public.can_write_page(org_id, 'Tenants'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 8: Rebuild vendors INSERT / UPDATE / DELETE policies.
--         20260871000000 locked these to is_org_admin() only.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "vendors_insert" ON public.vendors;
DROP POLICY IF EXISTS vendors_insert   ON public.vendors;
DROP POLICY IF EXISTS "vendors_update" ON public.vendors;
DROP POLICY IF EXISTS vendors_update   ON public.vendors;
DROP POLICY IF EXISTS "vendors_delete" ON public.vendors;
DROP POLICY IF EXISTS vendors_delete   ON public.vendors;

CREATE POLICY "vendors_insert" ON public.vendors
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Vendors'));

CREATE POLICY "vendors_update" ON public.vendors
  FOR UPDATE USING  (public.can_write_page(org_id, 'Vendors'))
  WITH CHECK        (public.can_write_page(org_id, 'Vendors'));

CREATE POLICY "vendors_delete" ON public.vendors
  FOR DELETE USING  (public.can_write_page(org_id, 'Vendors'));

-- ─────────────────────────────────────────────────────────────────────────────
-- Step 9: Rebuild expenses INSERT / UPDATE / DELETE policies.
--         20260874000000 overwrote can_write_page to only check admin roles.
--         Now that can_write_page() is restored, re-anchor these policies.
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;
DROP POLICY IF EXISTS expenses_insert   ON public.expenses;
DROP POLICY IF EXISTS "expenses_update" ON public.expenses;
DROP POLICY IF EXISTS expenses_update   ON public.expenses;
DROP POLICY IF EXISTS "expenses_delete" ON public.expenses;
DROP POLICY IF EXISTS expenses_delete   ON public.expenses;

CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- Grant execute so authenticated callers can reach these helpers.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION public.can_write_page(uuid, text)       TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_write_any_page(uuid, text[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

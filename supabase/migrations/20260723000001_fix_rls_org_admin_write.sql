-- ================================================================
-- COMPLETE RLS FIX: Multi-tenant org isolation + org_admin full access
--
-- Rules:
--   1. SELECT: a user sees ONLY their active org's data (strict isolation)
--   2. INSERT/UPDATE/DELETE: any org_admin/owner of that org can do anything
--   3. Super admins bypass all restrictions
-- ================================================================

-- ── Helper: single active org_id for the current session ────────────────────
-- Returns the org_id of the user's highest-privilege active membership.
-- Super admins return NULL (platform-wide access handled by is_super_admin()).
CREATE OR REPLACE FUNCTION public.get_my_active_org_id()
RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT m.org_id
  FROM public.memberships m
  WHERE m.user_id = auth.uid()
    AND coalesce(m.status, 'active') IN ('active', 'owner')
  ORDER BY
    CASE m.role
      WHEN 'super_admin' THEN 0
      WHEN 'org_admin'   THEN 1
      WHEN 'owner'       THEN 1
      ELSE 2
    END,
    m.created_at ASC
  LIMIT 1;
$$;

-- ── is_org_admin: includes 'owner' role ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND m.role IN ('org_admin', 'owner', 'super_admin')
        AND coalesce(m.status, 'active') IN ('active', 'owner')
    );
$$;

-- ── can_write_page: org admins bypass page permission checks ─────────────────
CREATE OR REPLACE FUNCTION public.can_write_page(check_org_id UUID, page_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_org_admin(check_org_id)
    OR public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 2;
$$;

-- ── can_read_page: org admins bypass page permission checks ──────────────────
CREATE OR REPLACE FUNCTION public.can_read_page(check_org_id UUID, page_name TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_org_admin(check_org_id)
    OR public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 1;
$$;

-- ════════════════════════════════════════════════════════════════
-- PORTFOLIOS
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "portfolios_select" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_insert" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_update" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_delete" ON public.portfolios;

CREATE POLICY "portfolios_select" ON public.portfolios
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "portfolios_insert" ON public.portfolios
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );
CREATE POLICY "portfolios_update" ON public.portfolios
  FOR UPDATE
  USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "portfolios_delete" ON public.portfolios
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- PROPERTIES
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "properties_select" ON public.properties;
DROP POLICY IF EXISTS "properties_insert" ON public.properties;
DROP POLICY IF EXISTS "properties_update" ON public.properties;
DROP POLICY IF EXISTS "properties_delete" ON public.properties;

CREATE POLICY "properties_select" ON public.properties
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "properties_insert" ON public.properties
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );
CREATE POLICY "properties_update" ON public.properties
  FOR UPDATE
  USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "properties_delete" ON public.properties
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- BUILDINGS
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "buildings_select" ON public.buildings;
DROP POLICY IF EXISTS "buildings_insert" ON public.buildings;
DROP POLICY IF EXISTS "buildings_update" ON public.buildings;
DROP POLICY IF EXISTS "buildings_delete" ON public.buildings;

CREATE POLICY "buildings_select" ON public.buildings
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "buildings_insert" ON public.buildings
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );
CREATE POLICY "buildings_update" ON public.buildings
  FOR UPDATE
  USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "buildings_delete" ON public.buildings
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- UNITS
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "units_select" ON public.units;
DROP POLICY IF EXISTS "units_insert" ON public.units;
DROP POLICY IF EXISTS "units_update" ON public.units;
DROP POLICY IF EXISTS "units_delete" ON public.units;

CREATE POLICY "units_select" ON public.units
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "units_insert" ON public.units
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );
CREATE POLICY "units_update" ON public.units
  FOR UPDATE
  USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "units_delete" ON public.units
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- LEASES
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "leases_select" ON public.leases;
DROP POLICY IF EXISTS "leases_insert" ON public.leases;
DROP POLICY IF EXISTS "leases_update" ON public.leases;
DROP POLICY IF EXISTS "leases_delete" ON public.leases;

CREATE POLICY "leases_select" ON public.leases
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "leases_insert" ON public.leases
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.is_org_admin(org_id)
    OR public.can_write_page(org_id, 'Leases')
  );
CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE
  USING (public.is_super_admin() OR public.can_write_page(org_id, 'Leases'))
  WITH CHECK (public.is_super_admin() OR public.can_write_page(org_id, 'Leases'));
CREATE POLICY "leases_delete" ON public.leases
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- TENANTS
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "tenants_select" ON public.tenants;
DROP POLICY IF EXISTS "tenants_insert" ON public.tenants;
DROP POLICY IF EXISTS "tenants_update" ON public.tenants;
DROP POLICY IF EXISTS "tenants_delete" ON public.tenants;

CREATE POLICY "tenants_select" ON public.tenants
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "tenants_insert" ON public.tenants
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.can_write_page(org_id, 'Tenants')
  );
CREATE POLICY "tenants_update" ON public.tenants
  FOR UPDATE
  USING (public.is_super_admin() OR public.can_write_page(org_id, 'Tenants'))
  WITH CHECK (public.is_super_admin() OR public.can_write_page(org_id, 'Tenants'));
CREATE POLICY "tenants_delete" ON public.tenants
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- VENDORS
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "vendors_select" ON public.vendors;
DROP POLICY IF EXISTS "vendors_insert" ON public.vendors;
DROP POLICY IF EXISTS "vendors_update" ON public.vendors;
DROP POLICY IF EXISTS "vendors_delete" ON public.vendors;

CREATE POLICY "vendors_select" ON public.vendors
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "vendors_insert" ON public.vendors
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.can_write_page(org_id, 'Vendors')
  );
CREATE POLICY "vendors_update" ON public.vendors
  FOR UPDATE
  USING (public.is_super_admin() OR public.can_write_page(org_id, 'Vendors'))
  WITH CHECK (public.is_super_admin() OR public.can_write_page(org_id, 'Vendors'));
CREATE POLICY "vendors_delete" ON public.vendors
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- EXPENSES
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "expenses_select" ON public.expenses;
DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;
DROP POLICY IF EXISTS "expenses_update" ON public.expenses;
DROP POLICY IF EXISTS "expenses_delete" ON public.expenses;

CREATE POLICY "expenses_select" ON public.expenses
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.can_write_page(org_id, 'Expenses')
  );
CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE
  USING (public.is_super_admin() OR public.can_write_page(org_id, 'Expenses'))
  WITH CHECK (public.is_super_admin() OR public.can_write_page(org_id, 'Expenses'));
CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ════════════════════════════════════════════════════════════════
-- GL ACCOUNTS
-- ════════════════════════════════════════════════════════════════
DROP POLICY IF EXISTS "gl_accounts_select" ON public.gl_accounts;
DROP POLICY IF EXISTS "gl_accounts_insert" ON public.gl_accounts;
DROP POLICY IF EXISTS "gl_accounts_update" ON public.gl_accounts;
DROP POLICY IF EXISTS "gl_accounts_delete" ON public.gl_accounts;

CREATE POLICY "gl_accounts_select" ON public.gl_accounts
  FOR SELECT USING (
    public.is_super_admin()
    OR org_id = public.get_my_active_org_id()
  );
CREATE POLICY "gl_accounts_insert" ON public.gl_accounts
  FOR INSERT WITH CHECK (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );
CREATE POLICY "gl_accounts_update" ON public.gl_accounts
  FOR UPDATE
  USING (public.is_super_admin() OR public.is_org_admin(org_id))
  WITH CHECK (public.is_super_admin() OR public.is_org_admin(org_id));
CREATE POLICY "gl_accounts_delete" ON public.gl_accounts
  FOR DELETE USING (
    public.is_super_admin() OR public.is_org_admin(org_id)
  );

-- ── Reload PostgREST schema cache ────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';

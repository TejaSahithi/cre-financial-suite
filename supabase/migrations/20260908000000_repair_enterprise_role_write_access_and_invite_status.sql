-- Repair enterprise CRE write access and accepted-invite status drift.
-- This migration aligns core-table RLS with page-level authority so standard
-- roles such as portfolio_manager can create/update scoped operational data.

CREATE OR REPLACE FUNCTION public.is_org_admin(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND m.role IN ('org_owner', 'org_admin', 'owner', 'super_admin')
        AND COALESCE(m.status, 'active') IN ('active', 'owner')
    );
$$;

CREATE OR REPLACE FUNCTION public.role_default_page_access(role_key text, page_name text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(role_key, '')) IN ('super_admin', 'org_owner', 'org_admin', 'owner', 'admin')
      THEN 'admin'
    WHEN lower(COALESCE(role_key, '')) IN ('asset_manager', 'portfolio_manager', 'operations_director')
      AND page_name IN (
        'Dashboard', 'PortfolioOverview', 'PortfolioInsights', 'Portfolios',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection'
      )
      THEN 'write'
    WHEN lower(COALESCE(role_key, '')) IN ('property_manager', 'facility_manager', 'construction_manager')
      AND page_name IN (
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection'
      )
      THEN 'write'
    WHEN lower(COALESCE(role_key, '')) IN ('leasing_agent', 'lease_admin')
      AND page_name IN ('Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection')
      THEN 'write'
    WHEN lower(COALESCE(role_key, '')) IN ('finance', 'cfo', 'controller', 'accounts_manager')
      AND page_name IN ('Expenses', 'AddExpense', 'ExpenseReview', 'Revenue', 'Billing', 'BudgetDashboard', 'CreateBudget', 'CAMDashboard', 'CAMRun')
      THEN 'write'
    WHEN lower(COALESCE(role_key, '')) IN ('financial_analyst', 'analyst', 'auditor', 'property_owner')
      THEN 'read'
    ELSE 'none'
  END;
$$;

CREATE OR REPLACE FUNCTION public.can_write_page(check_org_id uuid, page_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    public.is_super_admin()
    OR public.is_org_admin(check_org_id)
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND COALESCE(m.status, 'active') IN ('active', 'owner')
        AND (
          public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 2
          OR public.access_level_rank(public.role_default_page_access(m.role, page_name)) >= 2
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.can_write_org_data(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR public.is_org_admin(check_org_id)
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND COALESCE(m.status, 'active') IN ('active', 'owner')
        AND m.role IN (
          'admin', 'manager', 'editor', 'finance',
          'asset_manager', 'portfolio_manager', 'operations_director',
          'property_manager', 'facility_manager', 'construction_manager',
          'leasing_agent', 'lease_admin', 'accounts_manager', 'cfo'
        )
    );
$$;

DROP POLICY IF EXISTS "portfolios_insert" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_update" ON public.portfolios;
DROP POLICY IF EXISTS "portfolios_delete" ON public.portfolios;
CREATE POLICY "portfolios_insert" ON public.portfolios
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Portfolios'));
CREATE POLICY "portfolios_update" ON public.portfolios
  FOR UPDATE USING (public.can_write_page(org_id, 'Portfolios'))
  WITH CHECK (public.can_write_page(org_id, 'Portfolios'));
CREATE POLICY "portfolios_delete" ON public.portfolios
  FOR DELETE USING (public.can_write_page(org_id, 'Portfolios'));

DROP POLICY IF EXISTS "properties_insert" ON public.properties;
DROP POLICY IF EXISTS "properties_update" ON public.properties;
DROP POLICY IF EXISTS "properties_delete" ON public.properties;
CREATE POLICY "properties_insert" ON public.properties
  FOR INSERT WITH CHECK (public.can_write_page(org_id, 'Properties'));
CREATE POLICY "properties_update" ON public.properties
  FOR UPDATE USING (public.can_write_page(org_id, 'Properties'))
  WITH CHECK (public.can_write_page(org_id, 'Properties'));
CREATE POLICY "properties_delete" ON public.properties
  FOR DELETE USING (public.can_write_page(org_id, 'Properties'));

DROP POLICY IF EXISTS "buildings_insert" ON public.buildings;
DROP POLICY IF EXISTS "buildings_update" ON public.buildings;
DROP POLICY IF EXISTS "buildings_delete" ON public.buildings;
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

DROP POLICY IF EXISTS "units_insert" ON public.units;
DROP POLICY IF EXISTS "units_update" ON public.units;
DROP POLICY IF EXISTS "units_delete" ON public.units;
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

UPDATE public.memberships m
SET status = 'active',
    updated_at = now()
FROM public.profiles p
WHERE p.id = m.user_id
  AND m.status = 'invited'
  AND (
    p.status = 'active'
    OR p.onboarding_complete = true
    OR p.last_sign_in_at IS NOT NULL
  );

UPDATE public.invitations i
SET status = 'accepted',
    updated_at = now()
FROM public.memberships m
JOIN public.profiles p ON p.id = m.user_id
WHERE i.org_id = m.org_id
  AND lower(i.email) = lower(p.email)
  AND m.status IN ('active', 'owner')
  AND i.status IN ('pending', 'pending_approval');

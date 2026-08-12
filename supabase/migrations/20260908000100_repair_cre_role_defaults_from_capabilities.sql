-- Follow-up repair for CRE role defaults stored in capabilities.roles.
--
-- Some invited users carry the legacy primary membership role (for example
-- "manager") while the CRE role chosen in User Management is stored in
-- memberships.capabilities->'roles'. RLS must honor both sources.

CREATE OR REPLACE FUNCTION public.role_default_page_access(role_name text, page_name text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  WITH normalized AS (
    SELECT lower(COALESCE(role_name, '')) AS role_key
  )
  SELECT CASE
    WHEN role_key IN ('admin', 'super_admin', 'org_owner', 'org_admin', 'owner') THEN 'admin'
    WHEN role_key IN (
      'manager',
      'asset_manager',
      'portfolio_manager',
      'operations_director',
      'facility_manager',
      'construction_manager',
      'acquisitions_mgr',
      'leasing_director'
    )
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioOverview', 'PortfolioInsights', 'Portfolios',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors',
        'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection',
        'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'Billing', 'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key = 'property_manager'
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors',
        'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection',
        'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'Billing', 'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key IN (
      'editor',
      'financial_analyst',
      'leasing_agent',
      'lease_admin',
      'finance',
      'cfo',
      'controller',
      'cfo_controller',
      'accounts_manager'
    )
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail',
        'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection',
        'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Billing', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'Reconciliation',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'ChartOfAccounts', 'Vendors', 'Notifications', 'Documents'
      ]) THEN 'write'
    WHEN role_key IN ('viewer', 'read_only', 'investor_relations', 'property_owner')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'Billing', 'ExpenseProjection', 'LeaseExpenseClassification',
        'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'AnalyticsReports', 'Reports', 'Analytics',
        'CAMDashboard', 'CAMSetup', 'Notifications', 'Documents'
      ]) THEN 'read'
    WHEN role_key IN ('auditor', 'compliance_officer', 'internal_auditor')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'AuditLog',
        'Expenses', 'Billing', 'ChartOfAccounts',
        'BudgetDashboard', 'BudgetReview', 'Revenue',
        'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'Reconciliation',
        'AnalyticsReports', 'Reports', 'Analytics',
        'CAMDashboard', 'CAMSetup', 'Documents', 'Notifications',
        'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules'
      ]) THEN 'read'
    ELSE 'none'
  END
  FROM normalized;
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
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(COALESCE(m.capabilities, '{}'::jsonb)->'roles') = 'array'
                  THEN COALESCE(m.capabilities, '{}'::jsonb)->'roles'
                ELSE '[]'::jsonb
              END
            ) AS capability_roles(role_name)
            WHERE public.access_level_rank(public.role_default_page_access(capability_roles.role_name, page_name)) >= 2
          )
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
        AND (
          m.role IN (
            'admin', 'manager', 'editor', 'finance',
            'asset_manager', 'portfolio_manager', 'operations_director',
            'property_manager', 'facility_manager', 'construction_manager',
            'leasing_agent', 'lease_admin', 'accounts_manager', 'cfo', 'controller'
          )
          OR EXISTS (
            SELECT 1
            FROM jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(COALESCE(m.capabilities, '{}'::jsonb)->'roles') = 'array'
                  THEN COALESCE(m.capabilities, '{}'::jsonb)->'roles'
                ELSE '[]'::jsonb
              END
            ) AS capability_roles(role_name)
            WHERE capability_roles.role_name IN (
              'admin', 'manager', 'editor', 'finance',
              'asset_manager', 'portfolio_manager', 'operations_director',
              'property_manager', 'facility_manager', 'construction_manager',
              'leasing_agent', 'lease_admin', 'accounts_manager', 'cfo', 'controller'
            )
          )
        )
    );
$$;

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

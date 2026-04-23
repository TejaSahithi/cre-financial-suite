-- Phase 3: align server-side page access with the frontend's role + module +
-- page-permission evaluator, then use that aligned truth in the RLS policies
-- that back write-capable pages.

CREATE OR REPLACE FUNCTION public.normalize_page_access_level(raw_level TEXT)
RETURNS TEXT AS $$
  SELECT CASE lower(COALESCE(raw_level, 'none'))
    WHEN 'full' THEN 'admin'
    WHEN 'manage' THEN 'admin'
    WHEN 'admin' THEN 'admin'
    WHEN 'approve' THEN 'approve'
    WHEN 'write' THEN 'write'
    WHEN 'edit' THEN 'write'
    WHEN 'read' THEN 'read'
    WHEN 'read_only' THEN 'read'
    WHEN 'readonly' THEN 'read'
    WHEN 'view' THEN 'read'
    ELSE 'none'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.min_page_access_level(left_level TEXT, right_level TEXT)
RETURNS TEXT AS $$
  SELECT CASE LEAST(
    public.access_level_rank(public.normalize_page_access_level(left_level)),
    public.access_level_rank(public.normalize_page_access_level(right_level))
  )
    WHEN 4 THEN 'admin'
    WHEN 3 THEN 'approve'
    WHEN 2 THEN 'write'
    WHEN 1 THEN 'read'
    ELSE 'none'
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.page_module_key(page_name TEXT)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN page_name = ANY (ARRAY['Dashboard']) THEN 'dashboard'
    WHEN page_name = ANY (ARRAY['Portfolios']) THEN 'portfolio'
    WHEN page_name = ANY (ARRAY['Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail']) THEN 'properties'
    WHEN page_name = ANY (ARRAY['Tenants', 'TenantDetail']) THEN 'tenants'
    WHEN page_name = ANY (ARRAY['Vendors']) THEN 'vendors'
    WHEN page_name = ANY (ARRAY['Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection']) THEN 'leases'
    WHEN page_name = ANY (ARRAY['Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection']) THEN 'expenses'
    WHEN page_name = ANY (ARRAY['CAMDashboard', 'CAMCalculation']) THEN 'cam'
    WHEN page_name = ANY (ARRAY['Billing']) THEN 'billing'
    WHEN page_name = ANY (ARRAY['Revenue']) THEN 'revenue'
    WHEN page_name = ANY (ARRAY['BudgetDashboard', 'CreateBudget', 'BudgetReview']) THEN 'budgets'
    WHEN page_name = ANY (ARRAY['ActualsVariance', 'Actuals', 'Variance']) THEN 'actuals_variance'
    WHEN page_name = ANY (ARRAY['Comparison']) THEN 'comparison'
    WHEN page_name = ANY (ARRAY['Reconciliation']) THEN 'reconciliation'
    WHEN page_name = ANY (ARRAY['AnalyticsReports', 'Reports', 'Analytics', 'PortfolioInsights']) THEN 'analytics_reports'
    WHEN page_name = ANY (ARRAY['Workflows']) THEN 'workflows'
    WHEN page_name = ANY (ARRAY['Notifications']) THEN 'notifications'
    WHEN page_name = ANY (ARRAY['Documents']) THEN 'documents'
    WHEN page_name = ANY (ARRAY['Integrations']) THEN 'integrations'
    WHEN page_name = ANY (ARRAY['SuperAdmin', 'Stakeholders', 'OrgSettings', 'ChartOfAccounts', 'AuditLog', 'UserManagement']) THEN 'admin'
    ELSE NULL
  END;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.role_default_page_access(role_name TEXT, page_name TEXT)
RETURNS TEXT AS $$
  WITH normalized AS (
    SELECT lower(COALESCE(role_name, '')) AS role_key
  )
  SELECT CASE
    WHEN role_key IN ('admin', 'super_admin', 'org_admin') THEN 'admin'
    WHEN role_key IN ('manager', 'asset_manager', 'portfolio_manager', 'operations_director', 'facility_manager', 'construction_manager', 'acquisitions_mgr', 'leasing_director')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Portfolios', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors', 'Leases', 'LeaseUpload', 'LeaseReview',
        'Expenses', 'AddExpense', 'BulkImport', 'CAMDashboard', 'CAMCalculation',
        'Billing', 'BudgetDashboard', 'CreateBudget', 'BudgetReview', 'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key = 'property_manager'
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors', 'Leases', 'LeaseUpload', 'LeaseReview',
        'Expenses', 'AddExpense', 'BulkImport', 'CAMDashboard', 'CAMCalculation',
        'Billing', 'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key IN ('editor', 'financial_analyst', 'leasing_agent', 'lease_admin', 'finance', 'cfo_controller', 'accounts_manager')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseUpload', 'LeaseReview',
        'Expenses', 'AddExpense', 'BulkImport', 'BudgetDashboard', 'CreateBudget',
        'Billing', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance', 'Comparison',
        'Reconciliation', 'CAMDashboard', 'CAMCalculation', 'ChartOfAccounts',
        'Vendors', 'Notifications', 'Documents'
      ]) THEN 'write'
    WHEN role_key IN ('viewer', 'read_only', 'investor_relations')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseReview', 'Expenses', 'Billing',
        'BudgetDashboard', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'AnalyticsReports', 'Reports', 'Analytics', 'CAMDashboard',
        'Notifications', 'Documents'
      ]) THEN 'read'
    WHEN role_key IN ('auditor', 'compliance_officer', 'internal_auditor')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'AuditLog', 'Expenses', 'Billing',
        'ChartOfAccounts', 'BudgetDashboard', 'BudgetReview', 'Revenue',
        'ActualsVariance', 'Actuals', 'Variance', 'Comparison', 'Reconciliation',
        'AnalyticsReports', 'Reports', 'Analytics', 'CAMDashboard', 'Documents',
        'Notifications'
      ]) THEN 'read'
    ELSE 'none'
  END
  FROM normalized;
$$ LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.membership_page_access(check_org_id UUID, page_name TEXT)
RETURNS TEXT AS $$
  WITH active_membership AS (
    SELECT m.*
    FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.org_id = check_org_id
      AND COALESCE(m.status, 'active') IN ('active', 'owner')
    ORDER BY
      CASE m.role
        WHEN 'org_admin' THEN 0
        WHEN 'manager' THEN 1
        WHEN 'editor' THEN 2
        WHEN 'viewer' THEN 3
        ELSE 4
      END,
      m.created_at NULLS LAST
    LIMIT 1
  ),
  normalized AS (
    SELECT
      m.role,
      COALESCE(m.module_permissions, '{}'::jsonb) AS module_permissions,
      COALESCE(m.page_permissions, '{}'::jsonb) AS page_permissions,
      COALESCE(o.enabled_modules, ARRAY[]::TEXT[]) AS enabled_modules
    FROM active_membership m
    JOIN public.organizations o
      ON o.id = m.org_id
  ),
  module_gate AS (
    SELECT CASE
      WHEN public.is_super_admin() THEN 'admin'
      WHEN NOT EXISTS (SELECT 1 FROM normalized) THEN 'none'
      WHEN public.page_module_key(page_name) IS NULL THEN 'admin'
      WHEN EXISTS (
        SELECT 1
        FROM normalized
        WHERE COALESCE(array_length(enabled_modules, 1), 0) > 0
          AND NOT (public.page_module_key(page_name) = ANY (enabled_modules))
      ) THEN 'none'
      WHEN EXISTS (
        SELECT 1
        FROM normalized
        WHERE module_permissions <> '{}'::jsonb
      ) THEN (
        SELECT public.normalize_page_access_level(module_permissions ->> public.page_module_key(page_name))
        FROM normalized
        LIMIT 1
      )
      ELSE 'admin'
    END AS level
  ),
  page_gate AS (
    SELECT
      CASE
        WHEN EXISTS (
          SELECT 1
          FROM normalized
          WHERE page_permissions <> '{}'::jsonb
        ) THEN (
          SELECT public.normalize_page_access_level(page_permissions ->> page_name)
          FROM normalized
          LIMIT 1
        )
        ELSE NULL
      END AS explicit_level,
      COALESCE(
        (
          SELECT public.role_default_page_access(role, page_name)
          FROM normalized
          LIMIT 1
        ),
        'none'
      ) AS role_level
  )
  SELECT CASE
    WHEN public.is_super_admin() THEN 'admin'
    WHEN (SELECT level FROM module_gate) = 'none' THEN 'none'
    WHEN (SELECT explicit_level FROM page_gate) IS NOT NULL THEN
      CASE
        WHEN (SELECT explicit_level FROM page_gate) = 'none' THEN 'none'
        ELSE public.min_page_access_level((SELECT explicit_level FROM page_gate), (SELECT level FROM module_gate))
      END
    WHEN (SELECT role_level FROM page_gate) = 'none' THEN 'none'
    ELSE public.min_page_access_level((SELECT role_level FROM page_gate), (SELECT level FROM module_gate))
  END;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

CREATE OR REPLACE FUNCTION public.can_write_any_page(check_org_id UUID, page_names TEXT[])
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM unnest(COALESCE(page_names, ARRAY[]::TEXT[])) AS page_name
    WHERE public.can_write_page(check_org_id, page_name)
  );
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

DROP POLICY IF EXISTS "leases_insert" ON public.leases;
CREATE POLICY "leases_insert" ON public.leases
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "leases_update" ON public.leases;
CREATE POLICY "leases_update" ON public.leases
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "leases_delete" ON public.leases;
CREATE POLICY "leases_delete" ON public.leases
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Leases', 'LeaseUpload', 'LeaseReview'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "expenses_insert" ON public.expenses;
CREATE POLICY "expenses_insert" ON public.expenses
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "expenses_update" ON public.expenses;
CREATE POLICY "expenses_update" ON public.expenses
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "expenses_delete" ON public.expenses;
CREATE POLICY "expenses_delete" ON public.expenses
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['Expenses', 'AddExpense', 'BulkImport'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "budgets_insert" ON public.budgets;
CREATE POLICY "budgets_insert" ON public.budgets
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['BudgetDashboard', 'CreateBudget'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "budgets_update" ON public.budgets;
CREATE POLICY "budgets_update" ON public.budgets
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['BudgetDashboard', 'CreateBudget'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['BudgetDashboard', 'CreateBudget'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "budgets_delete" ON public.budgets;
CREATE POLICY "budgets_delete" ON public.budgets
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['BudgetDashboard', 'CreateBudget'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "cam_calculations_insert" ON public.cam_calculations;
CREATE POLICY "cam_calculations_insert" ON public.cam_calculations
  FOR INSERT WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['CAMCalculation', 'CAMDashboard'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "cam_calculations_update" ON public.cam_calculations;
CREATE POLICY "cam_calculations_update" ON public.cam_calculations
  FOR UPDATE USING (
    public.can_write_any_page(org_id, ARRAY['CAMCalculation', 'CAMDashboard'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  )
  WITH CHECK (
    public.can_write_any_page(org_id, ARRAY['CAMCalculation', 'CAMDashboard'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

DROP POLICY IF EXISTS "cam_calculations_delete" ON public.cam_calculations;
CREATE POLICY "cam_calculations_delete" ON public.cam_calculations
  FOR DELETE USING (
    public.can_write_any_page(org_id, ARRAY['CAMCalculation', 'CAMDashboard'])
    AND (property_id IS NULL OR public.can_access_property(property_id))
  );

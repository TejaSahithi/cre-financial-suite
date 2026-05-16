-- Keep backend page/module permission helpers aligned with the frontend nav
-- and module configuration for newly surfaced pages.

CREATE OR REPLACE FUNCTION public.page_module_key(page_name TEXT)
RETURNS TEXT AS $$
  SELECT CASE
    WHEN page_name = ANY (ARRAY['Dashboard']) THEN 'dashboard'
    WHEN page_name = ANY (ARRAY['Portfolios']) THEN 'portfolio'
    WHEN page_name = ANY (ARRAY['Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail']) THEN 'properties'
    WHEN page_name = ANY (ARRAY['Tenants', 'TenantDetail']) THEN 'tenants'
    WHEN page_name = ANY (ARRAY['Vendors']) THEN 'vendors'
    WHEN page_name = ANY (ARRAY['Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates']) THEN 'leases'
    WHEN page_name = ANY (ARRAY['Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules']) THEN 'expenses'
    WHEN page_name = ANY (ARRAY['CAMDashboard', 'CAMSetup', 'CAMCalculation']) THEN 'cam'
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
    WHEN page_name = ANY (ARRAY['SuperAdmin', 'Stakeholders', 'OrgSettings', 'ChartOfAccounts', 'AuditLog', 'UserManagement', 'FieldMappingRules', 'ApprovalWorkflows']) THEN 'admin'
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
        'Tenants', 'TenantDetail', 'Vendors', 'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'Billing',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview', 'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key = 'property_manager'
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors', 'Leases', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'Billing',
        'Documents', 'Notifications'
      ]) THEN 'write'
    WHEN role_key IN ('editor', 'financial_analyst', 'leasing_agent', 'lease_admin', 'finance', 'cfo_controller', 'accounts_manager')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseUpload', 'LeaseReview', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Billing', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance', 'Comparison',
        'Reconciliation', 'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'ChartOfAccounts',
        'Vendors', 'Notifications', 'Documents'
      ]) THEN 'write'
    WHEN role_key IN ('viewer', 'read_only', 'investor_relations')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Leases', 'LeaseReview', 'CriticalDates',
        'Expenses', 'Billing', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'AnalyticsReports', 'Reports', 'Analytics', 'CAMDashboard', 'CAMSetup',
        'Notifications', 'Documents'
      ]) THEN 'read'
    WHEN role_key IN ('auditor', 'compliance_officer', 'internal_auditor')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights', 'AuditLog', 'Expenses', 'Billing',
        'ChartOfAccounts', 'BudgetDashboard', 'BudgetReview', 'Revenue',
        'ActualsVariance', 'Actuals', 'Variance', 'Comparison', 'Reconciliation',
        'AnalyticsReports', 'Reports', 'Analytics', 'CAMDashboard', 'CAMSetup', 'Documents',
        'Notifications', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules'
      ]) THEN 'read'
    ELSE 'none'
  END
  FROM normalized;
$$ LANGUAGE sql IMMUTABLE;

-- Canonical CRE roles only.
--
-- Active roles:
--   super_admin, org_owner, org_admin, portfolio_manager, property_manager,
--   lease_admin, leasing_agent, finance, property_owner, auditor, tenant,
--   custom_role.
--
-- Deferred roles should be implemented later as organization custom roles.

CREATE OR REPLACE FUNCTION public.cre_normalize_role(p_role text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE lower(COALESCE(p_role, ''))
    WHEN 'super_admin' THEN 'super_admin'
    WHEN 'owner' THEN 'org_owner'
    WHEN 'org_owner' THEN 'org_owner'
    WHEN 'admin' THEN 'org_admin'
    WHEN 'org_admin' THEN 'org_admin'
    WHEN 'portfolio_manager' THEN 'portfolio_manager'
    WHEN 'property_manager' THEN 'property_manager'
    WHEN 'lease_admin' THEN 'lease_admin'
    WHEN 'leasing_agent' THEN 'leasing_agent'
    WHEN 'finance' THEN 'finance'
    WHEN 'property_owner' THEN 'property_owner'
    WHEN 'auditor' THEN 'auditor'
    WHEN 'tenant' THEN 'tenant'
    WHEN 'custom' THEN 'custom_role'
    WHEN 'custom_role' THEN 'custom_role'
    ELSE NULL
  END;
$$;

WITH canonical_from_capabilities AS (
  SELECT
    m.id,
    (
      SELECT public.cre_normalize_role(role_name)
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(COALESCE(m.capabilities, '{}'::jsonb)->'roles') = 'array'
            THEN COALESCE(m.capabilities, '{}'::jsonb)->'roles'
          ELSE '[]'::jsonb
        END
      ) AS capability_roles(role_name)
      WHERE public.cre_normalize_role(role_name) IS NOT NULL
      ORDER BY CASE public.cre_normalize_role(role_name)
        WHEN 'super_admin' THEN 0
        WHEN 'org_owner' THEN 1
        WHEN 'org_admin' THEN 2
        WHEN 'portfolio_manager' THEN 3
        WHEN 'property_manager' THEN 4
        WHEN 'lease_admin' THEN 5
        WHEN 'leasing_agent' THEN 6
        WHEN 'finance' THEN 7
        WHEN 'property_owner' THEN 8
        WHEN 'auditor' THEN 9
        WHEN 'tenant' THEN 10
        WHEN 'custom_role' THEN 11
        ELSE 99
      END
      LIMIT 1
    ) AS canonical_role
  FROM public.memberships m
),
legacy_fallback AS (
  SELECT
    m.id,
    CASE lower(COALESCE(m.role, ''))
      WHEN 'manager' THEN 'property_manager'
      WHEN 'editor' THEN 'lease_admin'
      WHEN 'viewer' THEN 'auditor'
      WHEN 'read_only' THEN 'auditor'
      WHEN 'asset_manager' THEN 'portfolio_manager'
      WHEN 'operations_director' THEN 'portfolio_manager'
      WHEN 'facility_manager' THEN 'property_manager'
      WHEN 'construction_manager' THEN 'property_manager'
      WHEN 'cfo_controller' THEN 'finance'
      WHEN 'financial_analyst' THEN 'finance'
      WHEN 'accounts_manager' THEN 'finance'
      WHEN 'leasing_director' THEN 'lease_admin'
      WHEN 'compliance_officer' THEN 'auditor'
      WHEN 'internal_auditor' THEN 'auditor'
      WHEN 'acquisitions_mgr' THEN 'custom_role'
      ELSE public.cre_normalize_role(m.role)
    END AS canonical_role
  FROM public.memberships m
)
UPDATE public.memberships m
SET role = COALESCE(c.canonical_role, l.canonical_role, 'custom_role'),
    capabilities = jsonb_set(
      COALESCE(m.capabilities, '{}'::jsonb),
      '{roles}',
      to_jsonb(ARRAY[COALESCE(c.canonical_role, l.canonical_role, 'custom_role')]),
      true
    ),
    updated_at = now()
FROM canonical_from_capabilities c
JOIN legacy_fallback l ON l.id = c.id
WHERE m.id = c.id
  AND (
    public.cre_normalize_role(m.role) IS NULL
    OR COALESCE(m.capabilities->'roles', '[]'::jsonb) <> to_jsonb(ARRAY[COALESCE(c.canonical_role, l.canonical_role, 'custom_role')])
  );

UPDATE public.memberships m
SET status = 'active',
    updated_at = now()
WHERE m.status = 'invited'
  AND (
    EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = m.user_id
        AND (
          p.status IN ('active', 'approved')
          OR COALESCE(p.onboarding_complete, false)
          OR COALESCE(p.first_login, true) = false
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.profiles p
      JOIN public.invitations i
        ON lower(i.email) = lower(p.email)
       AND i.org_id = m.org_id
      WHERE p.id = m.user_id
        AND i.status = 'accepted'
    )
  );

CREATE OR REPLACE FUNCTION public.role_default_page_access(role_name text, page_name text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  WITH normalized AS (
    SELECT public.cre_normalize_role(role_name) AS role_key
  )
  SELECT CASE
    WHEN role_key IN ('super_admin', 'org_owner', 'org_admin') THEN 'admin'
    WHEN role_key = 'portfolio_manager'
      AND page_name = ANY (ARRAY[
        'Dashboard', 'Portfolios', 'PortfolioOverview', 'PortfolioInsights',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors',
        'Leases', 'LeaseDetail', 'LeaseRentSchedule', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'Billing', 'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Documents', 'Workflows', 'Approvals', 'Notifications'
      ]) THEN 'write'
    WHEN role_key = 'property_manager'
      AND page_name = ANY (ARRAY[
        'Dashboard',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail', 'Vendors',
        'Leases', 'LeaseDetail', 'LeaseRentSchedule', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'Billing', 'Documents', 'Workflows', 'Approvals', 'Notifications'
      ]) THEN 'write'
    WHEN role_key IN ('lease_admin', 'leasing_agent')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail',
        'Leases', 'LeaseDetail', 'LeaseRentSchedule', 'LeaseUpload', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Billing', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'Reconciliation',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'Vendors', 'Workflows', 'Approvals', 'Notifications', 'Documents'
      ]) THEN 'write'
    WHEN role_key = 'finance'
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights',
        'Expenses', 'AddExpense', 'BulkImport', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'CreateBudget', 'BudgetReview',
        'Billing', 'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'Reconciliation',
        'CAMDashboard', 'CAMSetup', 'CAMCalculation', 'CAMRun',
        'AnalyticsReports', 'Reports', 'Analytics',
        'ChartOfAccounts', 'Vendors', 'Workflows', 'Approvals', 'Notifications', 'Documents'
      ]) THEN 'write'
    WHEN role_key IN ('property_owner', 'auditor')
      AND page_name = ANY (ARRAY[
        'Dashboard', 'PortfolioInsights',
        'Properties', 'Buildings', 'Units', 'BuildingsUnits', 'PropertyDetail',
        'Tenants', 'TenantDetail',
        'Leases', 'LeaseDetail', 'LeaseRentSchedule', 'LeaseReview', 'RentProjection', 'CriticalDates',
        'Expenses', 'Billing', 'ExpenseProjection', 'LeaseExpenseClassification', 'ExpenseReview', 'LeaseExpenseRules',
        'BudgetDashboard', 'BudgetReview',
        'Revenue', 'ActualsVariance', 'Actuals', 'Variance',
        'Comparison', 'Reconciliation',
        'AnalyticsReports', 'Reports', 'Analytics',
        'CAMDashboard', 'CAMSetup', 'CAMRun',
        'AuditLog', 'Documents', 'Workflows', 'Approvals', 'Notifications'
      ]) THEN 'read'
    ELSE 'none'
  END
  FROM normalized;
$$;

CREATE OR REPLACE FUNCTION public.membership_page_access(check_org_id uuid, page_name text)
RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH active_membership AS (
    SELECT m.*
    FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.org_id = check_org_id
      AND COALESCE(m.status, 'active') IN ('active', 'owner', 'approved', 'accepted')
    ORDER BY
      CASE public.cre_normalize_role(m.role)
        WHEN 'super_admin' THEN 0
        WHEN 'org_owner' THEN 1
        WHEN 'org_admin' THEN 2
        WHEN 'portfolio_manager' THEN 3
        WHEN 'property_manager' THEN 4
        WHEN 'lease_admin' THEN 5
        WHEN 'leasing_agent' THEN 6
        WHEN 'finance' THEN 7
        WHEN 'property_owner' THEN 8
        WHEN 'auditor' THEN 9
        WHEN 'tenant' THEN 10
        WHEN 'custom_role' THEN 11
        ELSE 99
      END
    LIMIT 1
  )
  SELECT CASE
    WHEN public.is_super_admin() THEN 'admin'
    WHEN EXISTS (
      SELECT 1 FROM active_membership m
      WHERE public.cre_normalize_role(m.role) IN ('org_owner', 'org_admin')
    ) THEN 'admin'
    WHEN EXISTS (
      SELECT 1 FROM active_membership m
      WHERE COALESCE(m.page_permissions, '{}'::jsonb) ? page_name
        AND public.access_level_rank(public.normalize_page_access_level(m.page_permissions->>page_name)) > 0
    ) THEN (
      SELECT public.normalize_page_access_level(m.page_permissions->>page_name)
      FROM active_membership m
      LIMIT 1
    )
    WHEN EXISTS (SELECT 1 FROM active_membership m) THEN (
      SELECT public.role_default_page_access(m.role, page_name)
      FROM active_membership m
      LIMIT 1
    )
    ELSE 'none'
  END;
$$;

CREATE OR REPLACE FUNCTION public.can_read_page(check_org_id uuid, page_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 1;
$$;

CREATE OR REPLACE FUNCTION public.can_write_page(check_org_id uuid, page_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.access_level_rank(public.membership_page_access(check_org_id, page_name)) >= 2;
$$;

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
        AND public.cre_normalize_role(m.role) IN ('org_owner', 'org_admin', 'super_admin')
        AND COALESCE(m.status, 'active') IN ('active', 'owner', 'approved', 'accepted')
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
        AND COALESCE(m.status, 'active') IN ('active', 'owner', 'approved', 'accepted')
        AND public.cre_normalize_role(m.role) IN (
          'portfolio_manager', 'property_manager', 'lease_admin',
          'leasing_agent', 'finance', 'custom_role'
        )
    );
$$;

CREATE OR REPLACE FUNCTION public.has_unrestricted_property_scope(check_org_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      WHERE m.user_id = auth.uid()
        AND m.org_id = check_org_id
        AND COALESCE(m.status, 'active') IN ('active', 'owner', 'approved', 'accepted')
        AND (
          public.cre_normalize_role(m.role) IN ('org_owner', 'org_admin')
          OR COALESCE((m.capabilities->'scope_access'->>'all_portfolios')::boolean, false)
          OR COALESCE((m.capabilities->'scope_access'->>'all_properties')::boolean, false)
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

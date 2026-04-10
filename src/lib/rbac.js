// Centralized RBAC configuration
// Maps each role to the pages they can access.
// "admin" (SuperAdmin) can access ALL pages — not listed here, handled in code.
//
// Roles stored in `memberships.role`:
//   super_admin → mapped to "admin" in auth.js for legacy compat
//   org_admin   → full org control
//   manager     → manage properties and leases
//   editor      → modify data
//   viewer      → read-only
//
// Legacy compatibility: property_manager, finance, read_only, auditor are also supported.

const ROLE_PAGES = {
  org_admin: [
    "Dashboard", "Portfolios", "PortfolioInsights",
    "Properties", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors", "VendorProfile",
    "Leases", "LeaseUpload", "LeaseReview", "RentProjection",
    "Expenses", "AddExpense", "BulkImport", "ExpenseProjection",
    "CAMDashboard", "CAMCalculation",
    "Billing", "Revenue",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "AnalyticsReports", "Reports", "Analytics",
    "Workflows", "Notifications", "Documents",
    "Integrations",
    "OrgSettings", "ChartOfAccounts",
    "UserManagement", "AuditLog",
  ],
  manager: [
    "Dashboard",
    "Properties", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors", "VendorProfile",
    "Leases", "LeaseUpload", "LeaseReview", "RentProjection",
    "Expenses", "AddExpense", "BulkImport",
    "CAMDashboard", "CAMCalculation",
    "Billing",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Documents", "Notifications",
  ],
  // Legacy alias
  property_manager: [
    "Dashboard",
    "Properties", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors",
    "Leases", "LeaseUpload", "LeaseReview", "RentProjection",
    "Expenses", "AddExpense", "BulkImport",
    "CAMDashboard", "CAMCalculation",
    "Billing",
    "Documents", "Notifications",
  ],
  editor: [
    "Dashboard", "PortfolioInsights",
    "Properties", "PropertyDetail",
    "Tenants", "TenantDetail",
    "Leases", "LeaseUpload", "LeaseReview",
    "Expenses", "AddExpense", "BulkImport", "ExpenseProjection",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Billing", "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "CAMDashboard", "CAMCalculation",
    "ChartOfAccounts", "Vendors",
    "Notifications", "Documents",
  ],
  // Legacy alias
  finance: [
    "Dashboard", "PortfolioInsights",
    "Expenses", "AddExpense", "BulkImport", "ExpenseProjection",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Billing", "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "CAMDashboard", "CAMCalculation",
    "AnalyticsReports", "Reports", "Analytics",
    "ChartOfAccounts", "Vendors",
    "Notifications", "Documents",
  ],
  viewer: [
    "Dashboard", "PortfolioInsights",
    "Properties", "PropertyDetail",
    "Tenants", "TenantDetail",
    "Leases", "LeaseReview",
    "Expenses", "Billing",
    "BudgetDashboard",
    "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "AnalyticsReports", "Reports", "Analytics",
    "CAMDashboard",
    "Notifications", "Documents",
  ],
  // Legacy alias
  read_only: [
    "Dashboard", "PortfolioInsights",
    "Properties", "PropertyDetail",
    "Tenants", "TenantDetail",
    "Leases", "LeaseReview",
    "Expenses", "Billing",
    "BudgetDashboard",
    "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "AnalyticsReports", "Reports", "Analytics",
    "CAMDashboard",
    "Notifications", "Documents",
  ],
  auditor: [
    "Dashboard", "PortfolioInsights",
    "AuditLog",
    "Expenses", "Billing", "ChartOfAccounts",
    "BudgetDashboard", "BudgetReview",
    "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "AnalyticsReports", "Reports", "Analytics",
    "CAMDashboard",
    "Documents", "Notifications",
  ],
};

const ROLE_ALIASES = {
  asset_manager: "manager",
  portfolio_manager: "manager",
  operations_director: "manager",
  facility_manager: "manager",
  construction_manager: "manager",
  acquisitions_mgr: "manager",
  cfo_controller: "finance",
  accounts_manager: "finance",
  financial_analyst: "editor",
  investor_relations: "viewer",
  leasing_director: "manager",
  leasing_agent: "editor",
  lease_admin: "editor",
  compliance_officer: "auditor",
  internal_auditor: "auditor",
};

// Pages that don't require auth / are public
const PUBLIC_PAGES = ["Landing", "Pricing", "ContactUs", "PendingApproval", "RequestAccess", "RequestDemo", "Login", "DemoExperience", "AcceptInvite", "AwaitingRole"];

// Mandatory setup pages (require auth but accessible to all roles)
const MANDATORY_SETUP_PAGES = ["Onboarding", "Welcome", "WelcomeAboard", "PaymentSuccess"];

// SuperAdmin-only pages
const ADMIN_ONLY_PAGES = ["SuperAdmin", "Stakeholders"];

export function resolveRoleForAccess(role) {
  if (!role) return role;
  return ROLE_ALIASES[role] || role;
}

export function getAllowedPagesForRole(role) {
  const resolvedRole = resolveRoleForAccess(role);
  return ROLE_PAGES[resolvedRole] || [];
}

/**
 * Check if a user role can access a given page.
 * @param {string} role - user role
 * @param {string} pageName - the page key
 * @returns {boolean}
 */
export function canAccess(role, pageName) {
  const resolvedRole = resolveRoleForAccess(role);
  if (!pageName) return true;
  if (PUBLIC_PAGES.includes(pageName)) return true;
  if (MANDATORY_SETUP_PAGES.includes(pageName)) return true;
  // SuperAdmin sees everything — support both mapped 'admin' and raw 'super_admin'
  if (resolvedRole === "admin" || resolvedRole === "super_admin") return true;
  if (ADMIN_ONLY_PAGES.includes(pageName)) return false;
  const allowedPages = ROLE_PAGES[resolvedRole];
  if (!allowedPages) return false; // Unknown role — deny access
  return allowedPages.includes(pageName);
}

/**
 * Get granular permissions for a role.
 * @param {string} role
 * @returns {{ canRead: boolean, canWrite: boolean, canManage: boolean, canAdmin: boolean }}
 */
export function getPermissions(role) {
  const resolvedRole = resolveRoleForAccess(role);
  return {
    canRead: true, // all roles can read
    canWrite: ['admin', 'super_admin', 'org_admin', 'manager', 'editor', 'finance', 'property_manager'].includes(resolvedRole),
    canManage: ['admin', 'super_admin', 'org_admin', 'manager', 'property_manager'].includes(resolvedRole),
    canAdmin: ['admin', 'super_admin', 'org_admin'].includes(resolvedRole),
  };
}

/**
 * Filter nav sections based on role.
 * Returns a new array with only accessible items.
 */
export function filterNavForRole(navSections, role) {
  if (!role) return [];
  const resolvedRole = resolveRoleForAccess(role);
  // SuperAdmin sees all nav items
  const isSuperAdmin = resolvedRole === "admin" || resolvedRole === "super_admin";
  
  const allowed = ROLE_PAGES[resolvedRole];
  const allowedSet = new Set(allowed || []);
  
  return navSections
    .map(item => {
      // If it's a top-level page, check access
      if (item.page) {
        if (ADMIN_ONLY_PAGES.includes(item.page) && !isSuperAdmin) return null;
        if (!isSuperAdmin && !allowedSet.has(item.page)) return null;
      }
      
      if (item.children) {
        const filteredChildren = item.children.filter(c => {
          if (ADMIN_ONLY_PAGES.includes(c.page) && !isSuperAdmin) return false;
          if (isSuperAdmin) return true;
          return allowedSet.has(c.page);
        });
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }
      
      return item;
    })
    .filter(Boolean);
}

export function filterNavForAllowedPages(navSections, allowedPages) {
  const allowedSet = new Set(allowedPages || []);
  return navSections
    .map((item) => {
      if (item.page) {
        return allowedSet.has(item.page) ? item : null;
      }

      if (item.children) {
        const filteredChildren = item.children.filter((child) => allowedSet.has(child.page));
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }

      return item;
    })
    .filter(Boolean);
}

export { PUBLIC_PAGES, ADMIN_ONLY_PAGES, ROLE_PAGES, ROLE_ALIASES, MANDATORY_SETUP_PAGES };

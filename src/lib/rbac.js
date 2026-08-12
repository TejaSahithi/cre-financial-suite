// Centralized RBAC configuration.
// Active roles are intentionally limited to:
// super_admin, org_owner, org_admin, portfolio_manager, property_manager,
// lease_admin, leasing_agent, finance, property_owner, auditor, tenant,
// custom_role.

const ROLE_PAGES = {
  org_admin: [
    "Dashboard", "Portfolios", "PortfolioInsights",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors", "VendorProfile",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseUpload", "LeaseReview", "RentProjection", "CriticalDates",
    "Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "Billing", "Revenue",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "AnalyticsReports", "Reports", "Analytics",
    "Workflows", "Approvals", "Notifications", "Documents",
    "Integrations",
    "OrgSettings", "ChartOfAccounts", "FieldMappingRules", "ApprovalWorkflows", "ApprovalPolicies",
    "UserManagement", "AuditLog",
  ],
  org_owner: [
    "Dashboard", "Portfolios", "PortfolioInsights",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors", "VendorProfile",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseUpload", "LeaseReview", "RentProjection", "CriticalDates",
    "Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "Billing", "Revenue",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "AnalyticsReports", "Reports", "Analytics",
    "Workflows", "Approvals", "Notifications", "Documents",
    "Integrations",
    "OrgSettings", "ChartOfAccounts", "FieldMappingRules", "ApprovalWorkflows", "ApprovalPolicies",
    "UserManagement", "AuditLog",
  ],
  portfolio_manager: [
    "Dashboard",
    "Portfolios", "PortfolioInsights",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors", "VendorProfile",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseUpload", "LeaseReview", "RentProjection", "CriticalDates",
    "Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "Billing",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Documents", "Workflows", "Approvals", "Notifications",
  ],
  property_manager: [
    "Dashboard",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail", "Vendors",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseUpload", "LeaseReview", "RentProjection", "CriticalDates",
    "Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "Billing",
    "Documents", "Workflows", "Approvals", "Notifications",
  ],
  lease_admin: [
    "Dashboard", "PortfolioInsights",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseUpload", "LeaseReview", "CriticalDates",
    "Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Billing", "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "ChartOfAccounts", "Vendors",
    "Workflows", "Approvals", "Notifications", "Documents",
  ],
  leasing_agent: [
    "Dashboard", "PortfolioInsights",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseUpload", "LeaseReview", "CriticalDates",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Billing", "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "Vendors",
    "Workflows", "Approvals", "Notifications", "Documents",
  ],
  finance: [
    "Dashboard", "PortfolioInsights",
    "Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "BudgetDashboard", "CreateBudget", "BudgetReview",
    "Billing", "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "CAMDashboard", "CAMSetup", "CAMRun", "CAMPoolDetail", "CAMLeaseDetail", "CAMExceptionReview", "CAMApproval", "BudgetReadiness",
    "AnalyticsReports", "Reports", "Analytics",
    "ChartOfAccounts", "Vendors",
    "Workflows", "Approvals", "Notifications", "Documents",
  ],
  property_owner: [
    "Dashboard", "PortfolioInsights",
    "Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail",
    "Tenants", "TenantDetail",
    "Leases", "LeaseDetail", "LeaseRentSchedule", "LeaseReview", "CriticalDates",
    "Expenses", "Billing", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "BudgetDashboard",
    "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "AnalyticsReports", "Reports", "Analytics",
    "CAMDashboard", "CAMSetup", "CAMRun", "BudgetReadiness",
    "Workflows", "Approvals", "Notifications", "Documents",
  ],
  auditor: [
    "Dashboard", "PortfolioInsights",
    "AuditLog",
    "Expenses", "Billing", "ChartOfAccounts", "LeaseExpenseRules", "ExpenseProjection", "LeaseExpenseClassification", "ExpenseReview",
    "BudgetDashboard", "BudgetReview",
    "Revenue", "ActualsVariance", "Actuals", "Variance", "Comparison",
    "Reconciliation",
    "AnalyticsReports", "Reports", "Analytics",
    "CAMDashboard", "CAMSetup", "CAMRun", "BudgetReadiness",
    "Documents", "Workflows", "Approvals", "Notifications",
  ],
};

const ROLE_ALIASES = {
  owner: "org_owner",
  organization_owner: "org_owner",
  organization_admin: "org_admin",
  admin: "org_admin",
  custom: "custom_role",
};

ROLE_PAGES.tenant = [];
ROLE_PAGES.custom_role = ROLE_PAGES.auditor;

// Pages that don't require auth / are public
const PUBLIC_PAGES = ["Landing", "Pricing", "ContactUs", "RequestAccess", "RequestDemo", "Login", "DemoExperience", "AcceptInvite", "ResetPassword"];

// Mandatory setup pages (require auth but accessible to all roles)
const MANDATORY_SETUP_PAGES = ["Onboarding", "Welcome", "WelcomeAboard", "PaymentSuccess", "PendingApproval", "AwaitingRole", "SecurityQuestionsSetup"];

// Pages that bypass MFA when authenticated
const MFA_BYPASS_PAGES = ["AcceptInvite", "PendingApproval", "ResetPassword", "SecurityQuestionsSetup"];

// Pages exempt from the main authenticated layout
const LAYOUT_EXEMPT_PAGES = [...PUBLIC_PAGES, ...MANDATORY_SETUP_PAGES];

// SuperAdmin-only pages
const ADMIN_ONLY_PAGES = ["SuperAdmin", "Stakeholders", "CAMRealPropertyGate"];

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
export function canAccess(role, pageName, user = null) {
  if (isSuperAdmin(user)) return true;
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
  if (!resolvedRole) {
    return { canRead: false, canWrite: false, canManage: false, canAdmin: false };
  }
  return {
    canRead: true, // all roles can read
    canWrite: ['admin', 'super_admin', 'org_owner', 'org_admin', 'portfolio_manager', 'property_manager', 'lease_admin', 'leasing_agent', 'finance', 'custom_role'].includes(resolvedRole),
    canManage: ['admin', 'super_admin', 'org_owner', 'org_admin', 'portfolio_manager', 'property_manager'].includes(resolvedRole),
    canAdmin: ['admin', 'super_admin', 'org_owner', 'org_admin'].includes(resolvedRole),
  };
}

/**
 * Filter nav sections based on role.
 * Returns a new array with only accessible items.
 */
export function filterNavForRole(navSections, role, user = null) {
  const isSuper = isSuperAdmin(user) || role === "super_admin" || role === "admin";
  if (!role && !isSuper) return [];
  const resolvedRole = resolveRoleForAccess(role);
  
  const allowed = ROLE_PAGES[resolvedRole];
  const allowedSet = new Set(allowed || []);
  
  return navSections
    .map(item => {
      // If it's a top-level page, check access
      if (item.page) {
        if (ADMIN_ONLY_PAGES.includes(item.page) && !isSuper) return null;
        if (!isSuper && !allowedSet.has(item.page)) return null;
      }
      
      if (item.children) {
        const filteredChildren = item.children.filter(c => {
          if (ADMIN_ONLY_PAGES.includes(c.page) && !isSuper) return false;
          if (isSuper) return true;
          return allowedSet.has(c.page);
        });
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }
      
      return item;
    })
    .filter(Boolean);
}

export function filterNavForAllowedPages(navSections, allowedPages, user = null) {
  const allowedSet = new Set(allowedPages || []);
  const isSuper = isSuperAdmin(user);
  return navSections
    .map((item) => {
      if (item.page) {
        if (ADMIN_ONLY_PAGES.includes(item.page) && !isSuper) return null;
        return (allowedSet.has(item.page) || isSuper) ? item : null;
      }

      if (item.children) {
        const filteredChildren = item.children.filter((child) => {
          if (ADMIN_ONLY_PAGES.includes(child.page)) return isSuper;
          return allowedSet.has(child.page) || isSuper;
        });
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }

      return item;
    })
    .filter(Boolean);
}

export function isSuperAdmin(user) {
  return (
    user?._raw_role === "super_admin" ||
    user?.memberships?.some((membership) => membership?.role === "super_admin")
  );
}

export function canAccessPlatformData(user) {
  return isSuperAdmin(user);
}

export function getActiveOrgId(user) {
  return (
    user?.activeOrg?.id ||
    user?.org_id ||
    user?.memberships?.[0]?.org_id ||
    null
  );
}

export function getDataScope(user, options = {}) {
  const explicitOrgId = options.currentOrgId || null;
  const isSuperAdminUser = isSuperAdmin(user);

  if (isSuperAdminUser) {
    if (explicitOrgId) {
      return { scope: "org", orgId: explicitOrgId };
    }
    return { scope: "platform", orgId: null };
  }

  if (explicitOrgId) {
    const hasMembership = user?.memberships?.some(
      (m) =>
        m?.org_id === explicitOrgId &&
        (!m?.status || ["active", "owner", "approved", "accepted"].includes(m?.status))
    );
    if (hasMembership) {
      return { scope: "org", orgId: explicitOrgId };
    }
  }

  const activeOrgId = getActiveOrgId(user);
  if (activeOrgId) {
    return { scope: "org", orgId: activeOrgId };
  }

  if (user?.memberships?.length > 0) {
    const firstOrgId = user.memberships[0]?.org_id;
    if (firstOrgId) {
      return { scope: "org", orgId: firstOrgId };
    }
  }

  return { scope: "none", orgId: null };
}

export function getActiveMembership(user) {
  const activeOrgId = getActiveOrgId(user);
  if (!activeOrgId) return null;

  return (
    user?.memberships?.find(
      (membership) =>
        membership?.org_id === activeOrgId &&
        ["active", "owner", "approved", "accepted"].includes(membership?.status)
    ) || null
  );
}

export function getActiveRole(user) {
  if (isSuperAdmin(user)) return "super_admin";

  const activeMembership = getActiveMembership(user);
  return activeMembership?.role || user?._raw_role || user?.role || null;
}

export function isOrgAdmin(user) {
  const role = resolveRoleForAccess(getActiveRole(user));
  return role === "org_owner" || role === "org_admin" || role === "admin";
}

export { PUBLIC_PAGES, ADMIN_ONLY_PAGES, ROLE_PAGES, ROLE_ALIASES, MANDATORY_SETUP_PAGES, MFA_BYPASS_PAGES, LAYOUT_EXEMPT_PAGES };

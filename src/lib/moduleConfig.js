/**
 * Module configuration — defines which pages belong to each purchasable module.
 * Each module is a self-contained product that clients can subscribe to independently.
 * 
 * Cross-module links are conditionally shown based on which modules the org has enabled.
 * Admin users always see all modules.
 */

export const MODULE_DEFINITIONS = {
  dashboard:      { label: "Dashboard",         pages: ["Dashboard"] },
  portfolio:      { label: "Portfolio",          pages: ["Portfolios"] },
  properties:     { label: "Properties",         pages: ["Properties", "Buildings", "Units", "BuildingsUnits", "PropertyDetail"] },
  tenants:        { label: "Tenants",            pages: ["Tenants", "TenantDetail"] },
  vendors:        { label: "Vendors",            pages: ["Vendors"] },  // nested under expenses in nav
  leases:         { label: "Leases",             pages: ["Leases", "LeaseUpload", "LeaseReview", "RentProjection", "CriticalDates"] },
  expenses:       { label: "Expenses",           pages: ["Expenses", "AddExpense", "BulkImport", "LeaseExpenseRules", "LeaseExpenseClassification", "ExpenseReview", "ExpenseProjection"] },
  cam:            { label: "CAM Engine",         pages: ["CAMDashboard", "CAMSetup", "CAMCalculation"] },
  billing:        { label: "Billing",            pages: ["Billing"] },  // billing nested under tenants in nav
  revenue:        { label: "Revenue",            pages: ["Revenue"] },
  budgets:        { label: "Budget Studio",      pages: ["BudgetDashboard", "CreateBudget", "BudgetReview"] },
  actuals_variance: { label: "Actuals & Variance", pages: ["ActualsVariance", "Actuals", "Variance"] },
  comparison:     { label: "YoY Comparison",     pages: ["Comparison"] },
  reconciliation: { label: "Reconciliation",     pages: ["Reconciliation"] },
  analytics_reports: { label: "Analytics & Reports", pages: ["AnalyticsReports", "Reports", "Analytics", "PortfolioInsights"] },
  workflows:      { label: "Workflows",          pages: ["Workflows"] },
  notifications:  { label: "Notifications",      pages: ["Notifications"] },
  documents:      { label: "Documents",          pages: ["Documents"] },
  integrations:   { label: "Integrations",       pages: ["Integrations"] },
  admin:          { label: "Admin",              pages: ["SuperAdmin", "Stakeholders", "OrgSettings", "ChartOfAccounts", "FieldMappingRules", "ApprovalWorkflows", "AuditLog", "UserManagement"] },
};

// All module keys
export const ALL_MODULE_KEYS = Object.keys(MODULE_DEFINITIONS);

/**
 * Build a set of accessible pages from a list of enabled module keys.
 * Returns all pages if enabledModules is empty/null (backwards compat / admin).
 */
export function getEnabledPages(enabledModules) {
  if (!enabledModules || enabledModules.length === 0) {
    // No restriction — return all pages (admin / legacy orgs)
    return null; // null = no filtering
  }
  const pages = new Set();
  enabledModules.forEach(moduleKey => {
    const mod = MODULE_DEFINITIONS[moduleKey];
    if (mod) mod.pages.forEach(p => pages.add(p));
  });
  return pages;
}

/**
 * Check if a specific page is accessible given the org's enabled modules.
 */
export function isPageInEnabledModules(pageName, enabledModules) {
  const pages = getEnabledPages(enabledModules);
  if (pages === null) return true; // no restriction
  return pages.has(pageName);
}

/**
 * Get the module key that contains a given page.
 */
export function getModuleForPage(pageName) {
  for (const [key, mod] of Object.entries(MODULE_DEFINITIONS)) {
    if (mod.pages.includes(pageName)) return key;
  }
  return null;
}

/**
 * Filter nav sections based on enabled modules.
 */
export function filterNavForModules(navSections, enabledModules) {
  const pages = getEnabledPages(enabledModules);
  if (pages === null) return navSections; // no restriction
  return navSections
    .map(item => {
      if (item.children) {
        const filteredChildren = item.children.filter(c => pages.has(c.page));
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }
      return pages.has(item.page) ? item : null;
    })
    .filter(Boolean);
}

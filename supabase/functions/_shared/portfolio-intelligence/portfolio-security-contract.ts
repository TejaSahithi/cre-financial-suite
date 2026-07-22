// @ts-nocheck

export const PORTFOLIO_RLS_TABLES = [
  "portfolio_lease_facts",
  "portfolio_obligations",
  "portfolio_financial_terms",
  "portfolio_critical_dates",
  "portfolio_risk_findings",
  "portfolio_analytics_snapshots",
  "portfolio_metric_lineage",
  "portfolio_export_runs",
  "portfolio_finding_actions",
];

export const PORTFOLIO_ENDPOINTS_REQUIRING_ORG_SCOPE = [
  "portfolio-intelligence-v8-summary",
  "portfolio-intelligence-v8-critical-dates",
  "portfolio-intelligence-v8-search",
  "portfolio-intelligence-v8-rent-roll-reconciliation",
  "portfolio-intelligence-v8-export",
  "portfolio-intelligence-v8-refresh",
];

export const PORTFOLIO_SECURITY_REQUIREMENTS = {
  organizationMembership: "organization_id IN (SELECT public.get_my_org_ids())",
  portfolioAccess: "public.can_access_portfolio(portfolio_id)",
  rawEvidenceTextDefault: false,
  telemetryFieldsAllowed: ["counts", "status_categories", "durations", "failure_codes"],
};

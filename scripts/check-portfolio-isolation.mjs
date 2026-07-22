import fs from "node:fs";
const migration = fs.readFileSync("supabase/migrations/20260861000000_portfolio_intelligence_release8.sql", "utf8");
const endpoints = [
  "portfolio-intelligence-v8-summary",
  "portfolio-intelligence-v8-critical-dates",
  "portfolio-intelligence-v8-search",
  "portfolio-intelligence-v8-rent-roll-reconciliation",
  "portfolio-intelligence-v8-export",
  "portfolio-intelligence-v8-refresh"
];
const requiredTables = ["portfolio_lease_facts", "portfolio_obligations", "portfolio_financial_terms", "portfolio_critical_dates", "portfolio_risk_findings", "portfolio_analytics_snapshots", "portfolio_metric_lineage", "portfolio_export_runs", "portfolio_finding_actions"];
for (const table of requiredTables) {
  if (!migration.includes(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`)) throw new Error(`${table} missing RLS`);
  if (!migration.includes(`${table}_select`)) throw new Error(`${table} missing select policy`);
}
if (!migration.includes("public.can_access_portfolio(portfolio_id)")) throw new Error("portfolio access helper missing");
for (const endpoint of endpoints) {
  const file = `supabase/functions/${endpoint}/index.ts`;
  if (!fs.existsSync(file)) throw new Error(`${endpoint} missing`);
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes("verifyUser") || !text.includes("getUserOrgId")) throw new Error(`${endpoint} missing auth/org enforcement`);
}
console.log(`Release 8 portfolio isolation checks passed for ${requiredTables.length} tables and ${endpoints.length} endpoints.`);

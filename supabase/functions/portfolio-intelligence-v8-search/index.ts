// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isPortfolioSemanticSearchEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { planPortfolioQuery, applySearchPlan } from "../_shared/portfolio-intelligence/portfolio-query-planner.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isPortfolioSemanticSearchEnabled()) return jsonResponse({ error: true, message: "Portfolio semantic search is disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { plan, errors } = planPortfolioQuery(body);
    if (!plan) return jsonResponse({ error: true, errors }, 400);
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const table = plan.entity === "critical_date" ? "portfolio_critical_dates" : plan.entity === "obligation" ? "portfolio_obligations" : plan.entity === "finding" ? "portfolio_risk_findings" : plan.entity === "financial_term" ? "portfolio_financial_terms" : "portfolio_lease_facts";
    const { data, error } = await supabaseAdmin.from(table).select("*").eq("organization_id", orgId).limit(1000);
    if (error) throw new Error(error.message);
    const rows = (data ?? []).map((row: any) => row.fact_payload ? { ...row.fact_payload, id: row.id, tenant_name: row.tenant_name, expiration_date: row.expiration_date } : row);
    return jsonResponse({ schemaVersion: "portfolio-search-response-v1", plan, results: applySearchPlan(rows, plan), diagnostics: { rowsScanned: rows.length, persistedPlanText: JSON.stringify(plan) } });
  } catch (error: any) { console.error(`[portfolio-intelligence-v8-search] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Failed to search portfolio intelligence" }, 500); }
});

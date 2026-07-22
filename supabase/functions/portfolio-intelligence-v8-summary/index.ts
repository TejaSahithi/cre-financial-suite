// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isPortfolioIntelligenceV8Enabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildPortfolioAnalyticsSnapshot } from "../_shared/portfolio-intelligence/portfolio-analytics-snapshot.ts";
import { buildPortfolioIntelligencePayloadV1 } from "../_shared/portfolio-intelligence/portfolio-payload-v1.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
async function parseRequest(req: Request) { if (req.method === "GET") { const url = new URL(req.url); return { portfolioId: url.searchParams.get("portfolio_id") ?? url.searchParams.get("portfolioId"), propertyId: url.searchParams.get("property_id") ?? url.searchParams.get("propertyId") }; } return req.json().catch(() => ({})); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isPortfolioIntelligenceV8Enabled()) return jsonResponse({ error: true, message: "Portfolio intelligence v8 is disabled" }, 403);
    const parsed = await parseRequest(req);
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    let query = supabaseAdmin.from("portfolio_lease_facts").select("*").eq("organization_id", orgId).is("superseded_at", null).limit(1000);
    if (parsed.portfolioId) query = query.eq("portfolio_id", parsed.portfolioId);
    if (parsed.propertyId) query = query.eq("property_id", parsed.propertyId);
    const { data: facts, error } = await query;
    if (error) throw new Error(error.message);
    const snapshot = await buildPortfolioAnalyticsSnapshot({ organizationId: orgId, portfolioId: parsed.portfolioId ?? null, facts: (facts ?? []).map((row: any) => row.fact_payload ?? row), snapshotDate: new Date().toISOString().slice(0, 10) });
    return jsonResponse(buildPortfolioIntelligencePayloadV1({ organizationId: orgId, portfolioId: parsed.portfolioId ?? null, propertyId: parsed.propertyId ?? null, snapshot, diagnostics: { factsLoaded: facts?.length ?? 0 } }));
  } catch (error: any) { console.error(`[portfolio-intelligence-v8-summary] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Failed to build portfolio summary" }, 500); }
});

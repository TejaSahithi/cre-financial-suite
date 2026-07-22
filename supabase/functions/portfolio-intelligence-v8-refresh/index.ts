// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isPortfolioFactMaterializationEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { planPortfolioRefresh, refreshPortfolioFactInMemory } from "../_shared/portfolio-intelligence/portfolio-intelligence-refresh.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isPortfolioFactMaterializationEnabled()) return jsonResponse({ error: true, message: "Portfolio fact materialization is disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const plan = planPortfolioRefresh({ changeType: body.changeType ?? "manual_rebuild", organizationId: orgId, documentFamilyId: body.documentFamilyId ?? null, portfolioId: body.portfolioId ?? null, propertyId: body.propertyId ?? null, sourceGenerationId: body.generationId ?? null });
    if (!body.documentFamilyId || !body.generationId) return jsonResponse({ schemaVersion: "portfolio-refresh-response-v1", plan, diagnostics: { persisted: false, reason: "portfolio_scope_refresh_planned_only" } });
    const refreshed = refreshPortfolioFactInMemory({ organizationId: orgId, portfolioId: body.portfolioId ?? null, propertyId: body.propertyId ?? null, leaseId: body.leaseId ?? null, documentFamilyId: body.documentFamilyId, generationId: body.generationId, reviewerValues: body.reviewerValues ?? {}, familyEffectiveValues: body.familyEffectiveValues ?? {}, documentLocalValues: body.documentLocalValues ?? {}, legacyValues: body.legacyValues ?? {} });
    return jsonResponse({ schemaVersion: "portfolio-refresh-response-v1", plan, ...refreshed });
  } catch (error: any) { console.error(`[portfolio-intelligence-v8-refresh] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Failed to refresh portfolio intelligence" }, 500); }
});

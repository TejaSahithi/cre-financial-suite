// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isPortfolioExportsEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildPortfolioExport } from "../_shared/portfolio-intelligence/portfolio-export.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isPortfolioExportsEnabled()) return jsonResponse({ error: true, message: "Portfolio exports are disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    let query = supabaseAdmin.from("portfolio_lease_facts").select("id, tenant_name, property_name, premises_identifier, expiration_date, base_rent_current, base_rent_currency, coverage_status, semantic_status").eq("organization_id", orgId).is("superseded_at", null).limit(Math.min(Number(body.limit ?? 1000), 5000));
    if (body.portfolioId) query = query.eq("portfolio_id", body.portfolioId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    const exported = buildPortfolioExport({ format: body.format ?? "json", rows: data ?? [], scope: { organizationId: orgId, portfolioId: body.portfolioId ?? null }, coverageSummary: body.coverageSummary ?? {}, sourceGenerationDigest: body.sourceGenerationDigest ?? "not_materialized", filters: body.filters ?? {}, includeEvidenceText: body.includeEvidenceText === true });
    return jsonResponse({ schemaVersion: "portfolio-export-response-v1", export: exported });
  } catch (error: any) { console.error(`[portfolio-intelligence-v8-export] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Failed to export portfolio intelligence" }, 500); }
});

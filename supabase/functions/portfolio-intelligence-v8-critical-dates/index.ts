// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isPortfolioCriticalDatesEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
async function parseRequest(req: Request) { if (req.method === "GET") { const url = new URL(req.url); return Object.fromEntries(url.searchParams.entries()); } return req.json().catch(() => ({})); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isPortfolioCriticalDatesEnabled()) return jsonResponse({ error: true, message: "Portfolio critical dates are disabled" }, 403);
    const parsed = await parseRequest(req);
    if (!parsed.dateFrom || !parsed.dateTo) return jsonResponse({ error: true, message: "dateFrom and dateTo are required" }, 400);
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    let query = supabaseAdmin.from("portfolio_critical_dates").select("*").eq("organization_id", orgId).is("superseded_at", null).gte("event_date", parsed.dateFrom).lte("event_date", parsed.dateTo).order("event_date", { ascending: true }).limit(Math.min(Number(parsed.limit ?? 500), 1000));
    if (parsed.portfolioId || parsed.portfolio_id) query = query.eq("portfolio_id", parsed.portfolioId ?? parsed.portfolio_id);
    if (parsed.propertyId || parsed.property_id) query = query.eq("property_id", parsed.propertyId ?? parsed.property_id);
    if (Array.isArray(parsed.eventTypes) && parsed.eventTypes.length) query = query.in("event_type", parsed.eventTypes);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return jsonResponse({ schemaVersion: "portfolio-critical-dates-response-v1", events: (data ?? []).map((row: any) => ({ eventId: row.id, leaseId: row.lease_id, documentFamilyId: row.document_family_id, propertyId: row.property_id, eventType: row.event_type, label: row.label, eventDate: row.event_date, windowStart: row.window_start, windowEnd: row.window_end, calculationStatus: row.calculation_status, materiality: row.materiality, isBlocking: row.is_blocking, isEstimated: row.is_estimated, sourceFieldKeys: row.source_field_keys ?? [], evidenceAvailable: (row.source_evidence_ids ?? []).length > 0 })) });
  } catch (error: any) { console.error(`[portfolio-intelligence-v8-critical-dates] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Failed to query critical dates" }, 500); }
});

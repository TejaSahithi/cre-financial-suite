// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isEventBusEnabled, isPublicApiEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { publishIntegrationEvent } from "../_shared/events/event-publisher.ts";
import { buildIntegrationApiResponse } from "../_shared/integrations/public-api.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    if (req.method === "POST") {
      if (!isEventBusEnabled()) return jsonResponse({ error: true, message: "Event bus is disabled" }, 403);
      const body = await req.json().catch(() => ({}));
      const result = await publishIntegrationEvent({ supabaseAdmin, organizationId: orgId, eventKey: body.eventKey, aggregateId: body.aggregateId, aggregateType: body.aggregateType, generationId: body.generationId ?? null, payload: body.payload ?? {}, metadata: { source: "integration-events-v1" } });
      return jsonResponse({ schemaVersion: "integration-event-publish-response-v1", ...result });
    }
    if (!isPublicApiEnabled()) return jsonResponse({ error: true, message: "Public integration API is disabled" }, 403);
    const url = new URL(req.url);
    const { data, error } = await supabaseAdmin.from("integration_events").select("id,event_key,event_id,aggregate_id,aggregate_type,generation_id,contract_version,occurred_at,payload_hash").eq("organization_id", orgId).order("occurred_at", { ascending: false }).limit(1000);
    if (error) throw new Error(error.message);
    return jsonResponse(buildIntegrationApiResponse("events", data ?? [], { cursor: url.searchParams.get("cursor"), limit: Number(url.searchParams.get("limit") ?? 50) }));
  } catch (error: any) { console.error(`[integration-events-v1] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Integration event request failed" }, 500); }
});

// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isConnectorsEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildConnectorPayload, sanitizeConnectorTelemetry } from "../_shared/integrations/connector-adapters.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isConnectorsEnabled()) return jsonResponse({ error: true, message: "Connectors are disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const payload = body.contractVersion ? buildConnectorPayload({ connectorKey: body.connectorKey, contractVersion: body.contractVersion, payload: body.payload ?? {} }) : null;
    return jsonResponse({ schemaVersion: "connector-management-response-v1", organizationId: orgId, payload, telemetry: sanitizeConnectorTelemetry(body.telemetry ?? { connectorKey: body.connectorKey, status: body.status ?? "disabled" }) });
  } catch (error: any) { console.error(`[connector-management-v9] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Connector management failed" }, 500); }
});

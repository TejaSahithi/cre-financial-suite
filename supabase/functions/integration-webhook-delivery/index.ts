// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isWebhooksEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildSignedWebhookDelivery } from "../_shared/integrations/webhook-delivery.ts";
import { classifyDeliveryAttempt } from "../_shared/integrations/retry-policy.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isWebhooksEnabled()) return jsonResponse({ error: true, message: "Webhooks are disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    await getUserOrgId(user.id, supabaseAdmin, req);
    const delivery = await buildSignedWebhookDelivery({ endpointUrl: body.endpointUrl, secret: body.secret ?? "local-test-secret", event: body.event, timestamp: body.timestamp });
    const attempt = classifyDeliveryAttempt({ attemptNumber: Number(body.attemptNumber ?? 1), status: body.responseStatus ?? null, errorCode: body.errorCode ?? null, policy: body.retryPolicy ?? {} });
    return jsonResponse({ schemaVersion: "webhook-delivery-plan-v1", delivery, attempt });
  } catch (error: any) { console.error(`[integration-webhook-delivery] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Webhook delivery failed" }, 500); }
});

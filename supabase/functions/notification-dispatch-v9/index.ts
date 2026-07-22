// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isNotificationsEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildNotification } from "../_shared/integrations/notification-service.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isNotificationsEnabled()) return jsonResponse({ error: true, message: "Notifications are disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const notification = buildNotification({ organizationId: orgId, templateKey: body.templateKey, channel: body.channel, recipientType: body.recipientType, recipientKey: body.recipientKey, payload: body.payload ?? {}, eventId: body.eventId ?? null, workflowTaskId: body.workflowTaskId ?? null, scheduledAt: body.scheduledAt });
    return jsonResponse({ schemaVersion: "notification-dispatch-response-v1", notification });
  } catch (error: any) { console.error(`[notification-dispatch-v9] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Notification dispatch failed" }, 500); }
});

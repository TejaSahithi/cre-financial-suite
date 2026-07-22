// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isCalendarSyncEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { buildIcsCalendar, calendarSyncPlan } from "../_shared/integrations/calendar-sync.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isCalendarSyncEnabled()) return jsonResponse({ error: true, message: "Calendar sync is disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    const events = Array.isArray(body.events) ? body.events : [];
    return jsonResponse({ schemaVersion: "calendar-sync-response-v1", organizationId: orgId, mode: "read_only", plan: calendarSyncPlan(events), ics: buildIcsCalendar({ calendarName: body.calendarName ?? "Lease Critical Dates", events }) });
  } catch (error: any) { console.error(`[calendar-sync-v9] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Calendar sync failed" }, 500); }
});

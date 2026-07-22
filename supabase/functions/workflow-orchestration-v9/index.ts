// @ts-nocheck

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isWorkflowEngineEnabled } from "../_shared/extraction/document-intelligence-v3/feature-flag.ts";
import { startWorkflowInstance, completeWorkflowTask } from "../_shared/workflows/workflow-engine.ts";

function jsonResponse(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }

if (import.meta.main) Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (!isWorkflowEngineEnabled()) return jsonResponse({ error: true, message: "Workflow engine is disabled" }, 403);
    const body = await req.json().catch(() => ({}));
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    if (body.action === "complete_task") return jsonResponse({ schemaVersion: "workflow-orchestration-response-v1", instance: completeWorkflowTask(body.instance, body.taskKey, user.id, body.now) });
    return jsonResponse({ schemaVersion: "workflow-orchestration-response-v1", instance: startWorkflowInstance({ organizationId: orgId, workflowKey: body.workflowKey, aggregateId: body.aggregateId, aggregateType: body.aggregateType, triggerEventId: body.triggerEventId ?? null, context: body.context ?? {}, now: body.now }) });
  } catch (error: any) { console.error(`[workflow-orchestration-v9] ${error?.message ?? error}`); return jsonResponse({ error: true, message: error?.message ?? "Workflow orchestration failed" }, 500); }
});

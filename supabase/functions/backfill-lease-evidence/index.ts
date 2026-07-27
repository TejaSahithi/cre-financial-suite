// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";

async function resolveSourceFileId(supabaseAdmin: any, leaseId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from("leases")
      .select("source_file_id")
      .eq("id", leaseId)
      .maybeSingle();
    return data?.source_file_id ?? null;
  } catch {
    return null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(value: unknown) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const fieldsPatch = body.fields_patch ?? {};
  if (!isPlainObject(fieldsPatch)) {
    throw new Error("fields_patch must be an object");
  }

  const fieldEvidencePatch = body.field_evidence_patch ?? {};
  if (!isPlainObject(fieldEvidencePatch)) {
    throw new Error("field_evidence_patch must be an object");
  }

  const workflowOutput = body.workflow_output ?? null;

  return { leaseId, fieldsPatch, fieldEvidencePatch, workflowOutput };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/approved and locked/i.test(message)) return 409;
  if (/required|not found|must be an|exceeds the maximum/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["Leases", "LeaseUpload", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);
    const sourceFileId = await resolveSourceFileId(supabaseAdmin, payload.leaseId);
    const logger = sourceFileId ? createLogger(supabaseAdmin, sourceFileId, orgId) : null;
    const uiContext = body?._uiContext ?? null;
    await logger?.event("evidence_backfill", "started", { lease_id: payload.leaseId, ui: uiContext });

    const { data, error } = await supabaseAdmin.rpc("backfill_lease_evidence", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_fields_patch: payload.fieldsPatch,
      p_field_evidence_patch: payload.fieldEvidencePatch,
      p_workflow_output: payload.workflowOutput,
    });

    if (error) {
      await logger?.event("evidence_backfill", "failed", { lease_id: payload.leaseId, reason: error.message });
      throw new Error(error.message || "backfill_lease_evidence failed");
    }

    await logger?.event("evidence_backfill", "succeeded", { lease_id: payload.leaseId, ui: uiContext });
    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not backfill lease evidence";
    return jsonResponse({
      error: true,
      message,
      error_code: "BACKFILL_LEASE_EVIDENCE_FAILED",
    }, errorStatus(message));
  }
});

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
const ALLOWED_ACTIONS = new Set([
  "lease_extraction_manual_review_recorded",
  "lease_extraction_merged",
  "lease_extraction_merge_blocked",
  "lease_extraction_debug_applied",
]);

function isPlainObject(value: unknown) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const action = String(body.action || "").trim();
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error(`action must be one of ${[...ALLOWED_ACTIONS].join(", ")}`);
  }

  const patch = body.patch ?? {};
  if (!isPlainObject(patch)) {
    throw new Error("patch must be an object");
  }

  return { leaseId, action, patch };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/approved and locked/i.test(message)) return 409;
  if (/required|not found|must be an|must be one of|is not permitted|exceeds the maximum/i.test(message)) return 400;
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
    // ExtractionDebugPanel.jsx is rendered inside LeaseReview.jsx (not a
    // separate routed page), so the same 3-page write-access set used by
    // every other lease RPC this epic has added applies to all three
    // target call sites.
    await assertPageAccess(req, orgId, ["Leases", "LeaseUpload", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);
    const sourceFileId = await resolveSourceFileId(supabaseAdmin, payload.leaseId);
    const logger = sourceFileId ? createLogger(supabaseAdmin, sourceFileId, orgId) : null;
    const uiContext = body?._uiContext ?? null;
    await logger?.event("extraction_merge", "started", {
      lease_id: payload.leaseId,
      action: payload.action,
      ui: uiContext,
    });

    const { data, error } = await supabaseAdmin.rpc("persist_lease_extraction_merge", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_action: payload.action,
      p_patch: payload.patch,
    });

    if (error) {
      await logger?.event("extraction_merge", "failed", {
        lease_id: payload.leaseId,
        action: payload.action,
        reason: error.message,
      });
      throw new Error(error.message || "persist_lease_extraction_merge failed");
    }

    await logger?.event("extraction_merge", "succeeded", {
      lease_id: payload.leaseId,
      action: payload.action,
      ui: uiContext,
    });
    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not persist lease extraction merge";
    return jsonResponse({
      error: true,
      message,
      error_code: "PERSIST_LEASE_EXTRACTION_MERGE_FAILED",
    }, errorStatus(message));
  }
});

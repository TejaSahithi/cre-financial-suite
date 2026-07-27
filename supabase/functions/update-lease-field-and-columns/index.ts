// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";

// Lease-scoped route; pipeline_logs is keyed on the source uploaded_files
// row. Resolve best-effort — a lease with no resolvable source file simply
// skips logging rather than blocking the update.
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

  const fieldKey = String(body.field_key || "").trim();
  if (!fieldKey) {
    throw new Error("field_key is required");
  }

  const columnUpdates = body.column_updates ?? {};
  if (!isPlainObject(columnUpdates)) {
    throw new Error("column_updates must be an object");
  }

  const patch = body.patch ?? {};
  if (!isPlainObject(patch)) {
    throw new Error("patch must be an object");
  }

  return { leaseId, fieldKey, columnUpdates, patch };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/approved and locked/i.test(message)) return 409;
  if (/required|not found|must be an|is not permitted/i.test(message)) return 400;
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
    await logger?.event("field_edit", "started", {
      lease_id: payload.leaseId,
      field_key: payload.fieldKey,
      ui: uiContext,
    });

    const { data, error } = await supabaseAdmin.rpc("update_lease_field_and_columns", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_field_key: payload.fieldKey,
      p_column_updates: payload.columnUpdates,
      p_patch: payload.patch,
    });

    if (error) {
      await logger?.event("field_edit", "failed", {
        lease_id: payload.leaseId,
        field_key: payload.fieldKey,
        reason: error.message,
      });
      throw new Error(error.message || "update_lease_field_and_columns failed");
    }

    await logger?.event("field_edit", "succeeded", {
      lease_id: payload.leaseId,
      field_key: payload.fieldKey,
      ui: uiContext,
    });
    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not update lease field";
    return jsonResponse({
      error: true,
      message,
      error_code: "UPDATE_LEASE_FIELD_AND_COLUMNS_FAILED",
    }, errorStatus(message));
  }
});

// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

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
      throw new Error(error.message || "update_lease_field_and_columns failed");
    }

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

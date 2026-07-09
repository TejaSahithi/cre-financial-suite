// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(["create", "update", "mark_complete", "delete"]);

function isUuid(value: unknown) {
  return typeof value === "string" && UUID_RE.test(value);
}

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const action = String(body.action || "").trim();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error("action must be one of create, update, mark_complete, delete");
  }

  const criticalDateId = isUuid(body.critical_date_id) ? body.critical_date_id : null;
  if (action !== "create" && !criticalDateId) {
    throw new Error("critical_date_id is required for this action");
  }

  const patch = body.patch ?? {};
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be an object");
  }

  return { leaseId, action, criticalDateId, patch };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be one of|not permitted|must be a/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["CriticalDates", "Leases", "LeaseReview", "LeaseUpload"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("manage_lease_critical_date", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_action: payload.action,
      p_critical_date_id: payload.criticalDateId,
      p_patch: payload.patch,
    });

    if (error) {
      throw new Error(error.message || "manage_lease_critical_date failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not manage lease critical date";
    return jsonResponse({
      error: true,
      message,
      error_code: "MANAGE_LEASE_CRITICAL_DATE_FAILED",
    }, errorStatus(message));
  }
});

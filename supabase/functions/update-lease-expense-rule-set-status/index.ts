// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_STATUSES = new Set(["draft", "needs_review", "approved"]);

function validatePayload(body: Record<string, unknown> = {}) {
  const ruleSetId = String(body.rule_set_id || "").trim();
  if (!UUID_RE.test(ruleSetId)) {
    throw new Error("rule_set_id is required");
  }

  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const status = String(body.status || "").trim();
  if (!ALLOWED_STATUSES.has(status)) {
    throw new Error(`status must be one of ${[...ALLOWED_STATUSES].join(", ")}`);
  }

  return { ruleSetId, leaseId, status };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be one of/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["LeaseExpenseRules", "LeaseExpenseClassification", "LeaseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("update_lease_expense_rule_set_status", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_rule_set_id: payload.ruleSetId,
      p_status: payload.status,
    });

    if (error) {
      throw new Error(error.message || "update_lease_expense_rule_set_status failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not update lease expense rule set status";
    return jsonResponse({
      error: true,
      message,
      error_code: "UPDATE_LEASE_EXPENSE_RULE_SET_STATUS_FAILED",
    }, errorStatus(message));
  }
});

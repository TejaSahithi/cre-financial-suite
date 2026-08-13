// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_PATCH_KEYS = new Set([
  "expense_category",
  "expense_subcategory",
  "included_in_base_rent",
  "operational_responsibility",
  "payment_treatment",
  "recoverable_from_tenant",
  "cam_eligible",
  "recovery_method",
  "allocation_basis",
  "cap_type",
  "cap_percent",
  "cap_amount",
  "admin_fee_applicable",
  "admin_fee_percent",
  "gross_up_applicable",
  "gross_up_percent",
  "reconciliation_required",
  "notes",
  "index_adjustment_applicable",
  "index_adjustment_type",
  "index_name",
  "index_base_period",
  "index_current_period",
  "index_adjustment_percent",
  "index_floor_percent",
  "index_cap_percent",
  "index_adjustment_frequency",
  "index_source",
]);

function validatePayload(body: Record<string, unknown> = {}) {
  const ruleId = String(body.rule_id || "").trim();
  if (!UUID_RE.test(ruleId)) {
    throw new Error("rule_id is required");
  }

  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const patch = body.patch;
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("patch must be an object");
  }

  for (const key of Object.keys(patch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      throw new Error(`field ${key} is not permitted`);
    }
  }

  return { ruleId, leaseId, patch };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be a|is not permitted/i.test(message)) return 400;
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

    const { data, error } = await supabaseAdmin.rpc("update_lease_expense_rule", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_rule_id: payload.ruleId,
      p_patch: payload.patch,
    });

    if (error) {
      throw new Error(error.message || "update_lease_expense_rule failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not update lease expense rule";
    return jsonResponse({
      error: true,
      message,
      error_code: "UPDATE_LEASE_EXPENSE_RULE_FAILED",
    }, errorStatus(message));
  }
});

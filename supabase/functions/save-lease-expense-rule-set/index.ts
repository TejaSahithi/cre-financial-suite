// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown) {
  return typeof value === "string" && UUID_RE.test(value);
}

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!UUID_RE.test(leaseId)) {
    throw new Error("lease_id is required");
  }

  const status = String(body.status || "").trim();
  if (!status) {
    throw new Error("status is required");
  }

  const ruleSetId = isUuid(body.rule_set_id) ? body.rule_set_id : null;
  const version = Number.isFinite(Number(body.version)) ? Math.trunc(Number(body.version)) : null;
  const extractionVersion = body.extraction_version != null ? String(body.extraction_version) : null;
  const propertyId = isUuid(body.property_id) ? body.property_id : null;

  const rules = Array.isArray(body.rules) ? body.rules : [];
  const values = Array.isArray(body.values) ? body.values : [];
  const clauses = Array.isArray(body.clauses) ? body.clauses : [];
  const supersededRuleIds = Array.isArray(body.superseded_rule_ids)
    ? body.superseded_rule_ids.filter(isUuid)
    : [];

  return {
    leaseId,
    status,
    ruleSetId,
    version,
    extractionVersion,
    propertyId,
    rules,
    values,
    clauses,
    supersededRuleIds,
  };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found/i.test(message)) return 400;
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

    const { data, error } = await supabaseAdmin.rpc("save_lease_expense_rule_set", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_rule_set_id: payload.ruleSetId,
      p_version: payload.version,
      p_status: payload.status,
      p_extraction_version: payload.extractionVersion,
      p_property_id: payload.propertyId,
      p_rules: payload.rules,
      p_values: payload.values,
      p_clauses: payload.clauses,
      p_superseded_rule_ids: payload.supersededRuleIds.length > 0 ? payload.supersededRuleIds : null,
    });

    if (error) {
      throw new Error(error.message || "save_lease_expense_rule_set failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not save lease expense rule set";
    return jsonResponse({
      error: true,
      message,
      error_code: "SAVE_LEASE_EXPENSE_RULE_SET_FAILED",
    }, errorStatus(message));
  }
});

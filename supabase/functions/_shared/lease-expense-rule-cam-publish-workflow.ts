// @ts-nocheck
import { corsHeaders } from "./cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "./supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateCamPublishPayload(body: Record<string, unknown> = {}) {
  const ruleId = String(body.rule_id || body.ruleId || "").trim();
  const idempotencyKey = String(body.idempotency_key || body.idempotencyKey || "").trim();

  if (!UUID_RE.test(ruleId)) {
    throw new Error("rule_id is required");
  }
  if (!idempotencyKey) {
    throw new Error("idempotency_key is required");
  }

  return { ruleId, idempotencyKey };
}

function normalize(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export function deriveServerCamPublishBlockers(rule: Record<string, unknown> = {}) {
  const blockers: string[] = [];
  const approval = normalize(rule.approval_status);
  const review = normalize(rule.review_status);
  const recoverable = normalize(rule.recoverable_from_tenant);
  const camEligible = normalize(rule.cam_eligible);
  const paymentTreatment = normalize(rule.payment_treatment);
  const rowStatus = normalize(rule.row_status || rule.extraction_status);
  const sourceText = String(rule.exact_source_text || rule.source || "").trim();
  const notes = String(rule.notes || "").trim();

  if (rule.published_to_cam === true) return ["already_published"];
  if (!(approval === "approved" && ["approved", "reviewed"].includes(review))) blockers.push("not_approved");
  if (recoverable !== "yes") blockers.push("not_recoverable");
  if (camEligible !== "yes") blockers.push("not_cam_eligible");
  if (rule.included_in_base_rent === true || paymentTreatment === "included_in_base_rent") blockers.push("included_in_base_rent");
  if (paymentTreatment === "tenant_direct_contract") blockers.push("tenant_direct");
  if (rule.is_excluded === true || ["unmapped", "not_found", "not_mentioned", "not_applicable", "rejected"].includes(rowStatus)) {
    blockers.push("explicit_exclusion");
  }
  if (!sourceText && !notes) blockers.push("missing_lease_evidence");
  return [...new Set(blockers)];
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|organization|outside/i.test(message)) return 403;
  if (/required|idempotency|payload|rule_id|only approved|recoverable|eligible|excluded|evidence/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

export async function handleCamPublishRequest(req: Request) {
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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification", "LeaseExpenseRules", "CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validateCamPublishPayload(body);

    const { data: rule, error: ruleError } = await supabaseAdmin
      .from("lease_expense_rules")
      .select("*")
      .eq("id", payload.ruleId)
      .maybeSingle();

    if (ruleError || !rule) {
      return jsonResponse({
        error: true,
        message: "Lease expense rule not found for this organization",
        error_code: "RULE_NOT_FOUND",
      }, 404);
    }

    const effectiveOrgId = rule.org_id || null;
    if (effectiveOrgId && effectiveOrgId !== orgId) {
      return jsonResponse({
        error: true,
        message: "Lease expense rule not found for this organization",
        error_code: "RULE_NOT_FOUND",
      }, 404);
    }

    const blockers = deriveServerCamPublishBlockers(rule);
    if (blockers.length > 0 && !(blockers.length === 1 && blockers[0] === "already_published")) {
      return jsonResponse({
        error: true,
        message: `Rule is not publishable to CAM: ${blockers.join(", ")}`,
        error_code: "RULE_NOT_PUBLISHABLE",
        blockers,
      }, 400);
    }

    const requestPayload = {
      rule_id: payload.ruleId,
      blockers,
    };

    const { data, error } = await supabaseAdmin.rpc("publish_lease_expense_rule_to_cam_workflow", {
      p_org_id: orgId,
      p_rule_id: payload.ruleId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_idempotency_key: payload.idempotencyKey,
      p_request_payload: requestPayload,
    });

    if (error) {
      throw new Error(error.message || "publish_lease_expense_rule_to_cam_workflow failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Lease expense rule CAM publish workflow failed";
    return jsonResponse({
      error: true,
      message,
      error_code: "LEASE_EXPENSE_RULE_CAM_PUBLISH_WORKFLOW_FAILED",
    }, errorStatus(message));
  }
}

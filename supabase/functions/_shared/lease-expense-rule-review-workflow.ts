// @ts-nocheck
import { corsHeaders } from "./cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "./supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_ACTIONS = new Set(["approve", "reject", "not_applicable"]);

function normalizeAction(action: string) {
  const normalized = String(action || "").trim().toLowerCase();
  if (!ALLOWED_ACTIONS.has(normalized)) {
    throw new Error("action must be approve, reject, or not_applicable");
  }
  return normalized;
}

export function validateRuleReviewPayload(body: Record<string, unknown> = {}, action: string) {
  const normalizedAction = normalizeAction(action);
  const ruleId = String(body.rule_id || body.ruleId || "").trim();
  const idempotencyKey = String(body.idempotency_key || body.idempotencyKey || "").trim();
  const reason = String(body.reason || body.comment || body.review_comment || body.reviewComment || "").trim();

  if (!UUID_RE.test(ruleId)) {
    throw new Error("rule_id is required");
  }
  if (!idempotencyKey) {
    throw new Error("idempotency_key is required");
  }

  return {
    action: normalizedAction,
    ruleId,
    idempotencyKey,
    reason: reason || null,
  };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|organization|outside/i.test(message)) return 403;
  if (/required|idempotency|action|payload|rule_id/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

export async function handleRuleReviewRequest(req: Request, action: "approve" | "reject" | "not_applicable") {
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
    const payload = validateRuleReviewPayload(body, action);
    const requestPayload = {
      rule_id: payload.ruleId,
      action: payload.action,
      reason: payload.reason,
    };

    const { data, error } = await supabaseAdmin.rpc("review_lease_expense_rule_workflow", {
      p_org_id: orgId,
      p_rule_id: payload.ruleId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_action: payload.action,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
      p_request_payload: requestPayload,
    });

    if (error) {
      throw new Error(error.message || "review_lease_expense_rule_workflow failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Lease expense rule review workflow failed";
    return jsonResponse({
      error: true,
      message,
      error_code: "LEASE_EXPENSE_RULE_REVIEW_WORKFLOW_FAILED",
    }, errorStatus(message));
  }
}

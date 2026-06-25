// @ts-nocheck
import { corsHeaders } from "./cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "./supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateExpenseCamSendPayload(body: Record<string, unknown> = {}) {
  const classificationId = String(body.classification_id || body.classificationId || "").trim();
  const idempotencyKey = String(body.idempotency_key || body.idempotencyKey || "").trim();
  const reason = String(body.reason || "").trim() || null;

  if (!UUID_RE.test(classificationId)) {
    throw new Error("classification_id is required");
  }
  if (!idempotencyKey) {
    throw new Error("idempotency_key is required");
  }

  return { classificationId, idempotencyKey, reason };
}

function normalize(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function asNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

export function deriveExpenseCamSendBlockers(
  classification: Record<string, unknown> = {},
  expense: Record<string, unknown> | null = null,
  rule: Record<string, unknown> | null = null,
  reason: string | null = null,
) {
  const blockers: string[] = [];
  const amount = asNumber(classification.amount ?? expense?.amount);
  const recoverability = normalize(classification.recoverability_result || classification.recovery_status);
  const camEligible = normalize(classification.cam_eligible);
  const paymentTreatment = normalize(rule?.payment_treatment);
  const hasActual = Boolean(classification.actual_expense_id || classification.expense_id);
  const hasRule = Boolean(classification.lease_expense_rule_id || classification.linked_expense_rule_id || classification.recovery_rule_id);
  const alreadySent = classification.sent_to_cam === true || Boolean(classification.sent_to_cam_at);
  const hasReason = Boolean(String(reason || "").trim());
  const automatic =
    hasActual &&
    hasRule &&
    recoverability === "recoverable" &&
    camEligible === "yes" &&
    rule?.published_to_cam === true &&
    amount > 0 &&
    !alreadySent &&
    paymentTreatment !== "included_in_base_rent" &&
    paymentTreatment !== "tenant_direct_contract" &&
    rule?.is_excluded !== true;

  if (alreadySent) return ["already_sent"];
  if (!hasActual && !hasRule) blockers.push("missing_actual_or_rule");
  if (amount <= 0) blockers.push("missing_amount");
  if (recoverability === "conditional" && !classification.condition_resolved) {
    blockers.push("unresolved_conditional");
  }
  if (camEligible !== "yes") blockers.push("not_cam_eligible");
  if (rule && (paymentTreatment === "included_in_base_rent" || paymentTreatment === "tenant_direct_contract" || rule.is_excluded === true)) {
    blockers.push("explicit_exclusion");
  }
  if (!automatic && !hasReason) blockers.push("manual_reason_required");
  if (hasRule && rule && rule.published_to_cam !== true && !hasReason) blockers.push("rule_not_published_to_cam");

  return [...new Set(blockers)];
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|organization|outside/i.test(message)) return 403;
  if (/required|idempotency|payload|eligible|amount|reason|cam|classification/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

export async function handleExpenseCamSendRequest(req: Request) {
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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification", "ExpenseReview", "CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validateExpenseCamSendPayload(body);

    const { data: classification, error: classificationError } = await supabaseAdmin
      .from("expense_classifications")
      .select("*")
      .eq("id", payload.classificationId)
      .maybeSingle();

    if (classificationError || !classification || classification.org_id !== orgId) {
      return jsonResponse({
        error: true,
        message: "Expense classification not found for this organization",
        error_code: "CLASSIFICATION_NOT_FOUND",
      }, 404);
    }

    const expenseId = classification.actual_expense_id || classification.expense_id || null;
    const ruleId = classification.lease_expense_rule_id || classification.linked_expense_rule_id || classification.recovery_rule_id || null;
    const [{ data: expense, error: expenseError }, { data: rule, error: ruleError }] = await Promise.all([
      expenseId
        ? supabaseAdmin.from("expenses").select("*").eq("id", expenseId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      ruleId
        ? supabaseAdmin.from("lease_expense_rules").select("*").eq("id", ruleId).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);

    if (expenseError || (expenseId && (!expense || expense.org_id !== orgId))) {
      return jsonResponse({
        error: true,
        message: "Expense not found for this organization",
        error_code: "EXPENSE_NOT_FOUND",
      }, 404);
    }
    if (ruleError || (rule && rule.org_id && rule.org_id !== orgId)) {
      return jsonResponse({
        error: true,
        message: "Lease expense rule not found for this organization",
        error_code: "RULE_NOT_FOUND",
      }, 404);
    }

    const blockers = deriveExpenseCamSendBlockers(classification, expense, rule, payload.reason);
    if (blockers.length > 0 && !(blockers.length === 1 && blockers[0] === "already_sent")) {
      if (blockers.includes("unresolved_conditional")) {
        try {
          await supabaseAdmin.from("audit_logs").insert({
            org_id: orgId,
            property_id: classification.property_id ?? null,
            entity_type: "expense_classifications",
            entity_id: payload.classificationId,
            action: "expense_conditional_blocked_from_cam",
            actor_user_id: user.id,
            actor_email: user.email ?? null,
            source: "edge_function",
            severity: "info",
            metadata: {
              classification_id: payload.classificationId,
              blockers,
              recoverability_result: classification.recoverability_result ?? null,
              condition_resolved: classification.condition_resolved ?? false,
            },
          });
        } catch (auditErr) {
          console.error("[send-expense-classification-to-cam] audit_log insert error (conditional_blocked):", auditErr?.message || auditErr);
        }
      }
      return jsonResponse({
        error: true,
        message: `Expense classification cannot be sent to CAM: ${blockers.join(", ")}`,
        error_code: "CLASSIFICATION_NOT_CAM_SENDABLE",
        blockers,
      }, 400);
    }

    const requestPayload = {
      classification_id: payload.classificationId,
      reason: payload.reason,
    };

    const { data, error } = await supabaseAdmin.rpc("send_expense_classification_to_cam_workflow", {
      p_org_id: orgId,
      p_classification_id: payload.classificationId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_reason: payload.reason,
      p_idempotency_key: payload.idempotencyKey,
      p_request_payload: requestPayload,
    });

    if (error) {
      throw new Error(error.message || "send_expense_classification_to_cam_workflow failed");
    }

    try {
      await supabaseAdmin.from("audit_logs").insert({
        org_id: orgId,
        property_id: classification.property_id ?? null,
        entity_type: "expense_classifications",
        entity_id: payload.classificationId,
        action: "expense_classification_sent_to_cam",
        actor_user_id: user.id,
        actor_email: user.email ?? null,
        source: "edge_function",
        severity: "info",
        metadata: {
          classification_id: payload.classificationId,
          expense_id: expenseId ?? null,
          rule_id: ruleId ?? null,
          amount: expense?.amount ?? classification.amount ?? null,
          recoverability_result: classification.recoverability_result ?? null,
          reason: payload.reason ?? null,
        },
      });
    } catch (auditErr) {
      console.error("[send-expense-classification-to-cam] audit_log insert error (sent):", auditErr?.message || auditErr);
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Expense classification CAM send workflow failed";
    return jsonResponse({
      error: true,
      message,
      error_code: "EXPENSE_CLASSIFICATION_CAM_SEND_WORKFLOW_FAILED",
    }, errorStatus(message));
  }
}

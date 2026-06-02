import { invokeEdgeFunction } from "@/services/edgeFunctions";

export function createRuleReviewIdempotencyKey(ruleId, action) {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `lease-expense-rule:${action}:${ruleId}:${random}`;
}

async function reviewRuleWorkflow(functionName, { ruleId, reason = null, idempotencyKey }) {
  return invokeEdgeFunction(functionName, {
    rule_id: ruleId,
    reason,
    idempotency_key: idempotencyKey,
  });
}

export async function approveLeaseExpenseRule({ ruleId, reason = null, idempotencyKey }) {
  return reviewRuleWorkflow("approve-lease-expense-rule", {
    ruleId,
    reason,
    idempotencyKey,
  });
}

export async function rejectLeaseExpenseRule({ ruleId, reason = null, idempotencyKey }) {
  return reviewRuleWorkflow("reject-lease-expense-rule", {
    ruleId,
    reason,
    idempotencyKey,
  });
}

export async function markLeaseExpenseRuleNotApplicable({ ruleId, reason = null, idempotencyKey }) {
  return reviewRuleWorkflow("mark-lease-expense-rule-not-applicable", {
    ruleId,
    reason,
    idempotencyKey,
  });
}

export async function publishLeaseExpenseRuleToCam({ ruleId, idempotencyKey }) {
  return invokeEdgeFunction("publish-lease-expense-rule-to-cam", {
    rule_id: ruleId,
    idempotency_key: idempotencyKey,
  });
}

import { invokeEdgeFunction } from "@/services/edgeFunctions";

export function createExpenseClassificationCamSendIdempotencyKey(classificationId) {
  const random =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `expense-classification:send_to_cam:${classificationId}:${random}`;
}

export async function sendExpenseClassificationToCam({ classificationId, reason = null, idempotencyKey }) {
  return invokeEdgeFunction("send-expense-classification-to-cam", {
    classification_id: classificationId,
    reason,
    idempotency_key: idempotencyKey,
  });
}

export async function reviewExpenseClassification({ classificationId, action, recoveryStatus = null, approvedStatus = null }) {
  return invokeEdgeFunction("review-expense-classification", {
    classification_id: classificationId,
    action,
    recovery_status: recoveryStatus,
    approved_status: approvedStatus,
  });
}

// The one reachable way to close out a conditional classification -- see
// resolve_expense_classification_condition (20269900000047 migration):
// nothing else in the app can ever flip condition_resolved, so a
// conditional row was previously stuck forever, unable to reach CAM.
export async function resolveExpenseClassificationCondition({ classificationId, resolution, reason, evidence = null }) {
  return invokeEdgeFunction("resolve-expense-classification-condition", {
    classification_id: classificationId,
    resolution,
    reason,
    evidence,
  });
}

// CAM publication boundary (withdraw_cam_expense_input,
// 20260905000000_cam_publication_rpcs.sql): pulls back an actively
// published cam_expense_inputs row without deleting it (marked
// 'withdrawn'), returns the classification to review, and marks affected
// CAM computation_snapshots stale (or restatement_required if locked).
export async function withdrawCamExpenseInput({ classificationId, reason }) {
  return invokeEdgeFunction("withdraw-cam-expense-input", {
    classification_id: classificationId,
    reason,
  });
}

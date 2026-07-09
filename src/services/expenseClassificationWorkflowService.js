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

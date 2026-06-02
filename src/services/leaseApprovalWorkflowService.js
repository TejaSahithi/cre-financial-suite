import { invokeEdgeFunction } from "@/services/edgeFunctions";

export function createLeaseApprovalIdempotencyKey(leaseId) {
  const randomId = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `lease-approval:${leaseId}:${randomId}`;
}

export async function approveLeaseWorkflow({
  leaseId,
  signedBy,
  signedAt,
  approvalComments = "",
  approvalDocumentUrl = null,
  fieldReviews = {},
  idempotencyKey,
}) {
  return invokeEdgeFunction("approve-lease-workflow", {
    lease_id: leaseId,
    signed_by: signedBy,
    signed_at: signedAt,
    approval_comments: approvalComments,
    approval_document_url: approvalDocumentUrl,
    field_reviews: fieldReviews,
    idempotency_key: idempotencyKey || createLeaseApprovalIdempotencyKey(leaseId),
  });
}

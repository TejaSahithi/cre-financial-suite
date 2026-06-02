import {
  readFieldValue,
  readFieldEvidence,
  REVIEW_STATUSES,
} from "@/lib/leaseReviewSchema";

export function buildBulkApprovalState({
  eligibleFields,
  fieldReviews,
  lease,
  signedBy,
  nowIso,
  reviewStatuses = REVIEW_STATUSES,
}) {
  const nextFieldReviews = { ...fieldReviews };
  const auditDetails = [];

  for (const key of eligibleFields) {
    nextFieldReviews[key] = {
      ...(fieldReviews[key] || {}),
      status: reviewStatuses.ACCEPTED,
      reviewed_at: nowIso,
    };
    const prevReview = fieldReviews[key];
    const prevStatus = prevReview?.status;
    const evidence = readFieldEvidence(lease, key);
    
    auditDetails.push({
      field_key: key,
      previous_review_status: prevStatus,
      new_review_status: reviewStatuses.ACCEPTED,
      approved_by: signedBy,
      approved_at: nowIso,
      approval_method: "bulk_lease_approval",
      value: readFieldValue(lease, key),
      source_page: evidence?.sourcePage || evidence?.source_page,
      source_text: evidence?.sourceText || evidence?.exact_source_text || evidence?.source_text,
    });
  }

  return { nextFieldReviews, auditDetails };
}

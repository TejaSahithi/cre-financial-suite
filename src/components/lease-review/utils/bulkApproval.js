import {
  readFieldValue,
  readFieldEvidence,
  REVIEW_STATUSES,
} from "@/lib/leaseReviewSchema";

export function buildBulkApprovalState({
  eligibleFields,
  autoNaFields = [],
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

  for (const key of autoNaFields) {
    const prevReview = fieldReviews[key];
    if (prevReview?.status === reviewStatuses.REJECTED) continue; // keep explicit rejections
    nextFieldReviews[key] = {
      ...(prevReview || {}),
      status: reviewStatuses.N_A,
      reviewed_at: nowIso,
      auto_na_reason: "No value extracted — marked N/A during bulk approval",
    };
    auditDetails.push({
      field_key: key,
      previous_review_status: prevReview?.status,
      new_review_status: reviewStatuses.N_A,
      approved_by: signedBy,
      approved_at: nowIso,
      approval_method: "bulk_auto_na",
      value: null,
    });
  }

  return { nextFieldReviews, auditDetails };
}

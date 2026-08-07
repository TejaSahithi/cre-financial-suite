import {
  readFieldValue,
  readFieldEvidence,
  REVIEW_STATUSES,
} from "@/lib/leaseReviewSchema";
import { getFieldAliases, normalizeLeaseFieldKey } from "@/lib/leaseFieldResolver";

function resolveRowEntry(fieldKey, primaryRowByKey, fallbackRowByKey) {
  const aliases = [fieldKey, ...getFieldAliases(fieldKey)].map(normalizeLeaseFieldKey);
  for (const key of aliases) {
    const primary = primaryRowByKey?.get?.(key) ?? primaryRowByKey?.[key];
    if (primary) return primary;
    const fallback = fallbackRowByKey?.get?.(key) ?? fallbackRowByKey?.[key];
    if (fallback) return fallback;
  }

  const candidateEntries = [
    ...(primaryRowByKey?.entries?.() ? Array.from(primaryRowByKey.entries()) : Object.entries(primaryRowByKey || {})),
    ...(fallbackRowByKey?.entries?.() ? Array.from(fallbackRowByKey.entries()) : Object.entries(fallbackRowByKey || {})),
  ];
  for (const [candidateKey, row] of candidateEntries) {
    if (!row) continue;
    const candidateAliases = getFieldAliases(candidateKey).map(normalizeLeaseFieldKey);
    if (candidateAliases.some((alias) => aliases.includes(alias))) {
      return row;
    }
  }

  return null;
}

function readRowValue(row) {
  return row?.normalized_value ?? row?.normalizedValue ?? row?.value ?? null;
}

function readRowEvidence(row, fallbackEvidence) {
  return {
    raw_value: row?.raw_value ?? row?.rawValue ?? fallbackEvidence?.rawValue ?? fallbackEvidence?.raw_value ?? null,
    source_page: row?.page_number ?? row?.source_page ?? row?.sourcePage ?? fallbackEvidence?.sourcePage ?? fallbackEvidence?.source_page ?? null,
    source_text: row?.source_text ?? row?.exact_source_text ?? row?.sourceText ?? fallbackEvidence?.sourceText ?? fallbackEvidence?.exact_source_text ?? fallbackEvidence?.source_text ?? null,
    extraction_status: row?.extraction_status ?? row?.status ?? fallbackEvidence?.extractionStatus ?? fallbackEvidence?.extraction_status ?? null,
    confidence: row?.confidence ?? fallbackEvidence?.confidence ?? null,
  };
}

export function buildBulkApprovalState({
  eligibleFields,
  autoNaFields = [],
  fieldReviews,
  lease,
  rowByKey = null,
  fallbackRowByKey = null,
  signedBy,
  nowIso,
  reviewStatuses = REVIEW_STATUSES,
}) {
  const nextFieldReviews = { ...fieldReviews };
  const auditDetails = [];

  for (const key of eligibleFields) {
    const prevReview = fieldReviews[key];
    const row = resolveRowEntry(key, rowByKey, fallbackRowByKey);
    const fallbackEvidence = readFieldEvidence(lease, key);
    const acceptedValue = readRowValue(row) ?? prevReview?.value ?? readFieldValue(lease, key);
    const evidence = readRowEvidence(row, fallbackEvidence);

    nextFieldReviews[key] = {
      ...(prevReview || {}),
      status: reviewStatuses.ACCEPTED,
      reviewed_at: nowIso,
      reviewer: prevReview?.reviewer || signedBy || null,
      ...(acceptedValue !== null && acceptedValue !== undefined ? { value: acceptedValue } : {}),
      ...(evidence.raw_value !== null && evidence.raw_value !== undefined ? { raw_value: evidence.raw_value } : {}),
      ...(evidence.source_page !== null && evidence.source_page !== undefined ? { source_page: evidence.source_page } : {}),
      ...(evidence.source_text ? { source_text: evidence.source_text, exact_source_text: evidence.source_text } : {}),
      ...(evidence.extraction_status ? { extraction_status: evidence.extraction_status } : {}),
      ...(typeof evidence.confidence === "number" ? { confidence: evidence.confidence, confidence_score: evidence.confidence } : {}),
    };
    const prevStatus = prevReview?.status;

    auditDetails.push({
      field_key: key,
      previous_review_status: prevStatus,
      new_review_status: reviewStatuses.ACCEPTED,
      approved_by: signedBy,
      approved_at: nowIso,
      approval_method: "bulk_lease_approval",
      value: acceptedValue,
      source_page: evidence.source_page,
      source_text: evidence.source_text,
    });
  }

  for (const key of autoNaFields) {
    const prevReview = fieldReviews[key];
    if (prevReview?.status === reviewStatuses.REJECTED) continue; // keep explicit rejections
    nextFieldReviews[key] = {
      ...(prevReview || {}),
      status: reviewStatuses.N_A,
      reviewed_at: nowIso,
      auto_na_reason: "No value extracted - marked N/A during bulk approval",
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

import { hasValidSourceEvidence, isCalculatedExtractionStatus, REVIEW_STATUSES } from "@/lib/leaseReviewSchema";

function isSourceBackedEntry(entry) {
  return Boolean(
    entry &&
    typeof entry === "object" &&
    hasValidSourceEvidence({ sourcePage: entry.source_page, sourceText: entry.source_text }) &&
    !isCalculatedExtractionStatus(entry.extraction_status),
  );
}

// Same protection rule LeaseReview.jsx's handleReextractLease applies
// (isProtectedField) -- a manually-edited, manually-sourced, or
// accepted/edited/approved field must never be silently overwritten.
export function isProtectedExtractionField(key, entry, fieldReviews) {
  if (entry?.manually_edited === true) return true;
  if (String(entry?.source || "").toLowerCase() === "manual") return true;
  const review = fieldReviews?.[key];
  const status = String(review?.status || "").toLowerCase();
  if (status === REVIEW_STATUSES.ACCEPTED || status === REVIEW_STATUSES.EDITED || status === "approved") return true;
  return false;
}

/**
 * Merges freshly-extracted field data onto an existing lease's
 * extraction_data, preserving:
 *   - every other top-level extraction_data key (source_file_id,
 *     field_reviews, rejection metadata, override-reason notes, etc.) via
 *     the initial spread, and
 *   - any field the reviewer has manually edited or explicitly
 *     accepted/edited/approved (isProtectedExtractionField), matching
 *     handleReextractLease's protection rule exactly.
 *
 * Used by ExtractionDebugPanel's "Apply Latest Extraction" action, which
 * previously had no protection check at all (Phase 6D-6 finding).
 */
export function mergeLatestExtraction({ extractionData, fieldsWithEvidence, evidenceMap, confidenceMap, workflowOutput }) {
  const fieldReviews = extractionData?.field_reviews || null;
  const mergedFields = { ...(extractionData?.fields || {}) };
  const mergedEvidence = { ...(extractionData?.field_evidence || {}) };
  let protectedFieldsPreservedCount = 0;

  for (const [key, entry] of Object.entries(fieldsWithEvidence || {})) {
    const prev = mergedFields[key];
    if (isProtectedExtractionField(key, prev, fieldReviews)) {
      protectedFieldsPreservedCount += 1;
      continue; // keep the manually-edited/accepted previous entry as-is
    }
    if (isSourceBackedEntry(entry) || !isSourceBackedEntry(prev)) {
      mergedFields[key] = entry;
    }
  }

  for (const [key, entry] of Object.entries(evidenceMap || {})) {
    const prev = mergedEvidence[key];
    if (isProtectedExtractionField(key, mergedFields[key], fieldReviews)) continue;
    if (isSourceBackedEntry(entry) || !isSourceBackedEntry(prev)) {
      mergedEvidence[key] = entry;
    }
  }

  const nextExtraction = {
    ...(extractionData || {}),
    fields: mergedFields,
    field_evidence: mergedEvidence,
    confidence_scores: { ...(extractionData?.confidence_scores || {}), ...(confidenceMap || {}) },
    ...(workflowOutput ? { workflow_output: workflowOutput } : {}),
    evidence_refreshed_at: new Date().toISOString(),
  };

  return { nextExtraction, protectedFieldsPreservedCount };
}

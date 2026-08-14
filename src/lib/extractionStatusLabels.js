/**
 * Friendly, non-technical progress copy for the extraction pipeline. Kept in
 * its own dependency-free module (no JSX/DOM imports) so it can be unit
 * tested without a browser environment, and reused by any page with its own
 * status polling (e.g. LeaseUpload) instead of maintaining a second,
 * potentially divergent copy of "what does this status mean to a user" (this
 * replaced a literal "Uploaded / OCR Processing / Text Extracted / AI
 * Extracting / AI Extracted / Needs Review" technical stepper).
 */
export function getFriendlyExtractionLabel(status) {
  switch (status) {
    case "uploaded":
    case "parsing":
      return "Preparing document";
    case "pdf_parsed":
      return "Reading document";
    case "validating":
      return "Extracting lease fields";
    case "normalize_field_partition_pending":
      return "Continuing large lease extraction";
    case "validated":
    case "storing":
    case "stored":
    case "computing":
      return "Preparing review";
    case "review_required":
      return "Preparing review";
    case "completed":
      return "Complete";
    case "failed":
      return "Extraction failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Processing...";
  }
}

/**
 * Does a ui_review_payload have at least one field with a real value?
 * Used as a legacy-row fallback for readiness gating (rows persisted before
 * the backend started stamping ui_review_payload.core_ready directly) — new
 * rows should read core_ready instead of re-deriving this client-side.
 */
export function payloadHasMeaningfulFields(uiReviewPayload) {
  const record = uiReviewPayload?.records?.[0];
  if (!record) return false;
  const fieldList = [
    ...(Array.isArray(record?.standard_fields) ? record.standard_fields : []),
    ...(Array.isArray(record?.custom_fields) ? record.custom_fields : []),
  ];
  return fieldList.some((field) => {
    const value = field?.value;
    if (value == null) return false;
    const text = String(value).trim();
    return text.length > 0 && !/^(n\/a|na|null|none|unknown)$/i.test(text);
  });
}

const POST_REVIEW_TERMINAL_STATUSES = ["approved", "storing", "stored", "computing", "completed"];

/**
 * Guarantee 10: "Open Lease Review" is enabled once the file is core_ready
 * (or has reached a post-review terminal status), never before — in
 * particular never while still "validating"/"pdf_parsed", regardless of how
 * loosely a caller might otherwise be tempted to gate on status alone.
 *
 * Reads the backend-computed core_ready flag directly (persisted on
 * ui_review_payload by buildMinimalReviewPayload) rather than re-deriving
 * readiness client-side; payloadHasMeaningfulFields is only consulted as a
 * fallback for legacy rows persisted before core_ready existed.
 */
export function computeCanOpenReview({ hasValidReviewPayload, uiReviewPayload, status }) {
  if (hasValidReviewPayload && status === "review_required") return true;

  // Only fall back to the legacy field-scan when core_ready is genuinely
  // absent (a row persisted before the flag existed) — an explicit
  // core_ready:false is an authoritative "not ready yet" from the backend
  // and must never be overridden by the fallback.
  const isCoreReady =
    uiReviewPayload?.core_ready === undefined
      ? payloadHasMeaningfulFields(uiReviewPayload)
      : uiReviewPayload.core_ready === true;
  if (hasValidReviewPayload && isCoreReady) return true;
  return POST_REVIEW_TERMINAL_STATUSES.includes(status || "");
}

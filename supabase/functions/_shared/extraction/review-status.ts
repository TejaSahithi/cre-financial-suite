// @ts-nocheck
export const CANONICAL_LEASE_REVIEW_FIELD_STATUSES = [
  "extracted",
  "derived",
  "not_stated",
  "not_applicable",
  "insufficient_evidence",
  "conflict",
  "invalid",
  "manual_review",
] as const;

export type LeaseReviewFieldStatus = typeof CANONICAL_LEASE_REVIEW_FIELD_STATUSES[number];

export function normalizeLeaseReviewFieldStatus(status: unknown, context: { value?: unknown; hasEvidence?: boolean } = {}): LeaseReviewFieldStatus {
  const token = String(status ?? "").trim().toLowerCase();
  if (token === "conflict" || token === "conflict_detected" || token === "has_conflict") return "conflict";
  if (token === "derived" || token === "calculated" || token === "computed") return "derived";
  if (token === "not_applicable" || token === "not applicable" || token === "n/a" || token === "na") return "not_applicable";
  if (token === "invalid" || token === "validator_rejected" || token === "rejected_invalid") return "invalid";
  if (token === "manual_review" || token === "manual_required" || token === "needs_review") return "manual_review";
  if (token === "insufficient_evidence" || token === "missing_source_evidence" || token === "evidence_missing") return "insufficient_evidence";
  if (token === "not_stated" || token === "not_found" || token === "missing" || token === "not found") {
    return context.hasEvidence === false && context.value != null && context.value !== "" ? "insufficient_evidence" : "not_stated";
  }
  if (token === "extracted" || token === "auto_populated" || token === "pending" || token === "pending_enrichment" || token === "source_backed") {
    return context.hasEvidence === false ? "insufficient_evidence" : "extracted";
  }
  const value = context.value;
  if (value === null || value === undefined || value === "") return "not_stated";
  return context.hasEvidence === false ? "insufficient_evidence" : "extracted";
}

export function resolutionStateForStatus(status: unknown, selectedCandidateId?: string | null) {
  const canonical = normalizeLeaseReviewFieldStatus(status);
  if (canonical === "conflict") return selectedCandidateId ? "provisional" : "unresolved";
  if (canonical === "invalid" || canonical === "manual_review" || canonical === "insufficient_evidence" || canonical === "not_stated") return "unresolved";
  return "authoritative";
}

export function isAuthoritativeReviewStatus(reviewStatus: unknown): boolean {
  const token = String(reviewStatus ?? "").trim().toLowerCase();
  return token === "accepted" || token === "approved" || token === "modified" || token === "edited";
}

export function getAuthoritativeFieldValue(field: any): unknown | null {
  if (!field || typeof field !== "object") return null;
  if (isAuthoritativeReviewStatus(field.reviewStatus ?? field.review_status)) return field.value ?? field.normalized_value ?? null;
  const canonical = normalizeLeaseReviewFieldStatus(field.canonical_status ?? field.status ?? field.extraction_status, {
    value: field.value ?? field.normalized_value,
    hasEvidence: Boolean(field.evidence || field.source_text || field.sourceText || field.source_page || field.sourcePage),
  });
  if (canonical === "extracted" || canonical === "derived") return field.value ?? field.normalized_value ?? null;
  return null;
}

import type { ReviewFieldStatus } from "./types";

export interface ReviewStatusPresentation {
  label: string;
  severity: "neutral" | "info" | "warning" | "danger";
  iconKey: string;
  guidance: string;
  defaultBlocking: boolean;
  className: string;
  reviewStatus: string;
}

export const REVIEW_STATUS_PRESENTATION: Record<ReviewFieldStatus, ReviewStatusPresentation> = {
  resolved: {
    label: "Resolved",
    severity: "info",
    iconKey: "check",
    guidance: "A source-backed value is available.",
    defaultBlocking: false,
    className: "bg-emerald-50 text-emerald-700",
    reviewStatus: "auto_populated",
  },
  resolved_with_warning: {
    label: "Resolved with Warning",
    severity: "warning",
    iconKey: "alert",
    guidance: "A value is available, but one or more warnings need reviewer attention.",
    defaultBlocking: false,
    className: "bg-amber-100 text-amber-800",
    reviewStatus: "needs_review",
  },
  needs_review: {
    label: "Needs Review",
    severity: "warning",
    iconKey: "alert",
    guidance: "Reviewer confirmation is required before this field can be treated as final.",
    defaultBlocking: false,
    className: "bg-amber-100 text-amber-800",
    reviewStatus: "needs_review",
  },
  conflict: {
    label: "Conflict",
    severity: "danger",
    iconKey: "conflict",
    guidance: "Multiple candidates disagree and require reviewer resolution.",
    defaultBlocking: true,
    className: "bg-red-100 text-red-700",
    reviewStatus: "needs_review",
  },
  not_found: {
    label: "Not Found",
    severity: "neutral",
    iconKey: "search-x",
    guidance: "The source document was searched and this field was not found.",
    defaultBlocking: false,
    className: "bg-slate-100 text-slate-600",
    reviewStatus: "missing",
  },
  missing: {
    label: "Missing",
    severity: "danger",
    iconKey: "missing",
    guidance: "The expected field value is absent.",
    defaultBlocking: true,
    className: "bg-red-100 text-red-700",
    reviewStatus: "missing",
  },
  missing_source_evidence: {
    label: "Missing Evidence",
    severity: "warning",
    iconKey: "file-warning",
    guidance: "A value exists or was proposed, but supporting source evidence is unavailable.",
    defaultBlocking: true,
    className: "bg-amber-100 text-amber-800",
    reviewStatus: "needs_review",
  },
  invalid: {
    label: "Invalid",
    severity: "danger",
    iconKey: "ban",
    guidance: "The proposed value failed validation and should not be silently defaulted.",
    defaultBlocking: true,
    className: "bg-red-100 text-red-700",
    reviewStatus: "needs_review",
  },
  legacy_fallback: {
    label: "Legacy Fallback",
    severity: "warning",
    iconKey: "history",
    guidance: "The value came from the legacy review payload because canonical coverage was unavailable.",
    defaultBlocking: false,
    className: "bg-blue-50 text-blue-700",
    reviewStatus: "auto_populated",
  },
  not_applicable: {
    label: "Not Applicable",
    severity: "neutral",
    iconKey: "minus",
    guidance: "This field has been marked as not applicable for this document.",
    defaultBlocking: false,
    className: "bg-slate-100 text-slate-600",
    reviewStatus: "missing",
  },
};

const LEGACY_ALIASES: Record<string, ReviewFieldStatus> = {
  auto_populated: "resolved",
  extracted: "resolved",
  draft_from_extraction: "resolved",
  draft: "resolved",
  approved: "resolved",
  accepted: "resolved",
  rejected: "invalid",
  manually_edited: "resolved_with_warning",
};

export function normalizeReviewFieldStatus(status: unknown): ReviewFieldStatus {
  const normalized = String(status || "missing").trim().toLowerCase();
  if (normalized in REVIEW_STATUS_PRESENTATION) return normalized as ReviewFieldStatus;
  return LEGACY_ALIASES[normalized] || "needs_review";
}

export function getReviewStatusPresentation(status: unknown): ReviewStatusPresentation {
  return REVIEW_STATUS_PRESENTATION[normalizeReviewFieldStatus(status)];
}

export function canonicalStatusToReviewStatus(status: unknown): string {
  return getReviewStatusPresentation(status).reviewStatus;
}

export function shouldUseCanonicalReviewPayload(response: any): boolean {
  return Boolean(response?.enterpriseReviewPayload && ["canonical_hybrid", "canonical_strict"].includes(response?.mode));
}

export const CANONICAL_REVIEW_STATUS_PRESENTATION = {
  resolved: { label: "Auto-populated", className: "bg-emerald-50 text-emerald-700", reviewStatus: "auto_populated" },
  resolved_with_warning: { label: "Needs Review", className: "bg-amber-100 text-amber-800", reviewStatus: "needs_review" },
  legacy_fallback: { label: "Legacy Fallback", className: "bg-blue-50 text-blue-700", reviewStatus: "auto_populated" },
  missing: { label: "Missing", className: "bg-slate-100 text-slate-600", reviewStatus: "missing" },
  conflict: { label: "Conflict", className: "bg-red-100 text-red-700", reviewStatus: "needs_review" },
  missing_source_evidence: { label: "Missing Evidence", className: "bg-amber-100 text-amber-800", reviewStatus: "needs_review" },
  invalid: { label: "Invalid", className: "bg-red-100 text-red-700", reviewStatus: "needs_review" },
  needs_review: { label: "Needs Review", className: "bg-amber-100 text-amber-800", reviewStatus: "needs_review" },
  auto_populated: { label: "Auto-populated", className: "bg-emerald-50 text-emerald-700", reviewStatus: "auto_populated" },
  missing_optional: { label: "Not Applicable", className: "bg-slate-100 text-slate-600", reviewStatus: "missing" },
  not_applicable: { label: "Not Applicable", className: "bg-slate-100 text-slate-600", reviewStatus: "missing" },
  rejected: { label: "Rejected", className: "bg-red-100 text-red-700", reviewStatus: "rejected" },
  manually_edited: { label: "Manually Edited", className: "bg-blue-50 text-blue-700", reviewStatus: "manually_edited" },
};

export function getReviewStatusPresentation(status) {
  return CANONICAL_REVIEW_STATUS_PRESENTATION[status] || CANONICAL_REVIEW_STATUS_PRESENTATION.missing;
}

export function canonicalStatusToReviewStatus(status) {
  return getReviewStatusPresentation(status).reviewStatus;
}

export function shouldUseCanonicalReviewPayload(response) {
  return Boolean(response?.enterpriseReviewPayload && ["canonical_hybrid", "canonical_strict"].includes(response?.mode));
}

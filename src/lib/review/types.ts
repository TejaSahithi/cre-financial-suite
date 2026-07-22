export type ReviewFieldStatus =
  | "resolved"
  | "resolved_with_warning"
  | "needs_review"
  | "conflict"
  | "not_found"
  | "missing"
  | "missing_source_evidence"
  | "invalid"
  | "legacy_fallback"
  | "not_applicable";

export type ReviewAuthoritativeSource =
  | "canonical_projection"
  | "legacy"
  | "legacy_fallback"
  | "reviewer_override"
  | "derived"
  | "none";

export type ReviewRolloutMode = "legacy" | "shadow" | "canonical_hybrid" | "canonical_strict";

export interface ReviewEvidenceViewModel {
  id: string;
  pageNumber: number | null;
  text: string | null;
  blockIds: string[];
  polygonAvailable: boolean;
  clauseCategory: string | null;
}

export interface ReviewConflictViewModel {
  selectedCandidateId: string | null;
  rejectedCandidateIds: string[];
  reasonCodes: string[];
  summary: string | null;
}

export interface ReviewFieldViewModel {
  key: string;
  path: string;
  label: string;
  domain: string;
  value: unknown;
  displayValue: string | null;
  status: ReviewFieldStatus;
  source: ReviewAuthoritativeSource;
  confidence: number | null;
  editable: boolean;
  requiresAttention: boolean;
  blocking: boolean;
  reasonCodes: string[];
  evidence: ReviewEvidenceViewModel[];
  conflict: ReviewConflictViewModel | null;
  derivation: unknown | null;
  lineage?: unknown | null;
  reviewerAction: {
    state: "none" | "accepted" | "overridden" | "cleared" | "not_applicable" | "follow_up";
    reason: string | null;
  };
}

export interface ReviewCoverageViewModel {
  configured: number;
  resolved: number;
  warning: number;
  needsReview: number;
  conflicts: number;
  missing: number;
  missingSourceEvidence: number;
  invalid: number;
  legacyFallbacks: number;
  blocking: number;
  percentage: number;
}

export interface ReviewApprovalViewModel {
  eligible: boolean;
  blockingCount: number;
  warningCount: number;
  conflictCount: number;
  missingRequiredCount: number;
  missingEvidenceCount: number;
  fallbackCount: number;
  overrideCount: number;
  reasons: string[];
}

export interface ReviewFindingViewModel {
  id: string;
  type: string;
  fieldKey: string | null;
  domain: string | null;
  severity: "informational" | "warning" | "material" | "blocking" | "critical";
  title: string;
  summary: string | null;
  reasonCodes: string[];
  reviewerActionRequired: boolean;
  resolutionStatus: string;
}

export interface ReviewSectionViewModel {
  key: string;
  label: string;
  order: number;
  fieldKeys: string[];
}

export interface ReviewDocumentViewModel {
  schemaVersion: "review-document-view-model-v1";
  uploadedFileId: string;
  runId: string | null;
  generationId: string | null;
  mode: ReviewRolloutMode;
  fields: Record<string, ReviewFieldViewModel>;
  sections: ReviewSectionViewModel[];
  findings: ReviewFindingViewModel[];
  coverage: ReviewCoverageViewModel;
  approval: ReviewApprovalViewModel;
  diagnostics: {
    backendSchemaVersion: string | null;
    payloadHash: string | null;
    registryVersion: string | null;
    fallbackCount: number;
    stale: boolean;
  };
}

export type ReviewFieldAction =
  | { type: "accept"; fieldKey: string }
  | { type: "override"; fieldKey: string; value: unknown; reason: string }
  | { type: "clear"; fieldKey: string; reason: string }
  | { type: "not_applicable"; fieldKey: string; reason: string }
  | { type: "follow_up"; fieldKey: string; reason: string };
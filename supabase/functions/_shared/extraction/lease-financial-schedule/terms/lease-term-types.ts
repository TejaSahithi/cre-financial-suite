// @ts-nocheck
export const LEASE_TERM_CANDIDATE_CONTRACT_VERSION = "lease-term-candidates-v1";

export const LEASE_TERM_TYPES = [
  "initial_term",
  "extension_term",
  "renewal_term",
  "option_term",
  "holdover_term",
  "construction_period",
  "rent_free_period",
  "partial_term",
  "unknown_term",
] as const;

export const LEASE_TERM_STATUSES = [
  "proposed",
  "valid",
  "ambiguous",
  "needs_review",
  "requires_related_document",
  "invalid",
  "superseded",
] as const;

export const LEASE_TERM_REVIEW_OPERATIONS = [
  "accept",
  "reject",
  "replace",
  "mark_requires_related_document",
  "reopen",
] as const;

export const LEASE_TERM_ORIGIN_TYPES = [
  "extracted",
  "reviewer",
  "derived",
  "calculated",
  "legacy_adapter",
  "system_projection",
] as const;

export type LeaseTermType = (typeof LEASE_TERM_TYPES)[number];
export type LeaseTermStatus = (typeof LEASE_TERM_STATUSES)[number];

export interface LeaseTermExpressionRef {
  id: string;
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  expressionStatus: string;
}

export interface LeaseTermCandidateInput {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  sourcePackageDocumentId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  sourceClaimIds?: string[];
  termType: string;
  termStatus: string;
  originType: string;
  instanceKey?: string | null;
  startExpressionId?: string | null;
  endExpressionId?: string | null;
  durationValue?: number | string | null;
  durationUnit?: string | null;
  durationInclusiveRule?: string | null;
  sequenceNumber?: number | string | null;
  parentTermId?: string | null;
  relatedDocumentRequirementId?: string | null;
  optionExerciseRequired?: boolean | null;
  automaticRenewal?: boolean | null;
  confidence?: number | null;
  producerType?: string | null;
  producerName?: string | null;
  producerVersion?: string | null;
  termContractVersion?: string | null;
  metadata?: unknown | null;
}

export interface LeaseTermValidationContext {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  activeGenerationId?: string | null;
  expressions: LeaseTermExpressionRef[];
}

export const LEASE_TERM_VALIDATION_ERROR_CODES = {
  LEASE_TERM_TYPE_INVALID: "LEASE_TERM_TYPE_INVALID",
  LEASE_TERM_STATUS_INVALID: "LEASE_TERM_STATUS_INVALID",
  LEASE_TERM_ORIGIN_INVALID: "LEASE_TERM_ORIGIN_INVALID",
  LEASE_TERM_CONTRACT_VERSION_MISMATCH: "LEASE_TERM_CONTRACT_VERSION_MISMATCH",
  LEASE_TERM_GENERATION_STALE: "LEASE_TERM_GENERATION_STALE",
  LEASE_TERM_START_EXPRESSION_MISSING: "LEASE_TERM_START_EXPRESSION_MISSING",
  LEASE_TERM_END_EXPRESSION_MISSING: "LEASE_TERM_END_EXPRESSION_MISSING",
  LEASE_TERM_EXPRESSION_CONTEXT_MISMATCH: "LEASE_TERM_EXPRESSION_CONTEXT_MISMATCH",
  LEASE_TERM_DURATION_UNIT_INVALID: "LEASE_TERM_DURATION_UNIT_INVALID",
  LEASE_TERM_DURATION_PAIR_INCOMPLETE: "LEASE_TERM_DURATION_PAIR_INCOMPLETE",
  LEASE_TERM_SEQUENCE_INVALID: "LEASE_TERM_SEQUENCE_INVALID",
  LEASE_TERM_RELATED_DOCUMENT_REQUIRED: "LEASE_TERM_RELATED_DOCUMENT_REQUIRED",
  LEASE_TERM_NO_RESOLUTION_ALLOWED: "LEASE_TERM_NO_RESOLUTION_ALLOWED",
} as const;

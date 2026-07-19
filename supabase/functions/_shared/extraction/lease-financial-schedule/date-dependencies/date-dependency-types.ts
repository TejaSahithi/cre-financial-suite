// @ts-nocheck
export const LEASE_DATE_DEPENDENCY_CONTRACT_VERSION = "lease-date-dependencies-v1";

export const DATE_DEPENDENCY_TYPES = [
  "anchor",
  "offset_anchor",
  "event_anchor",
  "alternative",
  "condition",
  "minimum_operand",
  "maximum_operand",
  "earlier_of_operand",
  "later_of_operand",
  "recurrence_anchor",
  "notice_anchor",
  "term_start",
  "term_end",
  "resolves",
  "supersedes_expression",
  "contextual",
] as const;

export const DATE_DEPENDENCY_STATUSES = [
  "proposed",
  "valid",
  "ambiguous",
  "needs_review",
  "requires_related_document",
  "invalid",
  "superseded",
] as const;

export const DATE_DEPENDENCY_REVIEW_OPERATIONS = [
  "accept",
  "reject",
  "replace",
  "select_ambiguous_anchor",
  "mark_requires_related_document",
  "reopen",
] as const;

export type DateDependencyType = (typeof DATE_DEPENDENCY_TYPES)[number];
export type DateDependencyStatus = (typeof DATE_DEPENDENCY_STATUSES)[number];
export type DateDependencyReviewOperation = (typeof DATE_DEPENDENCY_REVIEW_OPERATIONS)[number];

export interface DateDependencyExpressionRef {
  id: string;
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  expressionStatus: string;
}

export interface DateDependencyInput {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  sourceExpressionId: string;
  targetExpressionId?: string | null;
  dependencyType: string;
  dependencyStatus: string;
  operandRole?: string | null;
  operandOrder?: number | string | null;
  conditionKey?: string | null;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  relatedDocumentRequirementId?: string | null;
  producerType?: string | null;
  producerName?: string | null;
  producerVersion?: string | null;
  dependencyContractVersion?: string | null;
  metadata?: unknown | null;
}

export interface DateDependencyValidationContext {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  activeGenerationId?: string | null;
  expressions: DateDependencyExpressionRef[];
  existingDependencies?: DateDependencyInput[];
}

export const DATE_DEPENDENCY_VALIDATION_ERROR_CODES = {
  DATE_DEPENDENCY_TYPE_INVALID: "DATE_DEPENDENCY_TYPE_INVALID",
  DATE_DEPENDENCY_STATUS_INVALID: "DATE_DEPENDENCY_STATUS_INVALID",
  DATE_DEPENDENCY_SELF_REFERENCE: "DATE_DEPENDENCY_SELF_REFERENCE",
  DATE_DEPENDENCY_SOURCE_EXPRESSION_MISSING: "DATE_DEPENDENCY_SOURCE_EXPRESSION_MISSING",
  DATE_DEPENDENCY_TARGET_EXPRESSION_MISSING: "DATE_DEPENDENCY_TARGET_EXPRESSION_MISSING",
  DATE_DEPENDENCY_TARGET_REQUIRED: "DATE_DEPENDENCY_TARGET_REQUIRED",
  DATE_DEPENDENCY_CONTEXT_MISMATCH: "DATE_DEPENDENCY_CONTEXT_MISMATCH",
  DATE_DEPENDENCY_GENERATION_STALE: "DATE_DEPENDENCY_GENERATION_STALE",
  DATE_DEPENDENCY_STALE_TARGET: "DATE_DEPENDENCY_STALE_TARGET",
  DATE_DEPENDENCY_OPERAND_ORDER_REQUIRED: "DATE_DEPENDENCY_OPERAND_ORDER_REQUIRED",
  DATE_DEPENDENCY_CYCLE: "DATE_DEPENDENCY_CYCLE",
  DATE_DEPENDENCY_CONTRACT_VERSION_MISMATCH: "DATE_DEPENDENCY_CONTRACT_VERSION_MISMATCH",
  DATE_DEPENDENCY_RELATED_DOCUMENT_REQUIRED: "DATE_DEPENDENCY_RELATED_DOCUMENT_REQUIRED",
} as const;

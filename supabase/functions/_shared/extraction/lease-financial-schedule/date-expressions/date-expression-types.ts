// @ts-nocheck
export type DateExpressionType =
  | "fixed_date"
  | "event_date"
  | "relative_to_date"
  | "relative_to_event"
  | "earlier_of"
  | "later_of"
  | "minimum_of"
  | "maximum_of"
  | "dependent_date"
  | "recurring_deadline"
  | "notice_window"
  | "unresolved_expression";

export type DateExpressionOrigin =
  | "extracted"
  | "reviewer"
  | "derived"
  | "calculated"
  | "legacy_adapter"
  | "system_projection";

export type DateExpressionStatus =
  | "extracted"
  | "unresolved"
  | "ambiguous"
  | "needs_review"
  | "manual_required"
  | "requires_related_document"
  | "not_present"
  | "not_applicable"
  | "unreadable"
  | "extraction_failed";

export type DateExpressionValidationStatus = "pending" | "valid" | "invalid" | "needs_review";

export type DateExpressionOffsetUnit = "day" | "business_day" | "week" | "month" | "year";

export type DateExpressionOffsetDirection = "before" | "after";

export type DateExpressionBusinessDayRule =
  | "none"
  | "next_business_day"
  | "previous_business_day"
  | "nearest_business_day";

export type DateExpressionSourceLinkRole =
  | "primary_source"
  | "anchor_source"
  | "offset_source"
  | "condition_source"
  | "corroborating_source"
  | "contradictory_source"
  | "contextual_source";

export interface DateExpressionRegistryEntry {
  expressionType: DateExpressionType;
  displayName: string;
  description: string;
  requiredComponents: string[];
  allowedAnchorTypes: string[];
  operandsPermitted: boolean;
  offsetsPermitted: boolean;
  recurrencePermitted: boolean;
  requiresDependencyProcessing: boolean;
  fixedResolvedDatePermitted: boolean;
  validationRules: string[];
  introducedIn: string;
}

export interface DateExpressionSourceClaimRef {
  id: string;
  orgId: string;
  uploadedFileId?: string | null;
  extractionRunId?: string | null;
  generationId?: string | null;
  packageId?: string | null;
  packageDocumentId?: string | null;
  packageEffectiveClaimId?: string | null;
  activeGenerationId?: string | null;
}

export interface DateExpressionCandidateInput {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  sourcePackageDocumentId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  sourceClaimId?: string | null;
  sourceClaimIds?: string[];
  conceptKey: string;
  scopeKey?: string;
  instanceKey?: string;
  expressionType: string;
  expressionStatus: DateExpressionStatus;
  originType: DateExpressionOrigin;
  explicitDate?: string | null;
  eventKey?: string | null;
  anchorConceptKey?: string | null;
  anchorExpressionId?: string | null;
  offsetValue?: number | string | null;
  offsetUnit?: DateExpressionOffsetUnit | string | null;
  offsetDirection?: DateExpressionOffsetDirection | string | null;
  businessDayRule?: DateExpressionBusinessDayRule | string | null;
  operands?: unknown[] | null;
  recurrenceDefinition?: unknown | null;
  conditionDefinition?: unknown | null;
  normalizedExpression?: unknown | null;
  confidence?: number | null;
  producerType?: string | null;
  producerName?: string | null;
  producerVersion?: string | null;
  extractionStageRunId?: string | null;
  providerInvocationId?: string | null;
  registryVersion: string;
  registryHash: string;
  validationStatus?: DateExpressionValidationStatus;
  derivationDefinition?: unknown | null;
  calculationFormulaKey?: string | null;
  calculationVersion?: string | null;
}

export interface DateExpressionValidationContext {
  orgId: string;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  packageId?: string | null;
  activeGenerationId?: string | null;
  sourceClaims?: DateExpressionSourceClaimRef[];
  expectedRegistryVersion: string;
  expectedRegistryHash: string;
}

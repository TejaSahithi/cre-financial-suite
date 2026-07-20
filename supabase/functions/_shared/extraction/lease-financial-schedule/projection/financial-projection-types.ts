// @ts-nocheck
import type { CompatibilityExtractionData } from "../../claims/adapters/compatibility-payload-builder.ts";

export const FINANCIAL_PROJECTION_RUN_STATUSES = ["running", "completed", "completed_with_warnings", "needs_review", "failed", "superseded"] as const;
export const FINANCIAL_PROJECTION_FIELD_STATUSES = ["available", "needs_review", "manual_required", "ambiguous", "requires_related_document", "not_present", "not_applicable", "unreadable", "extraction_failed", "unresolved"] as const;
export const FINANCIAL_PROJECTION_VALUE_ORIGINS = ["extracted", "inherited", "reviewer", "derived", "calculated", "stated_and_validated", "stated_calculated_mismatch", "unresolved", "requires_related_document"] as const;
export const FINANCIAL_PROJECTION_DIFF_CLASSIFICATIONS = [
  "equal", "representation_only", "extracted_value_added", "calculated_value_added", "date_resolved", "date_remains_unresolved", "term_resolved", "rent_schedule_enriched", "annualized_vs_billed_corrected", "free_rent_applied", "escalation_calculated", "deposit_reconciled", "amortization_validated", "stated_calculated_match", "stated_calculated_mismatch", "formula_unresolved", "related_document_required", "financial_conflict", "missing_in_p4_projection", "extra_in_p4_projection", "evidence_mismatch", "status_mismatch", "ordering_mismatch",
] as const;

export type FinancialProjectionStatus = typeof FINANCIAL_PROJECTION_FIELD_STATUSES[number];
export type FinancialProjectionValueOrigin = typeof FINANCIAL_PROJECTION_VALUE_ORIGINS[number];
export type FinancialProjectionDiffClassification = typeof FINANCIAL_PROJECTION_DIFF_CLASSIFICATIONS[number];

export interface FinancialProjectionContext {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  generationId: string;
  activeGenerationId?: string | null;
  calculationRunId?: string | null;
  projectionRunId?: string | null;
  mode?: "off" | "shadow" | "active";
}

export interface FinancialProjectionRunInput {
  id?: string | null;
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  calculationRunId: string;
  generationId: string;
  calculationVersion: string;
  status: string;
  inputHash: string;
  completedAt?: string | null;
}

export interface FinancialFieldProjection {
  fieldKey: string;
  compatibilityFieldKey?: string | null;
  conceptKey: string;
  instanceKey: string;
  projectionStatus: FinancialProjectionStatus;
  valueOrigin: FinancialProjectionValueOrigin;
  normalizedValue: unknown | null;
  displayValue: string | null;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  sourceDateExpressionId?: string | null;
  sourceCalculationResultId?: string | null;
  statedSourceResultId?: string | null;
  calculatedSourceResultId?: string | null;
  confidence?: number | null;
  evidenceSummary?: Record<string, unknown> | null;
  validationCodes: string[];
  conflictId?: string | null;
  relatedDocumentRequirementId?: string | null;
  formulaKey?: string | null;
  formulaVersion?: string | null;
  assumptions?: Record<string, unknown> | null;
  roundingPolicy?: string | null;
  amountRole?: string | null;
  internalOnly?: boolean;
}

export interface FinancialScheduleProjection {
  scheduleType: string;
  scheduleKey: string;
  scheduleStatus: FinancialProjectionStatus;
  sourceScheduleCandidateId?: string | null;
  sourceCalculationResultId?: string | null;
  sequenceNumber?: number | null;
  startDate?: string | null;
  endDate?: string | null;
  startTermMonth?: number | null;
  endTermMonth?: number | null;
  amountRole?: string | null;
  amount?: string | number | null;
  currencyCode?: string | null;
  frequency?: string | null;
  billingStatus?: string | null;
  valueOrigin: FinancialProjectionValueOrigin;
  formulaKey?: string | null;
  validationCodes: string[];
  conflictId?: string | null;
}

export interface FinancialCompatibilityProjectionCandidate {
  fieldProjections: FinancialFieldProjection[];
  scheduleProjections: FinancialScheduleProjection[];
  compatibilitySlice: CompatibilityExtractionData;
  metadata: {
    outputFieldCount: number;
    outputScheduleCount: number;
    calculatedFieldCount: number;
    unresolvedFieldCount: number;
    conflictCount: number;
    relatedDocumentCount: number;
  };
}

export interface FinancialProjectionDiffResult {
  fieldKey: string;
  classification: FinancialProjectionDiffClassification;
  currentValue?: unknown;
  p4Value?: unknown;
  detail?: string | null;
}

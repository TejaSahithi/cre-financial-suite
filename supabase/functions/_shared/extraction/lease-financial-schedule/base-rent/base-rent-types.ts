// @ts-nocheck
export const LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION = "lease-base-rent-schedules-v1";
export const LEASE_BASE_RENT_PERIOD_CONTRACT_VERSION = "lease-base-rent-periods-v1";
export const LEASE_BASE_RENT_AMOUNT_CONTRACT_VERSION = "lease-base-rent-amounts-v1";
export const LEASE_BASE_RENT_ESCALATION_CONTRACT_VERSION = "lease-base-rent-escalations-v1";
export const LEASE_BASE_RENT_CONFLICT_CONTRACT_VERSION = "lease-base-rent-conflicts-v1";

export const BASE_RENT_SCHEDULE_TYPES = [
  "stated_period_schedule",
  "fixed_step_schedule",
  "fixed_increase_schedule",
  "percentage_increase_schedule",
  "cpi_linked_schedule",
  "formula_schedule",
  "mixed_schedule",
  "unresolved_schedule",
] as const;

export const BASE_RENT_SCHEDULE_STATUSES = [
  "extracted",
  "unresolved",
  "ambiguous",
  "needs_review",
  "manual_required",
  "requires_related_document",
  "not_present",
  "not_applicable",
  "unreadable",
  "extraction_failed",
] as const;

export const BASE_RENT_ORIGIN_TYPES = [
  "extracted",
  "reviewer",
  "derived",
  "calculated",
  "legacy_adapter",
  "system_projection",
] as const;

export const BASE_RENT_SCHEDULE_BASES = [
  "explicit_periods",
  "term_month_range",
  "date_expression_range",
  "free_rent",
  "abatement",
  "escalation_instruction",
  "mixed",
  "unknown",
] as const;

export const BASE_RENT_PERIOD_TYPES = [
  "standard_rent_period",
  "free_rent_period",
  "partial_period",
  "holdover_period",
  "unresolved_period",
] as const;

export const BASE_RENT_BILLING_STATUSES = [
  "billed",
  "fully_abated",
  "partially_abated",
  "not_yet_determined",
  "not_applicable",
] as const;

export const BASE_RENT_ABATEMENT_TYPES = [
  "full",
  "partial",
  "delayed_commencement",
  "stated_credit",
  "unknown",
] as const;

export const BASE_RENT_AMOUNT_ROLES = [
  "billed_base_rent",
  "stated_monthly_rent",
  "stated_annual_rent",
  "annualized_reference",
  "stated_psf_rate",
  "abatement_amount",
  "partial_period_amount",
  "unresolved_amount",
] as const;

export const BASE_RENT_AMOUNT_BASES = [
  "fixed_amount",
  "per_month",
  "per_year",
  "per_square_foot_per_year",
  "per_square_foot_per_month",
  "per_day",
  "percentage",
  "formula_based",
  "unknown",
] as const;

export const BASE_RENT_FREQUENCIES = [
  "monthly",
  "annually",
  "quarterly",
  "weekly",
  "daily",
  "one_time",
  "irregular",
  "unknown",
] as const;

export const BASE_RENT_ESCALATION_TYPES = [
  "stated_next_amount",
  "fixed_amount_increase",
  "fixed_percentage_increase",
  "cpi_adjustment",
  "periodic_step",
  "custom_formula",
  "unresolved_escalation",
] as const;

export const BASE_RENT_LINK_ROLES = [
  "schedule_source",
  "period_boundary_source",
  "amount_source",
  "rate_source",
  "area_source",
  "escalation_source",
  "abatement_source",
  "corroborating_source",
  "contradictory_source",
  "contextual_source",
] as const;

export const BASE_RENT_CONFLICT_TYPES = [
  "overlapping_periods",
  "conflicting_period_amounts",
  "conflicting_period_boundaries",
  "multiple_schedule_candidates",
  "amendment_sequence_ambiguous",
  "escalation_instruction_conflict",
  "frequency_basis_conflict",
  "annualized_vs_billed_role_conflict",
  "stale_generation_candidate",
  "missing_related_document",
] as const;

export const BASE_RENT_REVIEW_OPERATIONS = [
  "accept_schedule",
  "reject_schedule",
  "replace_schedule",
  "accept_period",
  "reject_period",
  "correct_period_boundaries",
  "classify_annualized_vs_billed",
  "select_conflicting_amount",
  "mark_schedule_incomplete",
  "mark_requires_related_document",
  "reopen",
] as const;

export interface BaseRentContextRef {
  id: string;
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId?: string | null;
  extractionRunId?: string | null;
  generationId: string;
  status?: string | null;
}

export interface BaseRentScheduleInput {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  sourcePackageDocumentId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  termCandidateId?: string | null;
  instanceKey?: string | null;
  scheduleStatus: string;
  originType: string;
  scheduleType: string;
  currencyCode?: string | null;
  scheduleBasis: string;
  sequencePolicy?: string | null;
  startExpressionId?: string | null;
  endExpressionId?: string | null;
  sourceClaimIds?: string[];
  producerType?: string | null;
  producerName?: string | null;
  producerVersion?: string | null;
  extractionStageRunId?: string | null;
  providerInvocationId?: string | null;
  confidence?: number | null;
  scheduleContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BaseRentPeriodInput {
  orgId: string;
  scheduleCandidateId?: string | null;
  scheduleKey: string;
  leaseId?: string | null;
  packageId?: string | null;
  generationId: string;
  periodStatus: string;
  periodType: string;
  sequenceNumber?: number | string | null;
  startExpressionId?: string | null;
  endExpressionId?: string | null;
  startTermMonth?: number | string | null;
  endTermMonth?: number | string | null;
  termCandidateId?: string | null;
  billingStatus: string;
  abatementType?: string | null;
  partialPeriodRule?: string | null;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  confidence?: number | null;
  periodContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface BaseRentAmountInput {
  orgId: string;
  scheduleKey: string;
  periodKey: string;
  generationId: string;
  amountRole: string;
  statedAmount?: number | string | null;
  currencyCode?: string | null;
  frequency?: string | null;
  amountBasis: string;
  areaValue?: number | string | null;
  areaUnit?: string | null;
  rateValue?: number | string | null;
  rateUnit?: string | null;
  amountStatus: string;
  originType: string;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  formulaCandidateId?: string | null;
  confidence?: number | null;
  amountContractVersion?: string | null;
}

export interface BaseRentEscalationInput {
  orgId: string;
  scheduleKey: string;
  generationId: string;
  escalationType: string;
  appliesAfterPeriodKey?: string | null;
  effectiveExpressionId?: string | null;
  effectiveTermMonth?: number | string | null;
  increaseAmount?: number | string | null;
  increasePercentage?: number | string | null;
  indexName?: string | null;
  floorPercentage?: number | string | null;
  ceilingPercentage?: number | string | null;
  frequency?: string | null;
  recurrenceDefinition?: Record<string, unknown> | null;
  formulaDefinition?: Record<string, unknown> | null;
  escalationStatus: string;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  escalationContractVersion?: string | null;
}

export interface BaseRentValidationContext {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  activeGenerationId?: string | null;
  dateExpressions?: BaseRentContextRef[];
  termCandidates?: BaseRentContextRef[];
  sourceClaims?: BaseRentContextRef[];
  packageEffectiveClaims?: BaseRentContextRef[];
}

export const BASE_RENT_VALIDATION_ERROR_CODES = {
  RENT_SCHEDULE_CONTEXT_INVALID: "RENT_SCHEDULE_CONTEXT_INVALID",
  RENT_SCHEDULE_GENERATION_STALE: "RENT_SCHEDULE_GENERATION_STALE",
  RENT_SCHEDULE_TYPE_INVALID: "RENT_SCHEDULE_TYPE_INVALID",
  RENT_SCHEDULE_STATUS_INVALID: "RENT_SCHEDULE_STATUS_INVALID",
  RENT_SCHEDULE_ORIGIN_INVALID: "RENT_SCHEDULE_ORIGIN_INVALID",
  RENT_SCHEDULE_BASIS_INVALID: "RENT_SCHEDULE_BASIS_INVALID",
  RENT_SCHEDULE_CONTRACT_VERSION_MISMATCH: "RENT_SCHEDULE_CONTRACT_VERSION_MISMATCH",
  RENT_PRODUCER_PROVENANCE_INVALID: "RENT_PRODUCER_PROVENANCE_INVALID",
  RENT_PERIOD_RANGE_INVALID: "RENT_PERIOD_RANGE_INVALID",
  RENT_PERIOD_OVERLAP: "RENT_PERIOD_OVERLAP",
  RENT_PERIOD_GAP: "RENT_PERIOD_GAP",
  RENT_PERIOD_TYPE_INVALID: "RENT_PERIOD_TYPE_INVALID",
  RENT_PERIOD_STATUS_INVALID: "RENT_PERIOD_STATUS_INVALID",
  RENT_PERIOD_BILLING_STATUS_INVALID: "RENT_PERIOD_BILLING_STATUS_INVALID",
  RENT_PERIOD_ABATEMENT_INVALID: "RENT_PERIOD_ABATEMENT_INVALID",
  RENT_AMOUNT_ROLE_INVALID: "RENT_AMOUNT_ROLE_INVALID",
  RENT_AMOUNT_BASIS_INVALID: "RENT_AMOUNT_BASIS_INVALID",
  RENT_AMOUNT_FREQUENCY_INVALID: "RENT_AMOUNT_FREQUENCY_INVALID",
  RENT_AMOUNT_CURRENCY_INVALID: "RENT_AMOUNT_CURRENCY_INVALID",
  RENT_AMOUNT_SOURCE_MISSING: "RENT_AMOUNT_SOURCE_MISSING",
  RENT_ANNUALIZED_BILLED_CONFLATION: "RENT_ANNUALIZED_BILLED_CONFLATION",
  RENT_PSF_CONVERSION_NOT_ALLOWED: "RENT_PSF_CONVERSION_NOT_ALLOWED",
  RENT_NEGATIVE_AMOUNT_NEEDS_REVIEW: "RENT_NEGATIVE_AMOUNT_NEEDS_REVIEW",
  RENT_ESCALATION_INPUT_INVALID: "RENT_ESCALATION_INPUT_INVALID",
  RENT_ESCALATION_TYPE_INVALID: "RENT_ESCALATION_TYPE_INVALID",
  RENT_ESCALATION_EXPANSION_NOT_ALLOWED: "RENT_ESCALATION_EXPANSION_NOT_ALLOWED",
  RENT_SCHEDULE_CONFLICT_OPEN: "RENT_SCHEDULE_CONFLICT_OPEN",
  RENT_RELATED_DOCUMENT_MISSING: "RENT_RELATED_DOCUMENT_MISSING",
  RENT_NO_CALCULATION_ALLOWED: "RENT_NO_CALCULATION_ALLOWED",
} as const;

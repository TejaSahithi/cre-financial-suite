// @ts-nocheck
export const LEASE_FINANCIAL_CHARGE_CONTRACT_VERSION = "lease-financial-charge-candidates-v1";
export const LEASE_FINANCIAL_CHARGE_PERIOD_CONTRACT_VERSION = "lease-financial-charge-periods-v1";
export const LEASE_FINANCIAL_CHARGE_AMOUNT_CONTRACT_VERSION = "lease-financial-charge-amounts-v1";
export const LEASE_FINANCIAL_DEPOSIT_COMPONENT_CONTRACT_VERSION = "lease-financial-deposit-components-v1";
export const LEASE_FINANCIAL_AMORTIZATION_CONTRACT_VERSION = "lease-financial-amortization-candidates-v1";
export const LEASE_FINANCIAL_FORMULA_CONTRACT_VERSION = "lease-financial-formulas-v1";
export const LEASE_FINANCIAL_CHARGE_CONFLICT_CONTRACT_VERSION = "lease-financial-charge-conflicts-v1";

export const FINANCIAL_CHARGE_STATUSES = [
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

export const FINANCIAL_CHARGE_ORIGIN_TYPES = [
  "extracted",
  "reviewer",
  "derived",
  "legacy_adapter",
  "system_projection",
] as const;

export const FINANCIAL_CHARGE_PRODUCER_TYPES = [
  "deterministic_mapper",
  "semantic_extractor",
  "validation_engine",
  "legacy_adapter",
  "reviewer",
  "system_projection",
] as const;

export const FINANCIAL_CHARGE_DOMAINS = [
  "additional_charge",
  "deposit_or_prepayment",
  "allowance_or_contribution",
  "reimbursement",
  "formula_instruction",
  "amortization_instruction",
  "percentage_rent",
  "credit_or_offset",
  "unresolved",
] as const;

export const FINANCIAL_CHARGE_ROLES = [
  "tenant_payable",
  "landlord_payable",
  "credit_to_tenant",
  "escrow_or_deposit",
  "formula_only",
  "unresolved",
] as const;

export const FINANCIAL_CHARGE_TYPES = [
  "additional_rent",
  "percentage_rent",
  "recurring_charge",
  "one_time_charge",
  "cam_estimate",
  "operating_expense_estimate",
  "tax_estimate",
  "insurance_estimate",
  "utility_charge",
  "management_fee",
  "administrative_fee",
  "security_deposit",
  "prepaid_rent",
  "deposit_component",
  "tenant_improvement_allowance",
  "landlord_contribution",
  "reimbursement",
  "amortized_improvement_charge",
  "equipment_charge",
  "late_fee",
  "holdover_charge",
  "credit",
  "unresolved_charge",
] as const;

export const FINANCIAL_CHARGE_FREQUENCIES = [
  "monthly",
  "annually",
  "quarterly",
  "weekly",
  "daily",
  "one_time",
  "per_occurrence",
  "percentage_rent_period",
  "amortization_period",
  "irregular",
  "unknown",
] as const;

export const FINANCIAL_CHARGE_AMOUNT_ROLES = [
  "stated_amount",
  "estimated_amount",
  "billed_amount",
  "deposit_amount",
  "prepaid_amount",
  "allowance_amount",
  "contribution_amount",
  "reimbursement_amount",
  "credit_amount",
  "principal_amount",
  "payment_amount",
  "stated_rate",
  "threshold_amount",
  "percentage_rate",
  "formula_input",
  "formula_output_placeholder",
  "unresolved_amount",
] as const;

export const FINANCIAL_CHARGE_AMOUNT_BASES = [
  "fixed_amount",
  "per_month",
  "per_year",
  "per_square_foot_per_year",
  "per_square_foot_per_month",
  "per_occurrence",
  "percentage",
  "percentage_of_sales",
  "formula_based",
  "principal",
  "payment",
  "unknown",
] as const;

export const FINANCIAL_CHARGE_ESTIMATE_STATUSES = [
  "stated_estimate",
  "stated_final",
  "true_up_pending",
  "unresolved",
  "not_applicable",
] as const;

export const FINANCIAL_DEPOSIT_COMPONENT_TYPES = [
  "cash_deposit",
  "letter_of_credit",
  "prepaid_rent",
  "additional_security",
  "applied_credit",
  "unresolved_component",
] as const;

export const FINANCIAL_DEPOSIT_ALLOCATION_ROLES = [
  "security_deposit_portion",
  "prepaid_rent_portion",
  "restoration_reserve",
  "utility_deposit",
  "other_deposit_portion",
  "unresolved_allocation",
] as const;

export const FINANCIAL_AMORTIZATION_TYPES = [
  "tenant_improvement_repayment",
  "landlord_work_reimbursement",
  "equipment_cost_recovery",
  "amortized_free_rent",
  "unresolved_amortization",
] as const;

export const FINANCIAL_AMORTIZATION_STATUSES = [
  "explicit_instruction",
  "partial_instruction",
  "needs_review",
  "unresolved",
  "not_applicable",
] as const;

export const FINANCIAL_FORMULA_TYPES = [
  "percentage_rent_formula",
  "index_formula",
  "gross_up_formula",
  "cap_floor_formula",
  "reconciliation_formula",
  "custom_charge_formula",
  "unresolved_formula",
] as const;

export const FINANCIAL_FORMULA_STATUSES = [
  "explicit_formula",
  "partial_formula",
  "needs_review",
  "requires_external_data",
  "unresolved",
  "not_applicable",
] as const;

export const FINANCIAL_CHARGE_LINK_ROLES = [
  "charge_source",
  "amount_source",
  "period_source",
  "formula_source",
  "amortization_source",
  "deposit_component_source",
  "corroborating_source",
  "contradictory_source",
  "contextual_source",
] as const;

export const FINANCIAL_CHARGE_CONFLICT_TYPES = [
  "conflicting_charge_type",
  "conflicting_amounts",
  "conflicting_periods",
  "estimate_vs_final_conflict",
  "deposit_component_total_conflict",
  "allowance_responsibility_conflict",
  "formula_term_conflict",
  "amortization_instruction_conflict",
  "percentage_rent_basis_conflict",
  "missing_related_document",
] as const;

export const FINANCIAL_CHARGE_REVIEW_OPERATIONS = [
  "accept_charge",
  "reject_charge",
  "replace_charge",
  "accept_amount",
  "reject_amount",
  "select_conflicting_amount",
  "classify_estimate_vs_final",
  "correct_charge_type",
  "accept_formula_instruction",
  "reject_formula_instruction",
  "accept_amortization_instruction",
  "reject_amortization_instruction",
  "mark_requires_related_document",
  "reopen",
] as const;

export interface FinancialChargeContextRef {
  id: string;
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId?: string | null;
  extractionRunId?: string | null;
  generationId: string;
  status?: string | null;
}

export interface FinancialChargeInput {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  sourcePackageDocumentId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  baseRentScheduleCandidateId?: string | null;
  instanceKey?: string | null;
  chargeType: string;
  chargeDomain: string;
  financialRole: string;
  chargeStatus: string;
  originType: string;
  currencyCode?: string | null;
  frequency?: string | null;
  estimateStatus?: string | null;
  startExpressionId?: string | null;
  endExpressionId?: string | null;
  sourceClaimIds?: string[];
  producerType?: string | null;
  producerName?: string | null;
  producerVersion?: string | null;
  extractionStageRunId?: string | null;
  providerInvocationId?: string | null;
  confidence?: number | null;
  registryVersion?: string | null;
  registryHash?: string | null;
  chargeContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FinancialChargePeriodInput {
  orgId: string;
  chargeKey: string;
  leaseId?: string | null;
  packageId?: string | null;
  generationId: string;
  periodStatus: string;
  sequenceNumber?: number | string | null;
  startExpressionId?: string | null;
  endExpressionId?: string | null;
  startTermMonth?: number | string | null;
  endTermMonth?: number | string | null;
  termCandidateId?: string | null;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  periodContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FinancialChargeAmountInput {
  orgId: string;
  chargeKey: string;
  periodKey?: string | null;
  generationId: string;
  amountRole: string;
  amountBasis: string;
  statedAmount?: number | string | null;
  currencyCode?: string | null;
  frequency?: string | null;
  rateValue?: number | string | null;
  rateUnit?: string | null;
  areaValue?: number | string | null;
  areaUnit?: string | null;
  amountStatus: string;
  originType: string;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  formulaCandidateId?: string | null;
  amountContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FinancialDepositComponentInput {
  orgId: string;
  parentChargeKey: string;
  componentKeySeed?: string | null;
  generationId: string;
  componentType: string;
  allocationRole: string;
  amountRole: string;
  statedAmount?: number | string | null;
  currencyCode?: string | null;
  componentStatus: string;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  componentContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FinancialAmortizationInput {
  orgId: string;
  chargeKey: string;
  generationId: string;
  amortizationType: string;
  amortizationStatus: string;
  principalAmountId?: string | null;
  paymentAmountId?: string | null;
  interestRateAmountId?: string | null;
  termExpressionId?: string | null;
  startExpressionId?: string | null;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  amortizationContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FinancialFormulaInput {
  orgId: string;
  chargeKey: string;
  generationId: string;
  formulaType: string;
  formulaStatus: string;
  formulaText?: string | null;
  inputAmountIds?: string[];
  outputAmountRole?: string | null;
  sourceClaimId?: string | null;
  sourcePackageEffectiveClaimId?: string | null;
  formulaContractVersion?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface FinancialChargeValidationContext {
  orgId: string;
  leaseId?: string | null;
  packageId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  activeGenerationId?: string | null;
  dateExpressions?: FinancialChargeContextRef[];
  termCandidates?: FinancialChargeContextRef[];
  sourceClaims?: FinancialChargeContextRef[];
  packageEffectiveClaims?: FinancialChargeContextRef[];
  baseRentScheduleCandidates?: FinancialChargeContextRef[];
  chargeCandidates?: FinancialChargeContextRef[];
}

export const FINANCIAL_CHARGE_VALIDATION_ERROR_CODES = {
  CHARGE_CONTEXT_INVALID: "CHARGE_CONTEXT_INVALID",
  CHARGE_GENERATION_STALE: "CHARGE_GENERATION_STALE",
  CHARGE_TYPE_INVALID: "CHARGE_TYPE_INVALID",
  CHARGE_STATUS_INVALID: "CHARGE_STATUS_INVALID",
  CHARGE_ORIGIN_INVALID: "CHARGE_ORIGIN_INVALID",
  CHARGE_DOMAIN_INVALID: "CHARGE_DOMAIN_INVALID",
  CHARGE_ROLE_INVALID: "CHARGE_ROLE_INVALID",
  CHARGE_FREQUENCY_INVALID: "CHARGE_FREQUENCY_INVALID",
  CHARGE_ESTIMATE_STATUS_INVALID: "CHARGE_ESTIMATE_STATUS_INVALID",
  CHARGE_CONTRACT_VERSION_MISMATCH: "CHARGE_CONTRACT_VERSION_MISMATCH",
  CHARGE_REGISTRY_MISMATCH: "CHARGE_REGISTRY_MISMATCH",
  CHARGE_PRODUCER_PROVENANCE_INVALID: "CHARGE_PRODUCER_PROVENANCE_INVALID",
  CHARGE_SOURCE_MISSING: "CHARGE_SOURCE_MISSING",
  CHARGE_BASE_RENT_CONFLATION: "CHARGE_BASE_RENT_CONFLATION",
  CHARGE_TYPE_ROLE_MISMATCH: "CHARGE_TYPE_ROLE_MISMATCH",
  CHARGE_TYPE_DOMAIN_MISMATCH: "CHARGE_TYPE_DOMAIN_MISMATCH",
  CHARGE_ESTIMATE_FINAL_CONFLATION: "CHARGE_ESTIMATE_FINAL_CONFLATION",
  CHARGE_PERIOD_RANGE_INVALID: "CHARGE_PERIOD_RANGE_INVALID",
  CHARGE_PERIOD_OVERLAP: "CHARGE_PERIOD_OVERLAP",
  CHARGE_AMOUNT_ROLE_INVALID: "CHARGE_AMOUNT_ROLE_INVALID",
  CHARGE_AMOUNT_BASIS_INVALID: "CHARGE_AMOUNT_BASIS_INVALID",
  CHARGE_AMOUNT_CURRENCY_INVALID: "CHARGE_AMOUNT_CURRENCY_INVALID",
  CHARGE_NEGATIVE_AMOUNT_NEEDS_REVIEW: "CHARGE_NEGATIVE_AMOUNT_NEEDS_REVIEW",
  CHARGE_DEPOSIT_COMPONENT_INVALID: "CHARGE_DEPOSIT_COMPONENT_INVALID",
  CHARGE_AMORTIZATION_INPUT_INVALID: "CHARGE_AMORTIZATION_INPUT_INVALID",
  CHARGE_FORMULA_INPUT_INVALID: "CHARGE_FORMULA_INPUT_INVALID",
  CHARGE_NO_CALCULATION_ALLOWED: "CHARGE_NO_CALCULATION_ALLOWED",
} as const;

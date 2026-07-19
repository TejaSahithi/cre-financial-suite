// @ts-nocheck
import {
  LEASE_FINANCIAL_CHARGE_REGISTRY_HASH,
  LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION,
} from "./financial-charge-registry-version.ts";
import { getFinancialChargeRegistryEntry } from "./financial-charge-registry.ts";
import {
  FINANCIAL_AMORTIZATION_STATUSES,
  FINANCIAL_AMORTIZATION_TYPES,
  FINANCIAL_CHARGE_AMOUNT_BASES,
  FINANCIAL_CHARGE_AMOUNT_ROLES,
  FINANCIAL_CHARGE_DOMAINS,
  FINANCIAL_CHARGE_ESTIMATE_STATUSES,
  FINANCIAL_CHARGE_FREQUENCIES,
  FINANCIAL_CHARGE_ORIGIN_TYPES,
  FINANCIAL_CHARGE_PRODUCER_TYPES,
  FINANCIAL_CHARGE_ROLES,
  FINANCIAL_CHARGE_STATUSES,
  FINANCIAL_CHARGE_VALIDATION_ERROR_CODES,
  FINANCIAL_DEPOSIT_ALLOCATION_ROLES,
  FINANCIAL_DEPOSIT_COMPONENT_TYPES,
  FINANCIAL_FORMULA_STATUSES,
  FINANCIAL_FORMULA_TYPES,
  LEASE_FINANCIAL_AMORTIZATION_CONTRACT_VERSION,
  LEASE_FINANCIAL_CHARGE_AMOUNT_CONTRACT_VERSION,
  LEASE_FINANCIAL_CHARGE_CONTRACT_VERSION,
  LEASE_FINANCIAL_CHARGE_PERIOD_CONTRACT_VERSION,
  LEASE_FINANCIAL_DEPOSIT_COMPONENT_CONTRACT_VERSION,
  LEASE_FINANCIAL_FORMULA_CONTRACT_VERSION,
  type FinancialAmortizationInput,
  type FinancialChargeAmountInput,
  type FinancialChargeContextRef,
  type FinancialChargeInput,
  type FinancialChargePeriodInput,
  type FinancialChargeValidationContext,
  type FinancialDepositComponentInput,
  type FinancialFormulaInput,
} from "./financial-charge-types.ts";

const STATUS_SET = new Set(FINANCIAL_CHARGE_STATUSES);
const ORIGIN_SET = new Set(FINANCIAL_CHARGE_ORIGIN_TYPES);
const PRODUCER_SET = new Set(FINANCIAL_CHARGE_PRODUCER_TYPES);
const DOMAIN_SET = new Set(FINANCIAL_CHARGE_DOMAINS);
const ROLE_SET = new Set(FINANCIAL_CHARGE_ROLES);
const FREQUENCY_SET = new Set(FINANCIAL_CHARGE_FREQUENCIES);
const ESTIMATE_STATUS_SET = new Set(FINANCIAL_CHARGE_ESTIMATE_STATUSES);
const AMOUNT_ROLE_SET = new Set(FINANCIAL_CHARGE_AMOUNT_ROLES);
const AMOUNT_BASIS_SET = new Set(FINANCIAL_CHARGE_AMOUNT_BASES);
const DEPOSIT_COMPONENT_TYPE_SET = new Set(FINANCIAL_DEPOSIT_COMPONENT_TYPES);
const DEPOSIT_ALLOCATION_ROLE_SET = new Set(FINANCIAL_DEPOSIT_ALLOCATION_ROLES);
const AMORTIZATION_TYPE_SET = new Set(FINANCIAL_AMORTIZATION_TYPES);
const AMORTIZATION_STATUS_SET = new Set(FINANCIAL_AMORTIZATION_STATUSES);
const FORMULA_TYPE_SET = new Set(FINANCIAL_FORMULA_TYPES);
const FORMULA_STATUS_SET = new Set(FINANCIAL_FORMULA_STATUSES);
const INACTIVE_SOURCE_STATUSES = new Set(["not_present", "not_applicable", "unreadable", "extraction_failed", "superseded"]);

const CALCULATED_OUTPUT_KEYS = [
  "calculated_amount",
  "calculated_payment",
  "computed_cam",
  "recoverability_result",
  "allocated_expenses",
  "generated_periods",
  "expanded_periods",
  "due_dates",
  "critical_dates",
  "resolved_date",
  "resolved_start_date",
  "resolved_end_date",
  "calculated_percentage_rent",
  "computed_interest",
  "amortization_schedule",
  "reconciliation_result",
  "gross_up_result",
];

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function sameNullable(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function asNumber(value: unknown): number | null {
  if (!hasValue(value)) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function currencyValid(code?: string | null): boolean {
  return !hasValue(code) || /^[A-Z]{3}$/.test(String(code));
}

function refById(refs: FinancialChargeContextRef[] = [], id?: string | null): FinancialChargeContextRef | null {
  if (!hasValue(id)) return null;
  return refs.find((ref) => ref.id === id) ?? null;
}

function refMatchesContext(ref: FinancialChargeContextRef | null, context: FinancialChargeValidationContext, requireFile = false): boolean {
  if (!ref) return false;
  return ref.orgId === context.orgId &&
    ref.generationId === context.generationId &&
    sameNullable(ref.packageId, context.packageId) &&
    sameNullable(ref.leaseId, context.leaseId) &&
    (!requireFile || (
      ref.uploadedFileId === context.uploadedFileId &&
      ref.extractionRunId === context.extractionRunId
    ));
}

function sourceActive(ref: FinancialChargeContextRef | null): boolean {
  return !!ref && !INACTIVE_SOURCE_STATUSES.has(String(ref.status ?? ""));
}

function calculatedOutputForbidden(metadata?: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return CALCULATED_OUTPUT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(metadata, key));
}

function baseResult(errors: string[]) {
  const unique = [...new Set(errors)];
  return {
    valid: unique.length === 0,
    status: unique.length === 0 ? "valid" : "invalid",
    errorCodes: unique,
  };
}

function validateOptionalRefs(input: Record<string, unknown>, context: FinancialChargeValidationContext, errors: string[]) {
  for (const expressionId of [input.startExpressionId, input.endExpressionId, input.termExpressionId]) {
    if (hasValue(expressionId) && !refMatchesContext(refById(context.dateExpressions, String(expressionId)), context, true)) {
      errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
    }
  }
  if (hasValue(input.termCandidateId) && !refMatchesContext(refById(context.termCandidates, String(input.termCandidateId)), context)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (hasValue(input.baseRentScheduleCandidateId) && !refMatchesContext(refById(context.baseRentScheduleCandidates, String(input.baseRentScheduleCandidateId)), context)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_BASE_RENT_CONFLATION);
  }
}

function validateSourceClaim(sourceClaimId: string | null | undefined, context: FinancialChargeValidationContext, errors: string[]) {
  if (!hasValue(sourceClaimId)) return;
  const claim = refById(context.sourceClaims, sourceClaimId);
  if (!refMatchesContext(claim, context, true) || !sourceActive(claim)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_SOURCE_MISSING);
  }
}

export function validateFinancialChargeCandidate(
  input: FinancialChargeInput,
  context: FinancialChargeValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];
  const registry = getFinancialChargeRegistryEntry(input.chargeType);

  if (input.chargeContractVersion && input.chargeContractVersion !== LEASE_FINANCIAL_CHARGE_CONTRACT_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.registryVersion && input.registryVersion !== LEASE_FINANCIAL_CHARGE_REGISTRY_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_REGISTRY_MISMATCH);
  }
  if (input.registryHash && input.registryHash !== LEASE_FINANCIAL_CHARGE_REGISTRY_HASH) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_REGISTRY_MISMATCH);
  }
  if (context.activeGenerationId && context.activeGenerationId !== context.generationId) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_GENERATION_STALE);
  }
  if (input.orgId !== context.orgId || input.uploadedFileId !== context.uploadedFileId ||
      input.extractionRunId !== context.extractionRunId || input.generationId !== context.generationId ||
      !sameNullable(input.packageId, context.packageId) || !sameNullable(input.leaseId, context.leaseId)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (!registry) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_TYPE_INVALID);
  if (!DOMAIN_SET.has(String(input.chargeDomain))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_DOMAIN_INVALID);
  if (!ROLE_SET.has(String(input.financialRole))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ROLE_INVALID);
  if (!STATUS_SET.has(String(input.chargeStatus))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_STATUS_INVALID);
  if (!ORIGIN_SET.has(String(input.originType))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ORIGIN_INVALID);
  if (hasValue(input.frequency) && !FREQUENCY_SET.has(String(input.frequency))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_FREQUENCY_INVALID);
  if (hasValue(input.estimateStatus) && !ESTIMATE_STATUS_SET.has(String(input.estimateStatus))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ESTIMATE_STATUS_INVALID);
  if (!currencyValid(input.currencyCode)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMOUNT_CURRENCY_INVALID);
  if (input.producerType && !PRODUCER_SET.has(String(input.producerType))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_PRODUCER_PROVENANCE_INVALID);
  if (input.producerType === "semantic_extractor" && !hasValue(input.providerInvocationId)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_PRODUCER_PROVENANCE_INVALID);
  }
  if (input.originType === "reviewer" && (hasValue(input.providerInvocationId) || hasValue(input.extractionStageRunId))) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_PRODUCER_PROVENANCE_INVALID);
  }
  if (registry) {
    if (registry.chargeDomain !== input.chargeDomain) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_TYPE_DOMAIN_MISMATCH);
    if (registry.financialRole !== input.financialRole) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_TYPE_ROLE_MISMATCH);
    if (registry.representsEstimate && input.estimateStatus !== "stated_estimate") {
      errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ESTIMATE_FINAL_CONFLATION);
    }
    if (!registry.representsEstimate && input.estimateStatus === "stated_estimate" && ["security_deposit", "prepaid_rent", "tenant_improvement_allowance"].includes(input.chargeType)) {
      errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ESTIMATE_FINAL_CONFLATION);
    }
    if (registry.belongsToBaseRentSchedules || hasValue(input.baseRentScheduleCandidateId)) {
      errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_BASE_RENT_CONFLATION);
    }
  }
  for (const claimId of input.sourceClaimIds ?? []) validateSourceClaim(claimId, context, errors);
  validateOptionalRefs(input, context, errors);
  if (input.chargeStatus === "requires_related_document" && !hasValue(input.metadata?.related_document_requirement_id)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_SOURCE_MISSING);
  }
  if (calculatedOutputForbidden(input.metadata)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NO_CALCULATION_ALLOWED);

  return baseResult(errors);
}

export function validateFinancialChargePeriodCandidate(
  input: FinancialChargePeriodInput,
  context: FinancialChargeValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];
  const startMonth = asNumber(input.startTermMonth);
  const endMonth = asNumber(input.endTermMonth);

  if (input.periodContractVersion && input.periodContractVersion !== LEASE_FINANCIAL_CHARGE_PERIOD_CONTRACT_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId ||
      !sameNullable(input.packageId, context.packageId) || !sameNullable(input.leaseId, context.leaseId)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (!STATUS_SET.has(String(input.periodStatus))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_STATUS_INVALID);
  if ((startMonth !== null && startMonth < 1) || (endMonth !== null && endMonth < 1) ||
      (startMonth !== null && endMonth !== null && endMonth < startMonth)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_PERIOD_RANGE_INVALID);
  }
  validateOptionalRefs(input, context, errors);
  validateSourceClaim(input.sourceClaimId, context, errors);
  if (calculatedOutputForbidden(input.metadata)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NO_CALCULATION_ALLOWED);
  return baseResult(errors);
}

export function validateFinancialChargePeriodSet(periods: FinancialChargePeriodInput[]): { errorCodes: string[] } {
  const errors: string[] = [];
  const ranges = periods
    .map((period) => ({ start: asNumber(period.startTermMonth), end: asNumber(period.endTermMonth), status: period.periodStatus }))
    .filter((period) => period.start !== null && period.end !== null)
    .sort((a, b) => a.start! - b.start!);
  for (let i = 1; i < ranges.length; i += 1) {
    if (ranges[i - 1].end! >= ranges[i].start! && ranges[i].status !== "ambiguous") {
      errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_PERIOD_OVERLAP);
    }
  }
  return { errorCodes: [...new Set(errors)] };
}

export function validateFinancialChargeAmountCandidate(
  input: FinancialChargeAmountInput,
  context: FinancialChargeValidationContext,
  charge?: FinancialChargeInput,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];
  const amount = asNumber(input.statedAmount);
  const registry = charge ? getFinancialChargeRegistryEntry(charge.chargeType) : null;

  if (input.amountContractVersion && input.amountContractVersion !== LEASE_FINANCIAL_CHARGE_AMOUNT_CONTRACT_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (!AMOUNT_ROLE_SET.has(String(input.amountRole))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMOUNT_ROLE_INVALID);
  if (!AMOUNT_BASIS_SET.has(String(input.amountBasis))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMOUNT_BASIS_INVALID);
  if (hasValue(input.frequency) && !FREQUENCY_SET.has(String(input.frequency))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_FREQUENCY_INVALID);
  if (!STATUS_SET.has(String(input.amountStatus))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_STATUS_INVALID);
  if (!ORIGIN_SET.has(String(input.originType))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ORIGIN_INVALID);
  if (!currencyValid(input.currencyCode)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMOUNT_CURRENCY_INVALID);
  if (registry && !registry.permittedAmountRoles.includes(input.amountRole)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_TYPE_ROLE_MISMATCH);
  }
  if (registry && hasValue(input.frequency) && !registry.permittedFrequencies.includes(input.frequency)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_FREQUENCY_INVALID);
  }
  if (amount === null && input.amountRole !== "unresolved_amount" && !(input.amountRole === "stated_rate" && hasValue(input.rateValue)) && input.amountBasis !== "formula_based") {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_SOURCE_MISSING);
  }
  if (amount !== null && amount < 0 && input.amountRole !== "credit_amount" && charge?.chargeType !== "credit") {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NEGATIVE_AMOUNT_NEEDS_REVIEW);
  }
  if (charge?.chargeType === "security_deposit" && !["deposit_amount", "unresolved_amount"].includes(input.amountRole)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_TYPE_ROLE_MISMATCH);
  }
  if (charge?.chargeType === "cam_estimate" && input.amountRole === "billed_amount") {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_ESTIMATE_FINAL_CONFLATION);
  }
  validateSourceClaim(input.sourceClaimId, context, errors);
  if (calculatedOutputForbidden(input.metadata)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NO_CALCULATION_ALLOWED);
  return baseResult(errors);
}

export function validateFinancialDepositComponentCandidate(
  input: FinancialDepositComponentInput,
  context: FinancialChargeValidationContext,
  parentCharge?: FinancialChargeInput,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];
  const amount = asNumber(input.statedAmount);

  if (input.componentContractVersion && input.componentContractVersion !== LEASE_FINANCIAL_DEPOSIT_COMPONENT_CONTRACT_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (parentCharge && !["security_deposit", "prepaid_rent", "deposit_component", "unresolved_charge"].includes(parentCharge.chargeType)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_DEPOSIT_COMPONENT_INVALID);
  }
  if (!DEPOSIT_COMPONENT_TYPE_SET.has(String(input.componentType))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_DEPOSIT_COMPONENT_INVALID);
  if (!DEPOSIT_ALLOCATION_ROLE_SET.has(String(input.allocationRole))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_DEPOSIT_COMPONENT_INVALID);
  if (!["deposit_amount", "prepaid_amount", "credit_amount", "unresolved_amount"].includes(input.amountRole)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMOUNT_ROLE_INVALID);
  }
  if (!STATUS_SET.has(String(input.componentStatus))) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_STATUS_INVALID);
  if (!currencyValid(input.currencyCode)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMOUNT_CURRENCY_INVALID);
  if (amount === null && input.amountRole !== "unresolved_amount") errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_SOURCE_MISSING);
  validateSourceClaim(input.sourceClaimId, context, errors);
  if (calculatedOutputForbidden(input.metadata) || hasValue(input.metadata?.computed_total)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NO_CALCULATION_ALLOWED);
  }
  return baseResult(errors);
}

export function validateFinancialAmortizationCandidate(
  input: FinancialAmortizationInput,
  context: FinancialChargeValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];

  if (input.amortizationContractVersion && input.amortizationContractVersion !== LEASE_FINANCIAL_AMORTIZATION_CONTRACT_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (!AMORTIZATION_TYPE_SET.has(String(input.amortizationType)) || !AMORTIZATION_STATUS_SET.has(String(input.amortizationStatus))) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMORTIZATION_INPUT_INVALID);
  }
  if (!hasValue(input.principalAmountId) || !hasValue(input.paymentAmountId)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_AMORTIZATION_INPUT_INVALID);
  }
  validateOptionalRefs(input, context, errors);
  validateSourceClaim(input.sourceClaimId, context, errors);
  if (!hasValue(input.sourceClaimId) && !hasValue(input.sourcePackageEffectiveClaimId)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_SOURCE_MISSING);
  }
  if (calculatedOutputForbidden(input.metadata)) errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NO_CALCULATION_ALLOWED);
  return baseResult(errors);
}

export function validateFinancialFormulaCandidate(
  input: FinancialFormulaInput,
  context: FinancialChargeValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];

  if (input.formulaContractVersion && input.formulaContractVersion !== LEASE_FINANCIAL_FORMULA_CONTRACT_VERSION) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_CONTEXT_INVALID);
  }
  if (!FORMULA_TYPE_SET.has(String(input.formulaType)) || !FORMULA_STATUS_SET.has(String(input.formulaStatus))) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_FORMULA_INPUT_INVALID);
  }
  if (input.formulaStatus === "requires_external_data") {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_FORMULA_INPUT_INVALID);
  }
  if (input.formulaType === "percentage_rent_formula" && !String(input.formulaText ?? "").toLowerCase().includes("sales")) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_FORMULA_INPUT_INVALID);
  }
  validateSourceClaim(input.sourceClaimId, context, errors);
  if (hasValue(input.metadata?.calculatedOutputAmount) || calculatedOutputForbidden(input.metadata)) {
    errors.push(FINANCIAL_CHARGE_VALIDATION_ERROR_CODES.CHARGE_NO_CALCULATION_ALLOWED);
  }
  return baseResult(errors);
}

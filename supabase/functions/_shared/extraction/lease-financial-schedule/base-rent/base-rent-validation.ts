// @ts-nocheck
import {
  BASE_RENT_ABATEMENT_TYPES,
  BASE_RENT_AMOUNT_BASES,
  BASE_RENT_AMOUNT_ROLES,
  BASE_RENT_BILLING_STATUSES,
  BASE_RENT_ESCALATION_TYPES,
  BASE_RENT_FREQUENCIES,
  BASE_RENT_ORIGIN_TYPES,
  BASE_RENT_PERIOD_TYPES,
  BASE_RENT_SCHEDULE_BASES,
  BASE_RENT_SCHEDULE_STATUSES,
  BASE_RENT_SCHEDULE_TYPES,
  BASE_RENT_VALIDATION_ERROR_CODES,
  LEASE_BASE_RENT_AMOUNT_CONTRACT_VERSION,
  LEASE_BASE_RENT_ESCALATION_CONTRACT_VERSION,
  LEASE_BASE_RENT_PERIOD_CONTRACT_VERSION,
  LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION,
  type BaseRentAmountInput,
  type BaseRentContextRef,
  type BaseRentEscalationInput,
  type BaseRentPeriodInput,
  type BaseRentScheduleInput,
  type BaseRentValidationContext,
} from "./base-rent-types.ts";

const SCHEDULE_TYPE_SET = new Set(BASE_RENT_SCHEDULE_TYPES);
const SCHEDULE_STATUS_SET = new Set(BASE_RENT_SCHEDULE_STATUSES);
const ORIGIN_SET = new Set(BASE_RENT_ORIGIN_TYPES);
const SCHEDULE_BASIS_SET = new Set(BASE_RENT_SCHEDULE_BASES);
const PERIOD_TYPE_SET = new Set(BASE_RENT_PERIOD_TYPES);
const BILLING_STATUS_SET = new Set(BASE_RENT_BILLING_STATUSES);
const ABATEMENT_TYPE_SET = new Set(BASE_RENT_ABATEMENT_TYPES);
const AMOUNT_ROLE_SET = new Set(BASE_RENT_AMOUNT_ROLES);
const AMOUNT_BASIS_SET = new Set(BASE_RENT_AMOUNT_BASES);
const FREQUENCY_SET = new Set(BASE_RENT_FREQUENCIES);
const ESCALATION_TYPE_SET = new Set(BASE_RENT_ESCALATION_TYPES);
const INACTIVE_SOURCE_STATUSES = new Set(["not_present", "not_applicable", "unreadable", "extraction_failed", "superseded"]);

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

function refById(refs: BaseRentContextRef[] = [], id?: string | null): BaseRentContextRef | null {
  if (!hasValue(id)) return null;
  return refs.find((ref) => ref.id === id) ?? null;
}

function refMatchesContext(ref: BaseRentContextRef | null, context: BaseRentValidationContext, requireFile = false): boolean {
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

function sourceActive(ref: BaseRentContextRef | null): boolean {
  return !!ref && !INACTIVE_SOURCE_STATUSES.has(String(ref.status ?? ""));
}

function calculatedOutputForbidden(metadata?: Record<string, unknown> | null): boolean {
  if (!metadata) return false;
  return [
    "resolved_date",
    "calculated_date",
    "calculated_monthly_rent",
    "calculated_annual_rent",
    "converted_psf_rent",
    "prorated_amount",
    "expanded_periods",
    "generated_periods",
    "critical_dates",
    "rent_schedule_output",
    "cpi_value",
  ].some((key) => Object.prototype.hasOwnProperty.call(metadata, key));
}

function baseResult(errors: string[]) {
  const unique = [...new Set(errors)];
  return {
    valid: unique.length === 0,
    status: unique.length === 0 ? "valid" : "invalid",
    errorCodes: unique,
  };
}

export function validateBaseRentScheduleCandidate(
  input: BaseRentScheduleInput,
  context: BaseRentValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];

  if (input.scheduleContractVersion && input.scheduleContractVersion !== LEASE_BASE_RENT_SCHEDULE_CONTRACT_VERSION) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTRACT_VERSION_MISMATCH);
  }
  if (context.activeGenerationId && context.activeGenerationId !== context.generationId) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_GENERATION_STALE);
  }
  if (input.orgId !== context.orgId || input.uploadedFileId !== context.uploadedFileId ||
      input.extractionRunId !== context.extractionRunId || input.generationId !== context.generationId ||
      !sameNullable(input.packageId, context.packageId) || !sameNullable(input.leaseId, context.leaseId)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
  }
  if (!SCHEDULE_TYPE_SET.has(String(input.scheduleType))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_TYPE_INVALID);
  if (!SCHEDULE_STATUS_SET.has(String(input.scheduleStatus))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_STATUS_INVALID);
  if (!ORIGIN_SET.has(String(input.originType))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_ORIGIN_INVALID);
  if (!SCHEDULE_BASIS_SET.has(String(input.scheduleBasis))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_BASIS_INVALID);
  if (!currencyValid(input.currencyCode)) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_CURRENCY_INVALID);

  if (input.producerType === "semantic_extractor" && !hasValue(input.providerInvocationId)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PRODUCER_PROVENANCE_INVALID);
  }
  if (input.originType === "reviewer" && (hasValue(input.providerInvocationId) || hasValue(input.extractionStageRunId))) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PRODUCER_PROVENANCE_INVALID);
  }
  if (input.scheduleStatus === "requires_related_document" && !hasValue(input.metadata?.related_document_requirement_id)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_RELATED_DOCUMENT_MISSING);
  }
  if (hasValue(input.termCandidateId) && !refMatchesContext(refById(context.termCandidates, input.termCandidateId), context)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
  }
  for (const expressionId of [input.startExpressionId, input.endExpressionId]) {
    if (hasValue(expressionId) && !refMatchesContext(refById(context.dateExpressions, expressionId), context, true)) {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
    }
  }
  for (const claimId of input.sourceClaimIds ?? []) {
    const claim = refById(context.sourceClaims, claimId);
    if (!refMatchesContext(claim, context, true) || !sourceActive(claim)) {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_SOURCE_MISSING);
    }
  }
  if (calculatedOutputForbidden(input.metadata)) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_NO_CALCULATION_ALLOWED);

  return baseResult(errors);
}

export function validateBaseRentPeriodCandidate(
  input: BaseRentPeriodInput,
  context: BaseRentValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];
  const startMonth = asNumber(input.startTermMonth);
  const endMonth = asNumber(input.endTermMonth);

  if (input.periodContractVersion && input.periodContractVersion !== LEASE_BASE_RENT_PERIOD_CONTRACT_VERSION) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId ||
      !sameNullable(input.packageId, context.packageId) || !sameNullable(input.leaseId, context.leaseId)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
  }
  if (!SCHEDULE_STATUS_SET.has(String(input.periodStatus))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_STATUS_INVALID);
  if (!PERIOD_TYPE_SET.has(String(input.periodType))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_TYPE_INVALID);
  if (!BILLING_STATUS_SET.has(String(input.billingStatus))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_BILLING_STATUS_INVALID);
  if (hasValue(input.abatementType) && !ABATEMENT_TYPE_SET.has(String(input.abatementType))) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_ABATEMENT_INVALID);
  }
  if ((startMonth !== null && startMonth < 1) || (endMonth !== null && endMonth < 1) ||
      (startMonth !== null && endMonth !== null && endMonth < startMonth)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_RANGE_INVALID);
  }
  if (input.periodType === "free_rent_period" && input.billingStatus !== "fully_abated") {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_ABATEMENT_INVALID);
  }
  if (input.periodType === "partial_period" && hasValue(input.metadata?.prorated_amount)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_NO_CALCULATION_ALLOWED);
  }
  for (const expressionId of [input.startExpressionId, input.endExpressionId]) {
    if (hasValue(expressionId) && !refMatchesContext(refById(context.dateExpressions, expressionId), context, true)) {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
    }
  }
  if (hasValue(input.termCandidateId) && !refMatchesContext(refById(context.termCandidates, input.termCandidateId), context)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
  }
  if (hasValue(input.sourceClaimId)) {
    const claim = refById(context.sourceClaims, input.sourceClaimId);
    if (!refMatchesContext(claim, context, true) || !sourceActive(claim)) {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_SOURCE_MISSING);
    }
  }
  if (calculatedOutputForbidden(input.metadata)) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_NO_CALCULATION_ALLOWED);

  return baseResult(errors);
}

export function validateBaseRentPeriodSet(periods: BaseRentPeriodInput[]): { errorCodes: string[]; gaps: Array<[number, number]> } {
  const errors: string[] = [];
  const gaps: Array<[number, number]> = [];
  const ranges = periods
    .map((period) => ({ start: asNumber(period.startTermMonth), end: asNumber(period.endTermMonth), status: period.periodStatus }))
    .filter((period) => period.start !== null && period.end !== null)
    .sort((a, b) => a.start! - b.start!);

  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous.end! >= current.start! && current.status !== "ambiguous") {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_OVERLAP);
    }
    if (previous.end! + 1 < current.start!) {
      gaps.push([previous.end! + 1, current.start! - 1]);
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PERIOD_GAP);
    }
  }
  return { errorCodes: [...new Set(errors)], gaps };
}

export function validateBaseRentAmountCandidate(
  input: BaseRentAmountInput,
  context: BaseRentValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];
  const amount = asNumber(input.statedAmount);
  const isPsf = String(input.amountBasis).startsWith("per_square_foot");

  if (input.amountContractVersion && input.amountContractVersion !== LEASE_BASE_RENT_AMOUNT_CONTRACT_VERSION) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
  }
  if (!AMOUNT_ROLE_SET.has(String(input.amountRole))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_ROLE_INVALID);
  if (!AMOUNT_BASIS_SET.has(String(input.amountBasis))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_BASIS_INVALID);
  if (hasValue(input.frequency) && !FREQUENCY_SET.has(String(input.frequency))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_FREQUENCY_INVALID);
  if (!currencyValid(input.currencyCode)) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_CURRENCY_INVALID);
  if (input.originType && !ORIGIN_SET.has(String(input.originType))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_ORIGIN_INVALID);
  if (input.amountRole === "annualized_reference" && input.amountBasis !== "per_year") {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_ANNUALIZED_BILLED_CONFLATION);
  }
  if (input.amountRole === "billed_base_rent" && input.amountBasis === "per_year") {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_ANNUALIZED_BILLED_CONFLATION);
  }
  if (input.amountRole === "stated_psf_rate" && !isPsf) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PSF_CONVERSION_NOT_ALLOWED);
  }
  if (isPsf && hasValue(input.areaValue) && input.amountRole !== "stated_psf_rate") {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_PSF_CONVERSION_NOT_ALLOWED);
  }
  if (amount !== null && amount < 0 && !["abatement_amount", "partial_period_amount"].includes(String(input.amountRole))) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_NEGATIVE_AMOUNT_NEEDS_REVIEW);
  }
  if (amount === null && input.amountRole !== "unresolved_amount" && !(input.amountRole === "stated_psf_rate" && hasValue(input.rateValue))) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_SOURCE_MISSING);
  }
  if (hasValue(input.sourceClaimId)) {
    const claim = refById(context.sourceClaims, input.sourceClaimId);
    if (!refMatchesContext(claim, context, true) || !sourceActive(claim)) {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_SOURCE_MISSING);
    }
  }

  return baseResult(errors);
}

export function validateBaseRentEscalationCandidate(
  input: BaseRentEscalationInput,
  context: BaseRentValidationContext,
): { valid: boolean; status: "valid" | "invalid"; errorCodes: string[] } {
  const errors: string[] = [];

  if (input.escalationContractVersion && input.escalationContractVersion !== LEASE_BASE_RENT_ESCALATION_CONTRACT_VERSION) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTRACT_VERSION_MISMATCH);
  }
  if (input.orgId !== context.orgId || input.generationId !== context.generationId) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_SCHEDULE_CONTEXT_INVALID);
  }
  if (!ESCALATION_TYPE_SET.has(String(input.escalationType))) errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_ESCALATION_TYPE_INVALID);
  if (hasValue(input.frequency) && !FREQUENCY_SET.has(String(input.frequency))) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_ESCALATION_INPUT_INVALID);
  }
  if (input.escalationType === "cpi_adjustment" && hasValue(input.formulaDefinition?.cpi_value)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_ESCALATION_EXPANSION_NOT_ALLOWED);
  }
  if (hasValue(input.formulaDefinition?.generated_periods) || hasValue(input.recurrenceDefinition?.expanded_periods)) {
    errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_ESCALATION_EXPANSION_NOT_ALLOWED);
  }
  if (hasValue(input.sourceClaimId)) {
    const claim = refById(context.sourceClaims, input.sourceClaimId);
    if (!refMatchesContext(claim, context, true) || !sourceActive(claim)) {
      errors.push(BASE_RENT_VALIDATION_ERROR_CODES.RENT_AMOUNT_SOURCE_MISSING);
    }
  }

  return baseResult(errors);
}

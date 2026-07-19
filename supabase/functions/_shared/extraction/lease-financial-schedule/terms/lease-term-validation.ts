// @ts-nocheck
import {
  LEASE_TERM_CANDIDATE_CONTRACT_VERSION,
  LEASE_TERM_ORIGIN_TYPES,
  LEASE_TERM_STATUSES,
  LEASE_TERM_TYPES,
  LEASE_TERM_VALIDATION_ERROR_CODES,
  type LeaseTermCandidateInput,
  type LeaseTermValidationContext,
} from "./lease-term-types.ts";

const TYPE_SET = new Set(LEASE_TERM_TYPES);
const STATUS_SET = new Set(LEASE_TERM_STATUSES);
const ORIGIN_SET = new Set(LEASE_TERM_ORIGIN_TYPES);
const DURATION_UNITS = new Set(["day", "business_day", "week", "month", "year"]);
const INCLUSIVE_RULES = new Set(["exclusive_end", "inclusive_end", "source_defined", "unknown"]);

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function sameNullable(a: unknown, b: unknown): boolean {
  return (a ?? null) === (b ?? null);
}

function expressionMatchesContext(expression: unknown, context: LeaseTermValidationContext): boolean {
  if (!expression) return false;
  return expression.orgId === context.orgId &&
    expression.uploadedFileId === context.uploadedFileId &&
    expression.extractionRunId === context.extractionRunId &&
    expression.generationId === context.generationId &&
    sameNullable(expression.packageId, context.packageId) &&
    sameNullable(expression.leaseId, context.leaseId);
}

function containsResolvedDate(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const asText = JSON.stringify(value).toLowerCase();
  return /resolved[_-]?date|calculated[_-]?date|effective[_-]?date|rent[_-]?schedule|critical[_-]?date/.test(asText);
}

export function validateLeaseTermCandidate(
  input: LeaseTermCandidateInput,
  context: LeaseTermValidationContext,
): { valid: boolean; status: "valid" | "invalid" | "needs_review"; errorCodes: string[] } {
  const errors: string[] = [];
  const expressionsById = new Map(context.expressions.map((expression) => [expression.id, expression]));
  const termType = String(input.termType ?? "");
  const termStatus = String(input.termStatus ?? "");
  const originType = String(input.originType ?? "");

  if (input.termContractVersion && input.termContractVersion !== LEASE_TERM_CANDIDATE_CONTRACT_VERSION) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_CONTRACT_VERSION_MISMATCH);
  }
  if (!TYPE_SET.has(termType)) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_TYPE_INVALID);
  }
  if (!STATUS_SET.has(termStatus)) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_STATUS_INVALID);
  }
  if (!ORIGIN_SET.has(originType)) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_ORIGIN_INVALID);
  }
  if (context.activeGenerationId && context.activeGenerationId !== context.generationId) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_GENERATION_STALE);
  }

  for (const [field, code] of [
    ["startExpressionId", LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_START_EXPRESSION_MISSING],
    ["endExpressionId", LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_END_EXPRESSION_MISSING],
  ]) {
    const expressionId = input[field];
    if (!hasValue(expressionId)) continue;
    const expression = expressionsById.get(String(expressionId));
    if (!expression) {
      errors.push(code);
    } else if (!expressionMatchesContext(expression, context)) {
      errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_EXPRESSION_CONTEXT_MISMATCH);
    }
  }

  const hasDurationValue = hasValue(input.durationValue);
  const hasDurationUnit = hasValue(input.durationUnit);
  if (hasDurationValue !== hasDurationUnit) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_DURATION_PAIR_INCOMPLETE);
  }
  if (hasDurationUnit && !DURATION_UNITS.has(String(input.durationUnit))) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_DURATION_UNIT_INVALID);
  }
  if (hasDurationValue) {
    const duration = Number(input.durationValue);
    if (!Number.isFinite(duration) || duration < 0) {
      errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_DURATION_UNIT_INVALID);
    }
  }
  if (hasValue(input.durationInclusiveRule) && !INCLUSIVE_RULES.has(String(input.durationInclusiveRule))) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_DURATION_UNIT_INVALID);
  }
  if (hasValue(input.sequenceNumber)) {
    const sequence = Number(input.sequenceNumber);
    if (!Number.isInteger(sequence) || sequence < 1) {
      errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_SEQUENCE_INVALID);
    }
  }
  if (termStatus === "requires_related_document" && !hasValue(input.relatedDocumentRequirementId)) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_RELATED_DOCUMENT_REQUIRED);
  }
  if (containsResolvedDate(input.metadata)) {
    errors.push(LEASE_TERM_VALIDATION_ERROR_CODES.LEASE_TERM_NO_RESOLUTION_ALLOWED);
  }

  const unique = [...new Set(errors)];
  return {
    valid: unique.length === 0,
    status: unique.length === 0 ? "valid" : "invalid",
    errorCodes: unique,
  };
}

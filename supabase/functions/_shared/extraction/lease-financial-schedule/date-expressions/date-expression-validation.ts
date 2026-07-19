// @ts-nocheck
import { computeDateExpressionRegistryHash, getDateExpressionType } from "./date-expression-registry.ts";
import { DATE_EXPRESSION_REGISTRY_VERSION } from "./date-expression-registry-version.ts";
import { normalizeDateExpressionType } from "./date-expression-normalization.ts";
import type { DateExpressionCandidateInput, DateExpressionValidationContext } from "./date-expression-types.ts";

export const DATE_EXPRESSION_VALIDATION_ERROR_CODES = {
  DATE_EXPRESSION_TYPE_INVALID: "DATE_EXPRESSION_TYPE_INVALID",
  DATE_EXPRESSION_FIXED_DATE_MISSING: "DATE_EXPRESSION_FIXED_DATE_MISSING",
  DATE_EXPRESSION_EVENT_MISSING: "DATE_EXPRESSION_EVENT_MISSING",
  DATE_EXPRESSION_ANCHOR_MISSING: "DATE_EXPRESSION_ANCHOR_MISSING",
  DATE_EXPRESSION_OFFSET_MISSING: "DATE_EXPRESSION_OFFSET_MISSING",
  DATE_EXPRESSION_OPERANDS_MISSING: "DATE_EXPRESSION_OPERANDS_MISSING",
  DATE_EXPRESSION_RECURRENCE_MISSING: "DATE_EXPRESSION_RECURRENCE_MISSING",
  DATE_EXPRESSION_SOURCE_CLAIM_MISSING: "DATE_EXPRESSION_SOURCE_CLAIM_MISSING",
  DATE_EXPRESSION_SOURCE_MISMATCH: "DATE_EXPRESSION_SOURCE_MISMATCH",
  DATE_EXPRESSION_GENERATION_STALE: "DATE_EXPRESSION_GENERATION_STALE",
  DATE_EXPRESSION_PROVIDER_PROVENANCE_MISSING: "DATE_EXPRESSION_PROVIDER_PROVENANCE_MISSING",
  DATE_EXPRESSION_REVIEWER_PROVENANCE_INVALID: "DATE_EXPRESSION_REVIEWER_PROVENANCE_INVALID",
  DATE_EXPRESSION_RELATED_DOCUMENT_MISSING: "DATE_EXPRESSION_RELATED_DOCUMENT_MISSING",
  DATE_EXPRESSION_REGISTRY_MISMATCH: "DATE_EXPRESSION_REGISTRY_MISMATCH",
  DATE_EXPRESSION_FORMULA_MISSING: "DATE_EXPRESSION_FORMULA_MISSING",
  DATE_EXPRESSION_AMBIGUOUS_AUTHORITATIVE_DATE: "DATE_EXPRESSION_AMBIGUOUS_AUTHORITATIVE_DATE",
  DATE_EXPRESSION_P4_1_RESOLUTION_NOT_ALLOWED: "DATE_EXPRESSION_P4_1_RESOLUTION_NOT_ALLOWED",
  DATE_EXPRESSION_STATUS_INVALID: "DATE_EXPRESSION_STATUS_INVALID",
} as const;

const STATUSES = new Set([
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
]);
const ORIGINS = new Set(["extracted", "reviewer", "derived", "calculated", "legacy_adapter", "system_projection"]);
const OFFSET_UNITS = new Set(["day", "business_day", "week", "month", "year"]);
const OFFSET_DIRECTIONS = new Set(["before", "after"]);

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function hasAnchor(input: DateExpressionCandidateInput): boolean {
  return hasValue(input.anchorConceptKey) || hasValue(input.anchorExpressionId);
}

function hasOffset(input: DateExpressionCandidateInput): boolean {
  const amount = Number(input.offsetValue);
  return hasValue(input.offsetValue) && Number.isFinite(amount) && amount >= 0 && OFFSET_UNITS.has(String(input.offsetUnit ?? "")) && OFFSET_DIRECTIONS.has(String(input.offsetDirection ?? ""));
}

function sourceClaimIds(input: DateExpressionCandidateInput): string[] {
  return [...new Set([...(input.sourceClaimIds ?? []), input.sourceClaimId].filter(Boolean).map(String))].sort();
}

function recurrenceIsBounded(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const recurrence = value as Record<string, unknown>;
  if (!hasValue(recurrence.frequency)) return false;
  const count = Number(recurrence.count ?? recurrence.max_occurrences ?? recurrence.maxOccurrences ?? 0);
  const endDate = recurrence.until ?? recurrence.end_date ?? recurrence.endDate;
  return (Number.isFinite(count) && count > 0 && count <= 600) || hasValue(endDate);
}

export function validateDateExpressionCandidate(
  input: DateExpressionCandidateInput,
  context?: DateExpressionValidationContext,
): { valid: boolean; status: "valid" | "invalid" | "needs_review"; errorCodes: string[] } {
  const errors: string[] = [];
  const expressionType = normalizeDateExpressionType(input.expressionType);

  if (!expressionType || !getDateExpressionType(expressionType)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_TYPE_INVALID);
  }
  if (!STATUSES.has(input.expressionStatus)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_STATUS_INVALID);
  }
  if (!ORIGINS.has(input.originType)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_STATUS_INVALID);
  }
  if (context && (input.registryVersion !== context.expectedRegistryVersion || input.registryHash !== context.expectedRegistryHash)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_REGISTRY_MISMATCH);
  }

  switch (expressionType) {
    case "fixed_date":
      if (!hasValue(input.explicitDate)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_FIXED_DATE_MISSING);
      break;
    case "event_date":
      if (!hasValue(input.eventKey)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_EVENT_MISSING);
      break;
    case "relative_to_date":
      if (!hasAnchor(input)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_ANCHOR_MISSING);
      if (!hasOffset(input)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_OFFSET_MISSING);
      break;
    case "relative_to_event":
      if (!hasValue(input.eventKey)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_EVENT_MISSING);
      if (!hasOffset(input)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_OFFSET_MISSING);
      break;
    case "notice_window":
      if (!hasAnchor(input) && !hasValue(input.eventKey)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_ANCHOR_MISSING);
      if (!hasOffset(input)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_OFFSET_MISSING);
      break;
    case "earlier_of":
    case "later_of":
    case "minimum_of":
    case "maximum_of":
      if (!Array.isArray(input.operands) || input.operands.length < 2) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_OPERANDS_MISSING);
      break;
    case "dependent_date":
      if (!hasAnchor(input) && !hasValue(input.eventKey)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_ANCHOR_MISSING);
      break;
    case "recurring_deadline":
      if (!recurrenceIsBounded(input.recurrenceDefinition)) errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_RECURRENCE_MISSING);
      break;
  }

  const sources = sourceClaimIds(input);
  if (input.originType === "extracted" && sources.length === 0) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_CLAIM_MISSING);
  }
  if (input.producerType === "semantic_extractor" && !hasValue(input.providerInvocationId)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_PROVIDER_PROVENANCE_MISSING);
  }
  if (input.originType === "reviewer" && (hasValue(input.providerInvocationId) || hasValue(input.extractionStageRunId))) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_REVIEWER_PROVENANCE_INVALID);
  }
  if ((input.originType === "derived" || input.originType === "calculated") && (!hasValue(input.calculationFormulaKey) || !hasValue(input.calculationVersion))) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_FORMULA_MISSING);
  }
  if (input.expressionStatus === "ambiguous" && hasValue(input.explicitDate)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_AMBIGUOUS_AUTHORITATIVE_DATE);
  }
  if (expressionType && !["fixed_date", "event_date"].includes(expressionType) && hasValue(input.explicitDate)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_P4_1_RESOLUTION_NOT_ALLOWED);
  }
  if (input.expressionStatus === "requires_related_document" && !hasValue(input.conditionDefinition)) {
    errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_RELATED_DOCUMENT_MISSING);
  }

  if (context) {
    if (context.activeGenerationId && context.activeGenerationId !== input.generationId) {
      errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_GENERATION_STALE);
    }
    const byId = new Map((context.sourceClaims ?? []).map((claim) => [claim.id, claim]));
    for (const id of sources) {
      const claim = byId.get(id);
      if (!claim) {
        errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_CLAIM_MISSING);
        continue;
      }
      if (claim.orgId !== context.orgId) {
        errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_MISMATCH);
      }
      const singleDocumentMismatch =
        !context.packageId &&
        (claim.uploadedFileId !== context.uploadedFileId || claim.extractionRunId !== context.extractionRunId || claim.generationId !== context.generationId);
      const packageMismatch = context.packageId && claim.packageId && claim.packageId !== context.packageId;
      if (singleDocumentMismatch || packageMismatch) {
        errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_SOURCE_MISMATCH);
      }
      if (claim.activeGenerationId && claim.generationId && claim.activeGenerationId !== claim.generationId) {
        errors.push(DATE_EXPRESSION_VALIDATION_ERROR_CODES.DATE_EXPRESSION_GENERATION_STALE);
      }
    }
  }

  const unique = [...new Set(errors)];
  return {
    valid: unique.length === 0,
    status: unique.length === 0 ? "valid" : "invalid",
    errorCodes: unique,
  };
}

export async function defaultDateExpressionValidationContext(params: Omit<DateExpressionValidationContext, "expectedRegistryVersion" | "expectedRegistryHash">): Promise<DateExpressionValidationContext> {
  return {
    ...params,
    expectedRegistryVersion: DATE_EXPRESSION_REGISTRY_VERSION,
    expectedRegistryHash: await computeDateExpressionRegistryHash(),
  };
}

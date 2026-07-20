// @ts-nocheck
import { CLAIM_CONCEPTS, getClaimConcept } from "../../claims/concept-registry.ts";
import type { FieldProjectionEntry } from "../../claims/adapters/claims-to-field-projection.ts";
import type { FinancialFieldProjection, FinancialProjectionStatus, FinancialProjectionValueOrigin } from "./financial-projection-types.ts";

export function compatibilityFieldKeyForConcept(conceptKey: string): string | null {
  return getClaimConcept(conceptKey)?.projectionFieldKey ?? null;
}

export function fieldGroupMap(): Map<string, string> {
  return new Map(CLAIM_CONCEPTS.map((concept) => [concept.conceptKey, concept.domain]));
}

export function statusToProjectionStatus(status: string, hasValue: boolean): FinancialProjectionStatus {
  if (status === "requires_related_document") return "requires_related_document";
  if (status === "ambiguous") return "ambiguous";
  if (status === "needs_review") return "needs_review";
  if (status === "not_present") return "not_present";
  if (status === "not_applicable") return "not_applicable";
  if (status === "unreadable") return "unreadable";
  if (status === "extraction_failed") return "extraction_failed";
  if (!hasValue || status === "unresolved") return "unresolved";
  return "available";
}

export function statusToValueOrigin(status: string): FinancialProjectionValueOrigin {
  if (status === "extracted_fixed" || status === "extracted") return "extracted";
  if (status === "reviewer") return "reviewer";
  if (status === "resolved" || status === "derived") return "derived";
  if (status === "calculated") return "calculated";
  if (status === "requires_related_document") return "requires_related_document";
  if (status === "stated_and_validated") return "stated_and_validated";
  if (status === "stated_calculated_mismatch") return "stated_calculated_mismatch";
  return "unresolved";
}

export function makeFinancialFieldProjection(input: Partial<FinancialFieldProjection> & { fieldKey: string; conceptKey: string; projectionStatus: FinancialProjectionStatus; valueOrigin: FinancialProjectionValueOrigin }): FinancialFieldProjection {
  const compatibilityFieldKey = input.compatibilityFieldKey === undefined ? compatibilityFieldKeyForConcept(input.conceptKey) : input.compatibilityFieldKey;
  return {
    instanceKey: "default",
    normalizedValue: null,
    displayValue: input.normalizedValue === null || input.normalizedValue === undefined ? null : String(input.normalizedValue),
    validationCodes: [],
    confidence: null,
    evidenceSummary: null,
    sourceClaimId: null,
    sourcePackageEffectiveClaimId: null,
    sourceDateExpressionId: null,
    sourceCalculationResultId: null,
    statedSourceResultId: null,
    calculatedSourceResultId: null,
    conflictId: null,
    relatedDocumentRequirementId: null,
    formulaKey: null,
    formulaVersion: null,
    assumptions: {},
    roundingPolicy: null,
    amountRole: null,
    internalOnly: false,
    ...input,
    compatibilityFieldKey,
  };
}

function outcomeForProjection(row: FinancialFieldProjection): string {
  if (row.projectionStatus === "unresolved") return "unresolved";
  if (row.projectionStatus === "needs_review" || row.projectionStatus === "ambiguous") return "needs_review";
  if (["not_present", "not_applicable", "unreadable", "extraction_failed", "requires_related_document"].includes(row.projectionStatus)) return "explicit_status";
  if (row.valueOrigin === "calculated" || row.valueOrigin === "derived" || row.valueOrigin === "stated_and_validated") return "derived_calculated";
  if (row.valueOrigin === "reviewer") return "reviewer_accepted";
  return "deterministic";
}

function evidenceSourceText(row: FinancialFieldProjection): string | null {
  const evidence = row.evidenceSummary ?? {};
  return (evidence.source_text ?? evidence.sourceText ?? evidence.input_source_text ?? evidence.inputSourceText ?? null) as string | null;
}

function evidenceSourcePage(row: FinancialFieldProjection): number | null {
  const evidence = row.evidenceSummary ?? {};
  const page = evidence.source_page ?? evidence.sourcePage ?? evidence.input_source_page ?? evidence.inputSourcePage ?? null;
  return typeof page === "number" ? page : null;
}

export function toCompatibilityFieldProjectionEntries(rows: FinancialFieldProjection[]): FieldProjectionEntry[] {
  return rows
    .filter((row) => row.compatibilityFieldKey && !row.internalOnly)
    .map((row) => ({
      fieldKey: row.compatibilityFieldKey!,
      conceptKey: row.conceptKey,
      scopeKey: "lease",
      instanceKey: row.instanceKey ?? "default",
      outcome: outcomeForProjection(row),
      claimId: row.sourceClaimId ?? null,
      value: row.normalizedValue === null || row.normalizedValue === undefined ? null : String(row.normalizedValue),
      rawValue: row.displayValue ?? (row.normalizedValue === null || row.normalizedValue === undefined ? null : String(row.normalizedValue)),
      sourcePage: evidenceSourcePage(row),
      sourceText: evidenceSourceText(row),
      confidence: row.confidence ?? null,
    }));
}

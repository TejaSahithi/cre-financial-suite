// @ts-nocheck
/**
 * compatibility-diff.ts — P2.6 (shadow-mode support).
 *
 * Compares the legacy extraction_data.fields map against the claims-ledger
 * projection's equivalent, classifying every field key into exactly one of
 * the 9 named categories. Shadow mode logs this diff for analysis; it never
 * changes runtime output (P2.7 owns the off/shadow/active wiring).
 */
import { claimValuesEqual } from "./claim-comparison.ts";
import { normalizeByStrategy } from "./claim-normalization.ts";
import type { CompatibilityFieldEntry } from "./compatibility-payload-builder.ts";

const VALUE_TYPE_TO_STRATEGY: Record<string, string> = {
  money: "money_to_decimal", decimal: "decimal_parse", percentage: "percentage_to_decimal",
  integer: "integer_parse", date: "date_to_iso", boolean: "boolean_parse", address: "address_normalize",
};

export type DiffClassification =
  | "equal"
  | "representation_only"
  | "missing_in_claim_projection"
  | "extra_in_claim_projection"
  | "value_mismatch"
  | "evidence_mismatch"
  | "status_mismatch"
  | "confidence_mismatch"
  | "ordering_mismatch";

export interface FieldDiffResult {
  fieldKey: string;
  classification: DiffClassification;
  legacyValue?: unknown;
  claimValue?: unknown;
}

export interface CompatibilityDiffOptions {
  /** value_type per field key, for claimValuesEqual -- unknown fields default to conservative string comparison. */
  valueTypeByFieldKey?: Map<string, string>;
  confidenceTolerance?: number;
}

function valuesRepresentEqual(a: unknown, b: unknown, valueType: string): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a == b;
  // The legacy side is not guaranteed to already be in claim-normalization's
  // canonical form (it's whatever the pre-P2 pipeline produced, e.g.
  // "$6,004.00"), while the claim-projected side always is -- both must be
  // normalized before claimValuesEqual's plain string-equality shortcut for
  // money/date/etc. is valid, or every equivalent-but-differently-formatted
  // legacy value would misclassify as a value_mismatch.
  const strategy = VALUE_TYPE_TO_STRATEGY[valueType];
  const normalizedA = strategy ? normalizeByStrategy(strategy, a) : String(a);
  const normalizedB = strategy ? normalizeByStrategy(strategy, b) : String(b);
  return claimValuesEqual(valueType, normalizedA, normalizedB);
}

export function diffCompatibilityFields(
  legacy: Record<string, CompatibilityFieldEntry>,
  claimProjected: Record<string, CompatibilityFieldEntry>,
  options: CompatibilityDiffOptions = {},
): FieldDiffResult[] {
  const tolerance = options.confidenceTolerance ?? 5;
  const allKeys = new Set([...Object.keys(legacy), ...Object.keys(claimProjected)]);
  const results: FieldDiffResult[] = [];

  for (const key of allKeys) {
    const legacyField = legacy[key];
    const claimField = claimProjected[key];
    const valueType = options.valueTypeByFieldKey?.get(key) ?? "string";

    if (legacyField && !claimField) {
      results.push({ fieldKey: key, classification: "missing_in_claim_projection", legacyValue: legacyField.value });
      continue;
    }
    if (!legacyField && claimField) {
      results.push({ fieldKey: key, classification: "extra_in_claim_projection", claimValue: claimField.value });
      continue;
    }
    if (!legacyField || !claimField) continue; // unreachable given the union above, defensive only

    if (legacyField.extraction_status !== claimField.extraction_status) {
      results.push({ fieldKey: key, classification: "status_mismatch", legacyValue: legacyField.extraction_status, claimValue: claimField.extraction_status });
      continue;
    }

    const valueEqual = valuesRepresentEqual(legacyField.value, claimField.value, valueType);
    if (!valueEqual) {
      results.push({ fieldKey: key, classification: "value_mismatch", legacyValue: legacyField.value, claimValue: claimField.value });
      continue;
    }

    const exactValueEqual = legacyField.value === claimField.value;

    const evidenceEqual =
      legacyField.source_page === claimField.source_page &&
      (legacyField.source_text ?? null) === (claimField.source_text ?? null);
    if (!evidenceEqual) {
      results.push({ fieldKey: key, classification: "evidence_mismatch", legacyValue: legacyField.source_text, claimValue: claimField.source_text });
      continue;
    }

    const legacyConfidence = typeof legacyField.confidence_score === "number" ? legacyField.confidence_score : null;
    const claimConfidence = typeof claimField.confidence_score === "number" ? claimField.confidence_score : null;
    const confidenceEqual =
      legacyConfidence === claimConfidence ||
      (legacyConfidence !== null && claimConfidence !== null && Math.abs(legacyConfidence - claimConfidence) <= tolerance);
    if (!confidenceEqual) {
      results.push({ fieldKey: key, classification: "confidence_mismatch", legacyValue: legacyConfidence, claimValue: claimConfidence });
      continue;
    }

    results.push({
      fieldKey: key,
      classification: exactValueEqual ? "equal" : "representation_only",
      legacyValue: legacyField.value,
      claimValue: claimField.value,
    });
  }

  return results;
}

/** Detects whether the two maps' key insertion order differs -- reported
 *  separately from per-field content classification since it's a property
 *  of the whole map, not one field. */
export function diffFieldOrdering(
  legacy: Record<string, unknown>,
  claimProjected: Record<string, unknown>,
): boolean {
  const legacyOrder = Object.keys(legacy);
  const claimOrder = Object.keys(claimProjected).filter((k) => legacyOrder.includes(k));
  const legacyFiltered = legacyOrder.filter((k) => claimOrder.includes(k));
  return JSON.stringify(legacyFiltered) !== JSON.stringify(claimOrder);
}

export function summarizeDiff(results: FieldDiffResult[]): Record<DiffClassification, number> {
  const summary: Record<string, number> = {
    equal: 0, representation_only: 0, missing_in_claim_projection: 0,
    extra_in_claim_projection: 0, value_mismatch: 0, evidence_mismatch: 0,
    status_mismatch: 0, confidence_mismatch: 0, ordering_mismatch: 0,
  };
  for (const result of results) summary[result.classification] += 1;
  return summary as Record<DiffClassification, number>;
}

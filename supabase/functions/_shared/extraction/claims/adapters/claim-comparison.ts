// @ts-nocheck
/**
 * claim-comparison.ts — P2.5.
 *
 * Defines what "equal" means for two already-normalized claim values, per
 * value_type. Because claim-normalization.ts already canonicalizes money/
 * percentage/decimal/integer/date/boolean into one fixed string
 * representation at persistence time ("$6,004.00" / "6004" / "6004.00" all
 * normalize to "6004.00"), those types only need plain string equality
 * here -- comparison work was already done at normalization time, not
 * duplicated in a second parser. Only string-like types (string/address/
 * name) still need a conservative case/whitespace-insensitive comparison,
 * since normalizeString/normalizeAddress trim but do not case-fold.
 */

export type ComparableValueType =
  | "string" | "money" | "decimal" | "integer" | "percentage"
  | "boolean" | "date" | "duration_months" | "address" | "object" | "array";

function conservativeStringEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function arrayEqual(a: string, b: string): boolean {
  // Registry-defined ordered/set comparison -- no current concept uses
  // cardinality:"multiple"/value_type:"array" (all 88 concepts are single-
  // cardinality scalars), so this is a conservative default (order-
  // independent set comparison of a JSON-array-encoded string) pending a
  // real array concept that would define its own ordered-vs-set rule.
  try {
    const parsedA = JSON.parse(a);
    const parsedB = JSON.parse(b);
    if (!Array.isArray(parsedA) || !Array.isArray(parsedB)) return conservativeStringEqual(a, b);
    if (parsedA.length !== parsedB.length) return false;
    const setA = new Set(parsedA.map((v) => String(v).trim().toLowerCase()));
    const setB = new Set(parsedB.map((v) => String(v).trim().toLowerCase()));
    if (setA.size !== setB.size) return false;
    for (const v of setA) if (!setB.has(v)) return false;
    return true;
  } catch {
    return conservativeStringEqual(a, b);
  }
}

/**
 * Two normalized values are equal for conflict-detection purposes. Both
 * inputs must already be the output of claim-normalization.ts's
 * normalizeByStrategy -- this function does not re-parse raw input.
 */
export function claimValuesEqual(
  valueType: ComparableValueType | string,
  normalizedValueA: string | null,
  normalizedValueB: string | null,
): boolean {
  if (normalizedValueA === null && normalizedValueB === null) return true;
  if (normalizedValueA === null || normalizedValueB === null) return false;

  switch (valueType) {
    case "money":
    case "decimal":
    case "percentage":
    case "integer":
    case "date":
    case "boolean":
      // Already canonical strings -- exact match is the correct comparison.
      return normalizedValueA === normalizedValueB;
    case "array":
      return arrayEqual(normalizedValueA, normalizedValueB);
    case "address":
    case "string":
    default:
      return conservativeStringEqual(normalizedValueA, normalizedValueB);
  }
}

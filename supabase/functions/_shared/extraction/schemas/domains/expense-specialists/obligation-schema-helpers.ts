// @ts-nocheck
/**
 * Shared JSON-Schema fragment builders for the Phase 5 expense-specialist
 * obligation schemas.
 *
 * These are hand-authored, NOT derived from LEASE_SCHEMA the way
 * schema-registry.ts's buildDomainSchemaDefinition() is -- the 5 obligation
 * types (CamObligation/InsuranceObligation/UtilityObligation/TaxObligation/
 * RepairObligation) describe array-of-multi-property-object concepts that
 * don't exist as LEASE_SCHEMA fields at all (see the Phase 5 plan's
 * grounding correction #5). Same strict-mode conventions as
 * schema-registry.ts throughout: additionalProperties:false at every
 * object level, every property required (never omitted -- "not
 * applicable" is expressed via an explicit null/"not_stated" value),
 * nullable via anyOf+{type:"null"}, literal unions via enum, and explicit
 * maxItems on every array (correction E -- initial, tunable safety
 * bounds, not permanent limits).
 */

export const OBLIGATION_ARRAY_MAX_ITEMS = 12;
export const STRING_ARRAY_MAX_ITEMS = 20;

export function nullableString(): Record<string, unknown> {
  return { anyOf: [{ type: "string" }, { type: "null" }] };
}

export function nullableNumber(): Record<string, unknown> {
  return { anyOf: [{ type: "number" }, { type: "null" }] };
}

export function enumString(values: readonly string[]): Record<string, unknown> {
  return { type: "string", enum: [...values] };
}

export function stringArray(maxItems: number = STRING_ARRAY_MAX_ITEMS): Record<string, unknown> {
  return { type: "array", items: { type: "string" }, maxItems };
}

export const SOURCE_FIELDS = {
  sourcePage: nullableNumber(),
  sourceQuote: nullableString(),
} as const;

/**
 * Wraps a per-obligation object schema (properties/required already
 * built by the caller) into the top-level { obligations: [...] } envelope
 * every specialist schema shares, with the obligations array itself capped
 * at OBLIGATION_ARRAY_MAX_ITEMS.
 */
export function buildObligationListSchema(
  obligationSchema: Record<string, unknown>,
  maxItems: number = OBLIGATION_ARRAY_MAX_ITEMS,
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["obligations"],
    properties: {
      obligations: { type: "array", items: obligationSchema, maxItems },
    },
  };
}

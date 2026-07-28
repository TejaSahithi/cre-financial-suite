// @ts-nocheck
/**
 * Strict Structured Outputs pilot — schema registry primitives (Phase 1).
 *
 * Holds only the generic envelope-building machinery, no per-domain
 * knowledge and no dispatcher keyed on domain -- with a single piloted
 * domain (expenses_and_cam, see llm-strict-outputs-mode.ts's scope
 * rationale), a domain -> schema dispatcher here would be indirection with
 * exactly one real branch. adaptive-extractor.ts imports
 * domains/expenses-and-cam.v1.schema.ts's getExpensesAndCamStrictSchema()
 * directly. When a second domain is piloted, a small dispatcher belongs
 * here at that point -- not speculatively ahead of it.
 *
 * Deliberately NOT "the current field's type, but required": that would
 * only make the existing 23 UI values stricter without testing whether
 * strict outputs actually improve extraction. Every field instead resolves
 * to its own evidence envelope, matching the schema's own explicit/derived/
 * not_found/ambiguous/conflicting/illegible status vocabulary (schemas.ts's
 * extractionStatus concept, made a per-field structured citation instead of
 * a single free-text sourceText).
 */

import type { FieldDef } from "../schemas.ts";
import type { LlmCallDomain } from "../enrich-bounded-stage/domain-fields.ts";

export type StrictFieldStatus =
  | "explicit"
  | "derived"
  | "not_found"
  | "ambiguous"
  | "conflicting"
  | "illegible";

export const STRICT_FIELD_STATUS_VALUES: readonly StrictFieldStatus[] = [
  "explicit",
  "derived",
  "not_found",
  "ambiguous",
  "conflicting",
  "illegible",
];

export interface StrictExtractedField<T = unknown> {
  status: StrictFieldStatus;
  value: T | null;
  rawValue: string | null;
  sourceNodeIds: string[];
  sourceQuote: string | null;
  uncertaintyReason: string | null;
}

export interface DomainSchemaDefinition {
  domain: LlmCallDomain;
  /** OpenAI's json_schema.name -- must match ^[a-zA-Z0-9_-]+$. */
  schemaName: string;
  schemaVersion: string;
  fields: Array<[string, FieldDef]>;
  jsonSchema: Record<string, unknown>;
}

function fieldValueSchema(def: FieldDef): Record<string, unknown> {
  if (def.type === "enum" && def.enumValues && def.enumValues.length > 0) {
    return { anyOf: [{ type: "string", enum: [...def.enumValues] }, { type: "null" }] };
  }
  if (def.type === "number") return { anyOf: [{ type: "number" }, { type: "null" }] };
  if (def.type === "boolean") return { anyOf: [{ type: "boolean" }, { type: "null" }] };
  // "date" and plain "string" both serialize as strings in this envelope's
  // value slot -- date parsing/normalization stays a downstream concern,
  // same as it already is for the authoritative extraction path.
  return { anyOf: [{ type: "string" }, { type: "null" }] };
}

/** additionalProperties:false at every object level, not just the top one
 *  -- Azure/OpenAI strict mode enforces object shape per-level, and a field
 *  the model invents inside one envelope should be rejected exactly like
 *  one invented at the top level. */
function strictFieldEnvelopeSchema(def: FieldDef): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["status", "value", "rawValue", "sourceNodeIds", "sourceQuote", "uncertaintyReason"],
    properties: {
      status: { type: "string", enum: [...STRICT_FIELD_STATUS_VALUES] },
      value: fieldValueSchema(def),
      rawValue: { anyOf: [{ type: "string" }, { type: "null" }] },
      sourceNodeIds: { type: "array", items: { type: "string" } },
      sourceQuote: { anyOf: [{ type: "string" }, { type: "null" }] },
      uncertaintyReason: { anyOf: [{ type: "string" }, { type: "null" }] },
    },
  };
}

/**
 * Builds the full strict JSON Schema for a domain's field set: one envelope
 * per field, every field required (Azure/OpenAI strict mode's own rule --
 * "optional" is expressed via the envelope's own status:"not_found" +
 * value:null, never via key omission), additionalProperties:false at the
 * top level too.
 */
export function buildDomainSchemaDefinition(args: {
  domain: LlmCallDomain;
  schemaName: string;
  schemaVersion: string;
  fields: Array<[string, FieldDef]>;
}): DomainSchemaDefinition {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, def] of args.fields) {
    properties[key] = strictFieldEnvelopeSchema(def);
    required.push(key);
  }
  return {
    domain: args.domain,
    schemaName: args.schemaName,
    schemaVersion: args.schemaVersion,
    fields: args.fields,
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      required,
      properties,
    },
  };
}

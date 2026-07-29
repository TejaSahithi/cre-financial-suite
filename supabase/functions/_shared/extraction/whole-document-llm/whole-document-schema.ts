// @ts-nocheck

import type { FieldDef } from "../schemas.ts";

export const WHOLE_DOCUMENT_SCHEMA_VERSION = "lease-whole-document-v1";
export const WHOLE_DOCUMENT_SCHEMA_NAME = "lease_whole_document_v1";

export type WholeDocumentFieldStatus =
  | "found"
  | "not_stated"
  | "ambiguous"
  | "conflicting"
  | "illegible";

export interface WholeDocumentFieldResult {
  fieldKey: string;
  status: WholeDocumentFieldStatus;
  value: unknown;
  rawValue: string | null;
  sourceNodeIds: string[];
  sourceQuote: string | null;
  confidence: number;
  uncertaintyReason: string | null;
}

export interface WholeDocumentExtractionResponse {
  claims: WholeDocumentFieldResult[];
}

export function buildWholeDocumentJsonSchema(
  fields: Array<[string, FieldDef]>,
): Record<string, unknown> {
  const fieldKeys = fields.map(([fieldKey]) => fieldKey);
  return {
    type: "object",
    additionalProperties: false,
    required: ["claims"],
    properties: {
      claims: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "fieldKey",
            "status",
            "value",
            "rawValue",
            "sourceNodeIds",
            "sourceQuote",
            "confidence",
            "uncertaintyReason",
          ],
          properties: {
            fieldKey: { type: "string", enum: fieldKeys },
            status: {
              type: "string",
              enum: ["found", "not_stated", "ambiguous", "conflicting", "illegible"],
            },
            // Field-specific types/enums/ranges are checked mechanically
            // after the call. A single item schema keeps this strict schema
            // comfortably bounded even as LEASE_SCHEMA grows.
            value: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
            rawValue: { anyOf: [{ type: "string" }, { type: "null" }] },
            sourceNodeIds: { type: "array", items: { type: "string" } },
            sourceQuote: { anyOf: [{ type: "string" }, { type: "null" }] },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            uncertaintyReason: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
    },
  };
}

export function buildWholeDocumentSystemPrompt(
  fields: Array<[string, FieldDef]>,
): string {
  const fieldReference = fields.map(([key, def]) => {
    const enumText = def.type === "enum" && def.enumValues?.length
      ? ` Allowed values: ${def.enumValues.join(", ")}.`
      : "";
    return `- ${key} (${def.type}): ${def.description}${enumText}`;
  }).join("\n");

  return `You are the authoritative commercial-lease abstraction engine.

You receive ONE complete compact document produced by Azure Document Intelligence. Read the entire
JSON document before answering. You, not the caller, decide which pages, table rows, definitions,
exceptions, exhibits, schedules, and cross-references are relevant to every field.

Return exactly one claim for every schema field under "claims". Never return a field twice. Use:
- found: one explicit, well-supported value.
- not_stated: the complete document does not state the field.
- ambiguous: relevant language exists but does not support one clear value.
- conflicting: the document contains materially different competing values.
- illegible: OCR quality prevents a reliable determination.

EVIDENCE CONTRACT:
1. For found/ambiguous/conflicting, sourceQuote must be exact verbatim text from the compact JSON.
2. sourceNodeIds must contain the page/table-row/key-value IDs that support the answer.
3. Never invent an ID. IDs are printed directly in the JSON.
4. For not_stated, set value/rawValue/sourceQuote to null, sourceNodeIds to [], confidence to 1,
   and uncertaintyReason to null.
5. Do not calculate derived values. Extract only values explicitly stated in the document.
6. Dates must be YYYY-MM-DD when the exact calendar date is stated.
7. For conflicting provisions, prefer neither silently: use status conflicting, provide the best
   representative value only when useful, cite all competing nodes, and explain the conflict.
8. Definitions and cross-referenced provisions apply wherever the lease makes them applicable.
9. An amendment or rider may supersede the base lease; reflect the controlling language and cite
   both the superseding provision and the affected provision when necessary.
10. fieldKey must be copied exactly from the schema field list.

SCHEMA FIELDS:
${fieldReference}`;
}

// @ts-nocheck

import type { FieldDef } from "../schemas.ts";

export const WHOLE_DOCUMENT_SCHEMA_VERSION = "lease-whole-document-v2";
export const WHOLE_DOCUMENT_SCHEMA_NAME = "lease_whole_document_v2";

export type WholeDocumentFieldStatus =
  | "found"
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
  alternatives: Array<{
    value: unknown;
    sourceNodeIds: string[];
    sourceQuote: string;
  }>;
}

export interface WholeDocumentDynamicFinding {
  suggestedFieldKey: string;
  label: string;
  businessArea: string;
  valueType: "string" | "number" | "boolean" | "date" | "percentage" | "currency" | "schedule" | "clause";
  value: unknown;
  businessMeaning: string;
  criticality: "critical" | "high" | "medium" | "low";
  status: "found" | "ambiguous" | "conflicting" | "illegible";
  sourceNodeIds: string[];
  sourceQuote: string | null;
  confidence: number;
  uncertaintyReason: string | null;
}

export interface WholeDocumentExtractionResponse {
  claims: WholeDocumentFieldResult[];
  notStatedFieldKeys: string[];
  dynamicFindings: WholeDocumentDynamicFinding[];
}

export function buildWholeDocumentJsonSchema(
  fields: Array<[string, FieldDef]>,
): Record<string, unknown> {
  const fieldKeys = fields.map(([fieldKey]) => fieldKey);
  return {
    type: "object",
    additionalProperties: false,
    required: ["claims", "notStatedFieldKeys", "dynamicFindings"],
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
            "alternatives",
          ],
          properties: {
            fieldKey: { type: "string", enum: fieldKeys },
            status: {
              type: "string",
              enum: ["found", "ambiguous", "conflicting", "illegible"],
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
            alternatives: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["value", "sourceNodeIds", "sourceQuote"],
                properties: {
                  value: {
                    anyOf: [
                      { type: "string" },
                      { type: "number" },
                      { type: "boolean" },
                      { type: "null" },
                    ],
                  },
                  sourceNodeIds: { type: "array", items: { type: "string" } },
                  sourceQuote: { type: "string" },
                },
              },
            },
          },
        },
      },
      notStatedFieldKeys: {
        type: "array",
        items: { type: "string", enum: fieldKeys },
      },
      // The field key is intentionally NOT an enum here. The model may
      // propose any document-specific, commercially meaningful concept that
      // does not belong in the fixed lease schema.
      dynamicFindings: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "suggestedFieldKey",
            "label",
            "businessArea",
            "valueType",
            "value",
            "businessMeaning",
            "criticality",
            "status",
            "sourceNodeIds",
            "sourceQuote",
            "confidence",
            "uncertaintyReason",
          ],
          properties: {
            suggestedFieldKey: { type: "string" },
            label: { type: "string" },
            businessArea: { type: "string" },
            valueType: {
              type: "string",
              enum: ["string", "number", "boolean", "date", "percentage", "currency", "schedule", "clause"],
            },
            value: {
              anyOf: [
                { type: "string" },
                { type: "number" },
                { type: "boolean" },
                { type: "null" },
              ],
            },
            businessMeaning: { type: "string" },
            criticality: { type: "string", enum: ["critical", "high", "medium", "low"] },
            status: { type: "string", enum: ["found", "ambiguous", "conflicting", "illegible"] },
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

  return `PROFESSIONAL ROLE

You are a senior commercial real-estate broker, lease abstractor, lease administrator, asset
manager, property-accounting specialist, and office-operations leader with more than forty years
of hands-on experience. You have personally managed complex office, retail, industrial, medical,
ground, mixed-use, and corporate leases from negotiation through daily operations, billing,
reconciliation, renewals, defaults, assignments, and disposition.

Your experience helps you recognize commercial meaning and find related provisions. It is NEVER
evidence and must NEVER be used to fill a document gap. The executed document controls. Do not
assume a market-standard term, infer a customary obligation, or improve unfavorable drafting.

MISSION

You receive one complete compact document produced by Azure Document Intelligence. Read the entire
JSON document before answering. You—not the caller—decide which pages, table rows, definitions,
exceptions, exhibits, schedules, riders, amendments, and cross-references are relevant.

Perform these review passes silently before producing the JSON response:
1. Classify the document and every component: base lease, amendment, assignment, assumption,
   rider, addendum, exhibit, schedule, guaranty, memorandum, notice, or abstract.
2. Establish execution/effective dates, precedence, supersession, and which provision currently
   controls. Never publish a superseded term as the current term.
3. Build and apply the document's defined-term dictionary.
4. Build a chronology of commencement, delivery, possession, rent commencement, expiration,
   renewal, termination, option, notice, cure, audit, reconciliation, and critical dates.
5. Build a complete financial map: base rent, additional rent, escalations, free rent, abatements,
   deposits, percentage rent, CAM/operating expenses, exclusions, caps, base years, gross-ups,
   administrative fees, taxes, insurance, utilities, repairs, reimbursements, and one-time charges.
6. Build an actor/obligation map: who pays, performs, maintains, insures, repairs, replaces,
   approves, consents, delivers notice, and bears risk; include scope, conditions, exceptions,
   limits, frequency, deadlines, and remedies.
7. Review every table, exhibit, schedule, signature block, and cross-reference.
8. Extract the fixed-schema claims.
9. Conduct a second, independent completeness sweep for every commercially meaningful term that
   does not fit the fixed schema and report each one in dynamicFindings.
10. Challenge every proposed value against competing evidence and common field-confusion risks.

FIXED CLAIM CONTRACT

For every fixed schema field, return it in exactly ONE of these places:
- claims: fields with relevant evidence, including uncertain/conflicting evidence.
- notStatedFieldKeys: fields the complete document does not address.

Never return a field twice, and never put the same key in both collections. Detailed claims use:
- found: one explicit, well-supported value.
- ambiguous: relevant language exists but does not support one clear value.
- conflicting: the document contains materially different competing values.
- illegible: OCR quality prevents a reliable determination.

EVIDENCE CONTRACT:
1. For found/ambiguous/conflicting, sourceQuote must be exact verbatim text from the compact JSON.
2. sourceNodeIds must contain the page/table-row/key-value IDs that support the answer.
3. Never invent an ID. IDs are printed directly in the JSON.
4. ONLY status found may contain a non-null value. For ambiguous, conflicting, or illegible,
   value MUST be null. Preserve competing possibilities under alternatives.
5. Do not calculate derived values. Extract only values explicitly stated in the document.
6. Dates must be YYYY-MM-DD when the exact calendar date is stated.
7. For ambiguous/conflicting claims, cite the relevant nodes, explain the uncertainty, and put
   each supported possibility in alternatives. Never choose a convenient representative value.
8. Definitions and cross-referenced provisions apply wherever the lease makes them applicable.
9. An amendment or rider may supersede the base lease; reflect the controlling language and cite
   both the superseding provision and the affected provision when necessary.
10. fieldKey must be copied exactly from the fixed schema field list.
11. Do not place a fact in a fixed field merely because similar words appear. The actor, subject,
    obligation, economic purpose, timing, unit, scope, and defined meaning must match that field.
    When a real finding does not exactly fit, put it in dynamicFindings instead.

COMMON ERRORS THAT ARE PROHIBITED

- Do not confuse execution date, effective date, commencement date, delivery date, possession
  date, rent commencement date, expiration date, or an option-period date.
- Do not confuse monthly base rent, annual base rent, additional rent, estimated rent, percentage
  rent, a surcharge, a deposit, or a reimbursement.
- Do not confuse premises area, rentable area, usable area, building area, or expansion space.
- Do not confuse CAM with taxes, insurance, utilities, repairs, capital expenditures, or direct
  tenant payments merely because they are all occupancy costs.
- Do not confuse an expense amount with a cap, base year, gross-up percentage, pro-rata share,
  administrative fee, exclusion, audit right, or reconciliation deadline.
- Do not confuse tenant and landlord obligations, direct payment and reimbursement, maintenance
  and replacement, an option and an obligation, or a notice deadline and an effective date.
- Do not use a signatory, guarantor, broker, property manager, affiliate, assignee, or contact
  person as the tenant or landlord legal entity unless the document expressly makes that party so.

DYNAMIC DISCOVERY CONTRACT

dynamicFindings is mandatory and may contain ANY NUMBER of document-specific, commercially
meaningful fields. suggestedFieldKey is not limited to the fixed schema. Create one focused dynamic
finding per distinct obligation, right, restriction, exception, formula, threshold, schedule,
business risk, operational requirement, or critical date that the fixed schema cannot represent
accurately. Examples include percentage-rent breakpoints, exclusive-use rights, co-tenancy tests,
go-dark rights, kick-out rights, radius restrictions, HVAC overtime rates, generator obligations,
after-hours access, parking ratios/charges, signage criteria, restoration duties, environmental
indemnities, SNDA/estoppel deadlines, audit lookback periods, landlord-work milestones, tenant
improvement disbursement conditions, relocation rights, demolition rights, prohibited-use
details, security requirements, and multi-step rent schedules.

Do not create a dynamic duplicate of a fixed field. Do not hide a real term because no fixed field
exists. Do not combine unrelated provisions into one generic finding. Every dynamic finding must
have exact evidence and a concise businessMeaning explaining its operational or economic effect.
For an uncertain dynamic finding, value must be null and uncertaintyReason must explain why.

Use businessArea to recommend the most relevant Lease Review tab:
parties_premises, dates_term, rent_charges, expenses_recoveries, cam_rules, taxes, insurance,
utilities, repairs_maintenance, legal_options, critical_dates, notices, signatures,
documents_exhibits, or clause_records.

SCHEMA FIELDS:
${fieldReference}`;
}

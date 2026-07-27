// @ts-nocheck
/**
 * LLM Validation Layer — Post-Routing Field Correction
 *
 * Sits between the TypeScript router (fact-field-mapper.ts) and the final
 * output. Uses an LLM call to:
 *   A. VALIDATE: check that each populated field's value+sourceText actually
 *      belongs in that field per the schema description
 *   B. CORRECT: move mis-routed values to the right field
 *   C. FILL: assign unmapped facts to empty fields the TS router couldn't
 *      reach via keyword matching
 *
 * Design constraints:
 *   - Single LLM call (compact JSON in, compact JSON out)
 *   - Temperature 0 for deterministic output
 *   - Every value the LLM touches already has a sourceText ground truth —
 *     the LLM is NOT asked to invent values, only to route them
 *   - Graceful fallback: if the LLM call fails, the TS router's output is
 *     returned unchanged
 */

import { callLLMJSON } from "../../llm.ts";
import { getSchema, type FieldDef } from "../schemas.ts";
import type { ExtractedField, ExtractedRecord, ModuleType } from "../types.ts";
import type { Fact } from "./types.ts";

// ── Configuration ────────────────────────────────────────────────────────────

/** Maximum unmapped facts to send to the validation LLM. Beyond this we
 *  truncate to avoid prompt bloat — the most confident facts come first. */
const MAX_UNMAPPED_FACTS_FOR_VALIDATION = 40;

/** Maximum source_text characters per fact/field sent to the LLM. */
const MAX_SOURCE_TEXT_CHARS = 300;

function truncateSource(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_SOURCE_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_SOURCE_TEXT_CHARS)}…`
    : trimmed;
}

// ── Schema summary builder ───────────────────────────────────────────────────

/**
 * Builds a compact schema reference for the LLM prompt. Only includes
 * field name, type, description, and enum values (if applicable).
 * Excludes derived fields.
 */
function buildSchemaReference(moduleType: ModuleType): string {
  const schema = getSchema(moduleType);
  const lines: string[] = [];
  for (const [key, def] of Object.entries(schema)) {
    if ((def as FieldDef).derived) continue;
    const fieldDef = def as FieldDef;
    let line = `- ${key} (${fieldDef.type}): ${fieldDef.description}`;
    if (fieldDef.type === "enum" && fieldDef.enumValues) {
      line += ` [enum: ${fieldDef.enumValues.join(", ")}]`;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

// ── Prompt payload builders ──────────────────────────────────────────────────

interface MappedFieldSummary {
  field: string;
  value: unknown;
  source_text: string | null;
  confidence: number;
}

interface UnmappedFactSummary {
  index: number;
  category: string;
  value: unknown;
  source_text: string | null;
  source_page: number | null;
  confidence: number;
}

function buildMappedFieldsSummary(
  fields: Record<string, ExtractedField>,
): MappedFieldSummary[] {
  const result: MappedFieldSummary[] = [];
  for (const [key, field] of Object.entries(fields)) {
    if (field.value == null) continue;
    result.push({
      field: key,
      value: field.value,
      source_text: truncateSource(field.sourceText),
      confidence: field.confidence,
    });
  }
  return result;
}

function buildUnmappedFactsSummary(
  unmappedFacts: Fact[],
): UnmappedFactSummary[] {
  // Sort by confidence descending, take top N
  const sorted = [...unmappedFacts].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0),
  );
  const capped = sorted.slice(0, MAX_UNMAPPED_FACTS_FOR_VALIDATION);

  return capped.map((fact, i) => ({
    index: i,
    category: fact.category,
    value: fact.value,
    source_text: truncateSource(fact.sourceText),
    source_page: fact.sourcePage,
    confidence: fact.confidence,
  }));
}

// ── System prompt ────────────────────────────────────────────────────────────

const VALIDATION_SYSTEM_PROMPT = `You are a Commercial Real Estate (CRE) lease data validation expert.

Your job is to review and correct the field assignments made by an automated extraction pipeline. The pipeline extracted data from a lease document and attempted to map values to schema fields using keyword matching. Keyword matching is imprecise — values may be in the wrong fields, or correct values may have failed to map to any field at all.

You will receive:
1. SCHEMA: The complete list of schema fields with their types and descriptions.
2. MAPPED_FIELDS: Values the pipeline already assigned to fields (with source_text evidence).
3. UNMAPPED_FACTS: Values the pipeline extracted but could NOT assign to any field.

Your task:
A. VALIDATE each mapped field: Does the value + source_text actually belong in that field per the schema description? If NOT, mark it for removal or reassignment.
B. FILL empty fields: Check each unmapped fact — does it belong in a schema field that is currently empty? If yes, assign it.
C. CORRECT: If a mapped value belongs in a DIFFERENT field, move it.

RULES:
1. Output ONLY valid JSON — no explanation, no markdown.
2. You MUST NOT invent values. Every value you assign must come from either MAPPED_FIELDS or UNMAPPED_FACTS.
3. For enum fields, the value MUST be one of the allowed enum values listed in the schema.
4. Temperature is 0. Be precise and conservative.
5. Only make changes you are confident about. If unsure, leave the field as-is.
6. Pay special attention to responsibility fields (who pays for what) — these are the most commonly mis-routed.

OUTPUT FORMAT:
Return a JSON object with this exact shape:
{
  "corrections": [
    {
      "field": "<field_key>",
      "action": "set" | "remove" | "move",
      "value": <the value to set>,
      "source_text": "<verbatim source text>",
      "source_page": <page number or null>,
      "confidence": <0.0-1.0>,
      "reason": "<brief explanation>",
      "move_from": "<original field_key, only if action is move>"
    }
  ]
}

- "set": Assign an unmapped fact to an empty field.
- "remove": Remove a value from a field it was incorrectly assigned to.
- "move": Move a value from one field to another (combines remove + set).
- If no corrections are needed, return { "corrections": [] }.`;

// ── Validation call ──────────────────────────────────────────────────────────

export interface ValidationCorrection {
  field: string;
  action: "set" | "remove" | "move";
  value: unknown;
  source_text: string | null;
  source_page: number | null;
  confidence: number;
  reason: string;
  move_from?: string;
}

export interface ValidationResult {
  corrections: ValidationCorrection[];
  llmCallSucceeded: boolean;
  promptTokens: number;
  completionTokens: number;
  model: string | null;
  error: string | null;
}

function buildUserPrompt(
  schemaRef: string,
  mappedFields: MappedFieldSummary[],
  unmappedFacts: UnmappedFactSummary[],
  emptyFieldKeys: string[],
): string {
  return `SCHEMA:
${schemaRef}

MAPPED_FIELDS (${mappedFields.length} fields currently populated):
${JSON.stringify(mappedFields, null, 2)}

UNMAPPED_FACTS (${unmappedFacts.length} facts that could not be assigned to any field):
${JSON.stringify(unmappedFacts, null, 2)}

EMPTY_FIELDS (${emptyFieldKeys.length} schema fields that are currently empty — candidates for FILL):
${JSON.stringify(emptyFieldKeys)}

Review the mapped fields for accuracy against the schema descriptions. Then check if any unmapped facts should fill the empty fields. Return corrections in the specified JSON format.`;
}

/**
 * Run the LLM validation layer on the extraction output.
 *
 * Returns corrections to apply. On any failure, returns an empty corrections
 * array so the pipeline degrades gracefully to the TS router's output.
 */
export async function validateFieldAssignments(args: {
  records: ExtractedRecord[];
  unmappedFacts: Fact[];
  moduleType: ModuleType;
}): Promise<ValidationResult> {
  const { records, unmappedFacts, moduleType } = args;
  const currentFields = records[0]?.fields || {};

  const emptyResult: ValidationResult = {
    corrections: [],
    llmCallSucceeded: false,
    promptTokens: 0,
    completionTokens: 0,
    model: null,
    error: null,
  };

  try {
    // Build the schema reference
    const schemaRef = buildSchemaReference(moduleType);
    const schema = getSchema(moduleType);

    // Build mapped fields summary
    const mappedFields = buildMappedFieldsSummary(currentFields);

    // Build unmapped facts summary
    const unmappedSummary = buildUnmappedFactsSummary(unmappedFacts);

    // Identify empty fields (non-derived fields that have no value)
    const emptyFieldKeys = Object.keys(schema)
      .filter((key) => !(schema[key] as FieldDef).derived)
      .filter((key) => currentFields[key]?.value == null);

    // Skip validation if there's nothing to validate or fill
    if (mappedFields.length === 0 && unmappedSummary.length === 0) {
      console.log("[llm-validation] skipping — no mapped fields or unmapped facts to validate");
      return { ...emptyResult, llmCallSucceeded: true };
    }

    const userPrompt = buildUserPrompt(
      schemaRef,
      mappedFields,
      unmappedSummary,
      emptyFieldKeys,
    );

    console.log(
      `[llm-validation] calling LLM: ${mappedFields.length} mapped fields, ` +
      `${unmappedSummary.length} unmapped facts, ${emptyFieldKeys.length} empty fields`,
    );

    const response = await callLLMJSON({
      systemPrompt: VALIDATION_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0,
      promptVersion: "field-validation-v1",
    });

    const data = response.data as any;
    const corrections: ValidationCorrection[] = [];

    if (data?.corrections && Array.isArray(data.corrections)) {
      for (const c of data.corrections) {
        if (!c.field || !c.action) continue;
        // Only accept corrections for fields that actually exist in the schema
        if (!schema[c.field] && c.action !== "remove") continue;
        // For "move" actions, validate the source field too
        if (c.action === "move" && c.move_from && !schema[c.move_from]) continue;

        corrections.push({
          field: c.field,
          action: c.action,
          value: c.value ?? null,
          source_text: c.source_text ?? null,
          source_page: c.source_page ?? null,
          confidence: typeof c.confidence === "number" ? c.confidence : 0.5,
          reason: c.reason ?? "",
          move_from: c.move_from ?? undefined,
        });
      }
    }

    console.log(`[llm-validation] LLM returned ${corrections.length} corrections`);

    return {
      corrections,
      llmCallSucceeded: true,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      model: response.model,
      error: null,
    };
  } catch (error) {
    console.error(`[llm-validation] LLM call failed, falling back to TS router output: ${(error as Error)?.message}`);
    return {
      ...emptyResult,
      error: (error as Error)?.message ?? String(error),
    };
  }
}

// ── Apply corrections ────────────────────────────────────────────────────────

/**
 * Apply validated corrections to the extraction records.
 *
 * Mutations are applied in-place on the records[0].fields object.
 * Returns a summary of what was applied for diagnostics.
 */
export function applyValidationCorrections(args: {
  records: ExtractedRecord[];
  corrections: ValidationCorrection[];
  moduleType: ModuleType;
}): { applied: number; skipped: number; details: string[] } {
  const { records, corrections, moduleType } = args;
  const fields = records[0]?.fields;
  if (!fields) return { applied: 0, skipped: 0, details: [] };

  const schema = getSchema(moduleType);
  let applied = 0;
  let skipped = 0;
  const details: string[] = [];

  for (const correction of corrections) {
    const fieldDef = schema[correction.field] as FieldDef | undefined;

    switch (correction.action) {
      case "set": {
        // Only set if field is currently empty
        if (fields[correction.field]?.value != null) {
          details.push(`SKIP set ${correction.field}: field already populated`);
          skipped++;
          continue;
        }
        // Validate enum values
        if (fieldDef?.type === "enum" && fieldDef.enumValues) {
          const valStr = String(correction.value ?? "").toLowerCase();
          const isValidEnum = fieldDef.enumValues.some(
            (e) => e.toLowerCase() === valStr,
          );
          if (!isValidEnum) {
            details.push(
              `SKIP set ${correction.field}: "${correction.value}" is not a valid enum value [${fieldDef.enumValues.join(", ")}]`,
            );
            skipped++;
            continue;
          }
        }
        fields[correction.field] = {
          value: correction.value,
          source: "llm",
          confidence: correction.confidence,
          sourceText: correction.source_text ?? undefined,
          sourcePage: correction.source_page,
          extractionStatus: "extracted",
          requiresReview: true,
        };
        details.push(`SET ${correction.field} = "${correction.value}" (${correction.reason})`);
        applied++;
        break;
      }

      case "remove": {
        if (fields[correction.field]?.value == null) {
          details.push(`SKIP remove ${correction.field}: field is already empty`);
          skipped++;
          continue;
        }
        const removedValue = fields[correction.field].value;
        delete fields[correction.field];
        details.push(`REMOVE ${correction.field} (was "${removedValue}") — ${correction.reason}`);
        applied++;
        break;
      }

      case "move": {
        const sourceField = correction.move_from;
        if (!sourceField || fields[sourceField]?.value == null) {
          details.push(`SKIP move ${sourceField} → ${correction.field}: source field is empty or missing`);
          skipped++;
          continue;
        }
        if (fields[correction.field]?.value != null) {
          details.push(`SKIP move ${sourceField} → ${correction.field}: target field already populated`);
          skipped++;
          continue;
        }
        // Validate enum values for target
        if (fieldDef?.type === "enum" && fieldDef.enumValues) {
          const valStr = String(correction.value ?? "").toLowerCase();
          const isValidEnum = fieldDef.enumValues.some(
            (e) => e.toLowerCase() === valStr,
          );
          if (!isValidEnum) {
            details.push(
              `SKIP move to ${correction.field}: "${correction.value}" is not a valid enum value`,
            );
            skipped++;
            continue;
          }
        }
        // Remove from source
        delete fields[sourceField];
        // Set on target
        fields[correction.field] = {
          value: correction.value,
          source: "llm",
          confidence: correction.confidence,
          sourceText: correction.source_text ?? undefined,
          sourcePage: correction.source_page,
          extractionStatus: "extracted",
          requiresReview: true,
        };
        details.push(`MOVE ${sourceField} → ${correction.field} = "${correction.value}" (${correction.reason})`);
        applied++;
        break;
      }

      default:
        details.push(`SKIP unknown action "${correction.action}" for ${correction.field}`);
        skipped++;
    }
  }

  console.log(`[llm-validation] applied ${applied} corrections, skipped ${skipped}`);
  return { applied, skipped, details };
}

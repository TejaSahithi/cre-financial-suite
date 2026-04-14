// @ts-nocheck
/**
 * Extraction Pipeline — Step 3: LLM Fallback Extraction
 *
 * ONLY called for fields that Step 1 (rule) and Step 2 (table) could not extract.
 * Sends focused, field-wise prompts to Gemini with ONLY relevant text chunks.
 *
 * Key design rules:
 *   - NEVER pass entire document — only relevant chunks
 *   - Extract fields in small groups (3-7 fields per call)
 *   - Strict JSON output schema — no freeform text
 *   - NO calculations — LLM only reads raw values
 *   - If not found → null (never guess)
 *   - Temperature = 0 for deterministic extraction
 */

import type {
  DoclingOutput,
  ExtractedField,
  ExtractedRecord,
  StepResult,
  ModuleType,
  TextChunk,
  ExtractionInput,
} from "./types.ts";
import { getSchema, getFieldGroups, type FieldDef, type FieldGroup } from "./schemas.ts";
import { buildRelevantSnippet, chunkDocument } from "./chunker.ts";
import { callVertexAIJSON, callVertexAIFileJSON } from "../vertex-ai.ts";

// ── System prompt — short, strict, no room for hallucination ─────────────────

const LLM_SYSTEM_PROMPT = `You are a CRE data extraction tool.
You extract ONLY the specific fields requested from the provided text snippet.

RULES:
1. Output ONLY valid JSON — no explanation, no markdown, no preamble.
2. Return a JSON object with exactly the field keys requested.
3. If a field value is NOT found in the text, return null for that field.
4. NEVER guess, infer, or calculate values. Only extract what is explicitly stated.
5. NEVER calculate totals, annual amounts, or derived values.
6. Monetary values: plain numbers only. "$12,500" → 12500.
7. Dates: YYYY-MM-DD format. "January 1, 2024" → "2024-01-01".
8. Percentages: plain number. "3%" → 3.
9. Square footage: plain number. "12,000 SF" → 12000.`;

// ── Prompt builder for a field group ─────────────────────────────────────────

function buildFieldGroupPrompt(
  group: FieldGroup,
  fieldDefs: Record<string, FieldDef>,
  textSnippet: string,
  moduleType: string,
): string {
  const fieldDescriptions = group.fields
    .map((f) => {
      const def = fieldDefs[f];
      if (!def) return null;
      let desc = `  "${f}": ${def.description}`;
      if (def.type === "enum" && def.enumValues) {
        desc += ` (one of: ${def.enumValues.join(" | ")})`;
      }
      if (def.type === "date") desc += " (YYYY-MM-DD)";
      if (def.type === "number") desc += " (plain number, no $ or commas)";
      return desc;
    })
    .filter(Boolean)
    .join("\n");

  return `Extract these ${moduleType} fields from the text below.
Context: ${group.hint}

FIELDS TO EXTRACT (return null if not found):
{
${fieldDescriptions}
}

TEXT SNIPPET:
───────────────────────────
${textSnippet || "[No text provided, refer to the attached visual document]"}
───────────────────────────

Return ONLY a JSON object with the field keys above. Nothing else.`;
}

// ── Prompt builder for multi-row extraction from table text ───────────────────

function buildMultiRowPrompt(
  fields: string[],
  fieldDefs: Record<string, FieldDef>,
  textSnippet: string,
  moduleType: string,
): string {
  const fieldDescriptions = fields
    .map((f) => {
      const def = fieldDefs[f];
      if (!def) return null;
      let desc = `  "${f}": ${def.description}`;
      if (def.type === "enum" && def.enumValues) {
        desc += ` (one of: ${def.enumValues.join(" | ")})`;
      }
      return desc;
    })
    .filter(Boolean)
    .join("\n");

  return `Extract ALL ${moduleType} records from the text below.
Each record should have ONLY these fields (null if missing):

{
${fieldDescriptions}
}

Return a JSON ARRAY of objects. Each distinct record = one object.
If there is only one record, still return an array with one object.

TEXT:
───────────────────────────
${textSnippet}
───────────────────────────

Return ONLY the JSON array. Nothing else.`;
}

// ── Parse LLM response safely ────────────────────────────────────────────────

function parseLLMResponse(raw: unknown, expectedFields: string[]): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object") return null;

  const result: Record<string, unknown> = {};
  const obj = raw as Record<string, unknown>;

  for (const field of expectedFields) {
    result[field] = obj[field] ?? null;
  }

  return result;
}

function parseLLMArrayResponse(raw: unknown, expectedFields: string[]): Array<Record<string, unknown>> {
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const result: Record<string, unknown> = {};
      const obj = item as Record<string, unknown>;
      for (const field of expectedFields) {
        result[field] = obj[field] ?? null;
      }
      return result;
    });
}

// ── Main: LLM field-wise extraction ──────────────────────────────────────────

/**
 * Step 3 of the extraction pipeline.
 *
 * Only extracts fields that are MISSING from previous steps.
 * Uses targeted prompts with relevant text snippets.
 *
 * @param docling      Full Docling output
 * @param missingFields Fields not yet extracted (by record index)
 * @param moduleType   The module being extracted
 * @param existingRecords  Records from Steps 1+2 (for context on how many rows to expect)
 */
export async function extractWithLLM(
  input: ExtractionInput,
  docling: DoclingOutput,
  missingFields: string[],
  moduleType: ModuleType,
  existingRecords: ExtractedRecord[],
  options: { maxChunks?: number; temperature?: number } = {},
): Promise<StepResult> {
  const schema = getSchema(moduleType);
  const groups = getFieldGroups(moduleType);
  const warnings: string[] = [];
  const { maxChunks = 6, temperature = 0 } = options;

  // Check if Vertex AI is available
  const hasVertexAI =
    !!Deno.env.get("VERTEX_PROJECT_ID") &&
    !!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");

  if (!hasVertexAI) {
    const missingVars: string[] = [];
    if (!Deno.env.get("VERTEX_PROJECT_ID")) missingVars.push("VERTEX_PROJECT_ID");
    if (!Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")) missingVars.push("GOOGLE_SERVICE_ACCOUNT_KEY");
    const msg =
      `Vertex AI not configured — missing env vars: [${missingVars.join(", ")}]. ` +
      `LLM extraction skipped. Fields requiring AI: [${missingFields.join(", ")}].`;
    console.warn(`[llm-extractor] ${msg}`);
    warnings.push(msg);
    return { records: [], warnings };
  }

  if (missingFields.length === 0) {
    return { records: [], warnings: ["No missing fields — LLM extraction skipped"] };
  }

  // Filter groups to only include groups with missing fields
  const relevantGroups = groups
    .map((g) => ({
      ...g,
      fields: g.fields.filter((f) => missingFields.includes(f)),
    }))
    .filter((g) => g.fields.length > 0);

  if (relevantGroups.length === 0) {
    return { records: [], warnings: ["No field groups match missing fields"] };
  }

  // Determine extraction strategy:
  // - If we have existing multi-row records from tables → fill in missing fields per-group
  // - If no existing records → try multi-row extraction from chunks
  const isMultiRow = existingRecords.length > 1;

  if (isMultiRow) {
    // Fill missing fields for existing records using field-group prompts
    return await fillMissingFieldsForRecords(
      input, docling, relevantGroups, schema, moduleType, existingRecords, temperature, warnings,
    );
  }

  // Single-record or no existing records → extract per group
  return await extractFieldGroups(
    input, docling, relevantGroups, schema, moduleType, missingFields, maxChunks, temperature, warnings,
  );
}

// ── Strategy A: Fill missing fields for existing multi-row records ────────────

async function fillMissingFieldsForRecords(
  input: ExtractionInput,
  docling: DoclingOutput,
  groups: FieldGroup[],
  schema: Record<string, FieldDef>,
  moduleType: ModuleType,
  existingRecords: ExtractedRecord[],
  temperature: number,
  warnings: string[],
): Promise<StepResult> {
  const records: ExtractedRecord[] = [];

  // Collect all labels from the missing fields for snippet building
  const allLabels: string[] = [];
  for (const group of groups) {
    for (const f of group.fields) {
      if (schema[f]?.labels) allLabels.push(...schema[f].labels);
    }
  }

  for (const group of groups) {
    const snippet = buildRelevantSnippet(docling, allLabels, 2000);
    const prompt = buildMultiRowPrompt(group.fields, schema, snippet, moduleType);

    try {
      let result;
      if (input.fileBase64) {
        result = await callVertexAIFileJSON({
          systemPrompt: LLM_SYSTEM_PROMPT,
          userPrompt: prompt,
          maxOutputTokens: 4096,
          temperature,
          fileBytes: Uint8Array.from(atob(input.fileBase64), c => c.charCodeAt(0)),
          fileMimeType: input.fileMimeType || "application/pdf"
        });
      } else {
        result = await callVertexAIJSON({
          systemPrompt: LLM_SYSTEM_PROMPT,
          userPrompt: prompt,
          maxOutputTokens: 4096,
          temperature,
        });
      }

      const parsed = parseLLMArrayResponse(result, group.fields);

      // Map LLM rows back to existing record indices
      for (let i = 0; i < Math.min(parsed.length, existingRecords.length); i++) {
        if (!records[i]) {
          records[i] = { fields: {}, rowIndex: i };
        }
        for (const [field, value] of Object.entries(parsed[i])) {
          if (value !== null && value !== undefined) {
            records[i].fields[field] = {
              value,
              source: "llm",
              confidence: 0.70,
              sourceText: `LLM extracted (group: ${group.name})`,
            };
          }
        }
      }
    } catch (err) {
      warnings.push(`LLM group "${group.name}" failed: ${err.message}`);
    }
  }

  return { records, warnings };
}

// ── Strategy B: Extract field groups for single-record documents ──────────────

async function extractFieldGroups(
  input: ExtractionInput,
  docling: DoclingOutput,
  groups: FieldGroup[],
  schema: Record<string, FieldDef>,
  moduleType: ModuleType,
  missingFields: string[],
  maxChunks: number,
  temperature: number,
  warnings: string[],
): Promise<StepResult> {
  const chunks = chunkDocument(docling);
  const chunksToProcess = chunks.slice(0, maxChunks);
  const merged: Record<string, ExtractedField> = {};

  for (const group of groups) {
    // Collect labels for this group's fields
    const labels: string[] = [];
    for (const f of group.fields) {
      if (schema[f]?.labels) labels.push(...schema[f].labels);
    }

    // Build a focused snippet instead of sending entire chunks
    const snippet = buildRelevantSnippet(docling, labels, 2000);
    const prompt = buildFieldGroupPrompt(group, schema, snippet, moduleType);

    try {
      let result;
      if (input.fileBase64) {
        result = await callVertexAIFileJSON({
          systemPrompt: LLM_SYSTEM_PROMPT,
          userPrompt: prompt,
          maxOutputTokens: 2048,
          temperature,
          fileBytes: Uint8Array.from(atob(input.fileBase64), c => c.charCodeAt(0)),
          fileMimeType: input.fileMimeType || "application/pdf"
        });
      } else {
        result = await callVertexAIJSON({
          systemPrompt: LLM_SYSTEM_PROMPT,
          userPrompt: prompt,
          maxOutputTokens: 2048,
          temperature,
        });
      }

      const parsed = parseLLMResponse(result, group.fields);
      if (parsed) {
        for (const [field, value] of Object.entries(parsed)) {
          if (value !== null && value !== undefined && !merged[field]) {
            merged[field] = {
              value,
              source: "llm",
              confidence: 0.70,
              sourceText: `LLM extracted (group: ${group.name})`,
            };
          }
        }
      }
    } catch (err) {
      warnings.push(`LLM group "${group.name}" failed: ${err.message}`);
    }
  }

  if (Object.keys(merged).length === 0) {
    return { records: [], warnings };
  }

  return {
    records: [{ fields: merged, rowIndex: 0 }],
    warnings,
  };
}

// @ts-nocheck
/**
 * Self-Consistency Verification Pass — LLM-Primary Mapping's Own Second Look
 *
 * Runs after adaptive-extractor.ts's schema-aware domain calls have assigned
 * fields directly (LLM_PRIMARY_MAPPING_MODE=active). This is NOT an
 * independent second-guesser: it reviews only the fields this exact run's
 * LLM-primary mapper itself set (fact-field-mapper.ts tags these
 * `llmPrimaryMapped: true`), each already carrying its own cited
 * source_text. It never sees facts the semantic-compatibility gate already
 * rejected, and it never sees fields it didn't itself propose — closing the
 * gap the original (pre-rework) version of this file had, where it reviewed
 * `unmappedFacts` stripped of any rejection context and could freely
 * move/remove values it had no history with.
 *
 * Narrow mandate, matching that scope: for each field, does the cited
 * source_text actually support the value for THIS field's specific meaning?
 * "confirm" (leave as-is) or "null" (the citation doesn't hold up on a
 * second read) -- never "move" a value to a different field. If a value
 * belongs somewhere else, that is a mapping decision, which is
 * adaptive-extractor.ts's job, not this pass's.
 *
 * Design constraints (unchanged from the original):
 *   - Single LLM call (compact JSON in, compact JSON out)
 *   - Temperature 0 for deterministic output
 *   - The LLM is NOT asked to invent values, only to confirm or reject
 *   - Graceful fallback: if the LLM call fails, every field is left as the
 *     schema-aware mapper produced it
 */

import { callLLMJSON } from "../../llm.ts";
import { getSchema, type FieldDef } from "../schemas.ts";
import type { ExtractedField, ExtractedRecord, ModuleType } from "../types.ts";

// ── Configuration ────────────────────────────────────────────────────────────

/** Maximum source_text characters per field sent to the LLM. */
const MAX_SOURCE_TEXT_CHARS = 300;

function truncateSource(text: string | null | undefined): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_SOURCE_TEXT_CHARS
    ? `${trimmed.slice(0, MAX_SOURCE_TEXT_CHARS)}…`
    : trimmed;
}

// ── System prompt ────────────────────────────────────────────────────────────

const VERIFICATION_SYSTEM_PROMPT = `You are a Commercial Real Estate (CRE) lease data verification expert.

An automated pipeline already assigned each field below to a value, citing an exact quote from the
lease as evidence. Your ONLY job is to re-check each citation with fresh eyes: does the quote
actually, specifically support the value for that field's stated meaning?

You are NOT re-mapping or re-extracting. You are NOT allowed to move a value to a different field or
invent a replacement value. You may only:
- "confirm": the quote genuinely supports this value for this field's meaning.
- "null": the quote does NOT support this value for this field (e.g. the quote describes a
  different concept, a surcharge rather than base rent, a signature date rather than a lease term
  date, boilerplate rather than an actual party/signatory name, an operand rather than a computed
  total) -- the field should be cleared rather than shown as a confident answer.

RULES:
1. Output ONLY valid JSON -- no explanation, no markdown.
2. Base your decision only on the field's meaning and the cited quote -- do not use outside
   knowledge about what a typical lease contains.
3. Temperature is 0. Be precise and conservative -- when genuinely unsure, "confirm" (do not null a
   plausible answer just because a stronger citation might theoretically exist elsewhere).
4. Every field below MUST appear exactly once in your response.

OUTPUT FORMAT:
{
  "results": [
    { "field": "<field_key>", "decision": "confirm" | "null", "reason": "<brief explanation>" }
  ]
}`;

// ── Verification call ────────────────────────────────────────────────────────

export interface FieldVerificationResult {
  field: string;
  decision: "confirm" | "null";
  reason: string;
}

export interface ValidationResult {
  results: FieldVerificationResult[];
  llmCallSucceeded: boolean;
  promptTokens: number;
  completionTokens: number;
  model: string | null;
  error: string | null;
}

interface ReviewCandidate {
  field: string;
  value: unknown;
  sourceText: string | null;
  description: string;
}

function buildUserPrompt(candidates: ReviewCandidate[]): string {
  const payload = candidates.map((c) => ({
    field: c.field,
    field_meaning: c.description,
    value: c.value,
    source_text: truncateSource(c.sourceText),
  }));
  return `FIELDS TO VERIFY (${payload.length}):
${JSON.stringify(payload, null, 2)}

For each field above, decide "confirm" or "null" per the rules. Return a "results" entry for every
field listed, in any order.`;
}

/**
 * Run the self-consistency verification pass over exactly the fields this
 * run's LLM-primary mapper set (records[0].fields entries with
 * llmPrimaryMapped === true). Any other field is out of scope by
 * construction -- this function does not accept a broader list.
 *
 * Returns per-field confirm/null decisions. On any failure, returns an empty
 * results array so the pipeline degrades gracefully to the mapper's own
 * output, unchanged.
 */
export async function validateFieldAssignments(args: {
  records: ExtractedRecord[];
  moduleType: ModuleType;
}): Promise<ValidationResult> {
  const { records, moduleType } = args;
  const currentFields: Record<string, ExtractedField> = records[0]?.fields || {};

  const emptyResult: ValidationResult = {
    results: [],
    llmCallSucceeded: false,
    promptTokens: 0,
    completionTokens: 0,
    model: null,
    error: null,
  };

  try {
    const schema = getSchema(moduleType);
    const candidates: ReviewCandidate[] = [];
    for (const [fieldKey, field] of Object.entries(currentFields)) {
      if (!(field as any)?.llmPrimaryMapped) continue; // out of scope -- not set by this run's schema-aware mapper
      if (field.value == null) continue;
      const fieldDef = schema[fieldKey] as FieldDef | undefined;
      candidates.push({
        field: fieldKey,
        value: field.value,
        sourceText: field.sourceText ?? null,
        description: fieldDef?.description ?? fieldKey,
      });
    }

    if (candidates.length === 0) {
      console.log("[llm-verification] skipping -- no llmPrimaryMapped fields to verify");
      return { ...emptyResult, llmCallSucceeded: true };
    }

    const userPrompt = buildUserPrompt(candidates);
    console.log(`[llm-verification] calling LLM: ${candidates.length} fields to verify`);

    const response = await callLLMJSON({
      systemPrompt: VERIFICATION_SYSTEM_PROMPT,
      userPrompt,
      temperature: 0,
      promptVersion: "llm-primary-mapping-verification-v1",
    });

    const data = response.data as any;
    const results: FieldVerificationResult[] = [];
    const validFieldKeys = new Set(candidates.map((c) => c.field));

    if (data?.results && Array.isArray(data.results)) {
      for (const r of data.results) {
        if (!r?.field || !validFieldKeys.has(r.field)) continue;
        const decision = r.decision === "null" ? "null" : "confirm"; // unrecognized/missing decision defaults to the conservative "confirm"
        results.push({ field: r.field, decision, reason: String(r.reason ?? "") });
      }
    }

    console.log(`[llm-verification] LLM returned ${results.length}/${candidates.length} verification results`);

    return {
      results,
      llmCallSucceeded: true,
      promptTokens: response.promptTokens,
      completionTokens: response.completionTokens,
      model: response.model,
      error: null,
    };
  } catch (error) {
    console.error(`[llm-verification] LLM call failed, leaving fields as the mapper produced them: ${(error as Error)?.message}`);
    return {
      ...emptyResult,
      error: (error as Error)?.message ?? String(error),
    };
  }
}

// ── Apply verification results ───────────────────────────────────────────────

/**
 * Apply verification decisions to the extraction records. Only "null"
 * decisions change anything (clear the field, preserving nothing else about
 * it); "confirm" is a no-op by design -- the field already carries its own
 * evidence and confidence from the mapper, this pass does not re-score it.
 */
export function applyValidationCorrections(args: {
  records: ExtractedRecord[];
  results: FieldVerificationResult[];
}): { cleared: number; confirmed: number; details: string[] } {
  const { records, results } = args;
  const fields = records[0]?.fields;
  if (!fields) return { cleared: 0, confirmed: 0, details: [] };

  let cleared = 0;
  let confirmed = 0;
  const details: string[] = [];

  for (const result of results) {
    const existing = fields[result.field];
    if (!existing?.llmPrimaryMapped) {
      details.push(`SKIP ${result.field}: not an llmPrimaryMapped field (out of scope)`);
      continue;
    }
    if (result.decision === "confirm") {
      confirmed++;
      details.push(`CONFIRM ${result.field} = "${existing.value}" (${result.reason})`);
      continue;
    }
    const previousValue = existing.value;
    delete fields[result.field];
    cleared++;
    details.push(`NULL ${result.field} (was "${previousValue}") — ${result.reason}`);
  }

  console.log(`[llm-verification] confirmed ${confirmed}, cleared ${cleared}`);
  return { cleared, confirmed, details };
}

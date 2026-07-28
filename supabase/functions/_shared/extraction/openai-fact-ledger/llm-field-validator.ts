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
 * FAILS CLOSED, not open: only a literal "confirm" response counts as
 * confirmed. A malformed decision, an unrecognized value, or a field the
 * model's response never mentions at all is treated as "uncertain" --
 * flagged extractionStatus="needs_review" rather than either cleared or
 * silently trusted as verified. The original version of this pass defaulted
 * anything that wasn't literally "null" to "confirm", including responses
 * that never addressed the field at all -- ambiguity was being upgraded into
 * confidence. See applyValidationCorrections() for where this is enforced.
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
3. Temperature is 0. Be precise. If the quote is genuinely ambiguous -- it could plausibly support
   the value but you are not confident -- use "uncertain" rather than guessing either way. Do NOT
   null a plausible answer just because a stronger citation might theoretically exist elsewhere,
   and do NOT confirm a citation you are not actually confident about merely to avoid saying
   "uncertain".
4. Every field below MUST appear exactly once in your response.

OUTPUT FORMAT:
{
  "results": [
    { "field": "<field_key>", "decision": "confirm" | "null" | "uncertain", "reason": "<brief explanation>" }
  ]
}`;

// ── Verification call ────────────────────────────────────────────────────────

export interface FieldVerificationResult {
  field: string;
  decision: "confirm" | "null" | "uncertain";
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

For each field above, decide "confirm", "null", or "uncertain" per the rules. Return a "results"
entry for every field listed, in any order. A field with no entry in your response will be treated
as unverified and flagged for human review -- it will NOT be treated as confirmed.`;
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
    const seenFieldKeys = new Set<string>();

    if (data?.results && Array.isArray(data.results)) {
      for (const r of data.results) {
        if (!r?.field || !validFieldKeys.has(r.field)) continue;
        if (seenFieldKeys.has(r.field)) continue; // first decision for a field wins if the model repeats one
        seenFieldKeys.add(r.field);
        // FAIL CLOSED: only a literal "confirm" or "null" is trusted as a real
        // decision. Anything else the model returns (typo, unexpected value,
        // missing field on the object) becomes "uncertain" -- never silently
        // upgraded to "confirm".
        const rawDecision = typeof r.decision === "string" ? r.decision.toLowerCase() : "";
        const decision: FieldVerificationResult["decision"] =
          rawDecision === "confirm" ? "confirm" : rawDecision === "null" ? "null" : "uncertain";
        results.push({ field: r.field, decision, reason: String(r.reason ?? "") });
      }
    }

    // FAIL CLOSED: a field this pass sent for review but that never appears
    // anywhere in the model's response (despite the prompt requiring every
    // field to appear exactly once) is unverified, not confirmed by default.
    for (const candidate of candidates) {
      if (!seenFieldKeys.has(candidate.field)) {
        results.push({ field: candidate.field, decision: "uncertain", reason: "model returned no decision for this field" });
      }
    }

    console.log(`[llm-verification] LLM returned ${seenFieldKeys.size}/${candidates.length} explicit verification results (${results.length - seenFieldKeys.size} defaulted to uncertain)`);

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
 * Apply verification decisions to the extraction records.
 * - "confirm": no-op -- the field already carries its own evidence and
 *   confidence from the mapper, this pass does not re-score it.
 * - "null": the citation didn't hold up -- clear the field entirely.
 * - "uncertain" (fail-closed default for anything not explicitly "confirm"
 *   or "null", including a field the model's response never addressed):
 *   the value is NOT cleared (an uncertain verifier is not grounds to
 *   destroy a possibly-correct value) but it is never silently treated as
 *   clean either -- flagged extractionStatus="needs_review" so a reviewer
 *   sees this field was not actually confirmed.
 */
export function applyValidationCorrections(args: {
  records: ExtractedRecord[];
  results: FieldVerificationResult[];
}): { cleared: number; confirmed: number; uncertain: number; details: string[] } {
  const { records, results } = args;
  const fields = records[0]?.fields;
  if (!fields) return { cleared: 0, confirmed: 0, uncertain: 0, details: [] };

  let cleared = 0;
  let confirmed = 0;
  let uncertain = 0;
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
    if (result.decision === "null") {
      const previousValue = existing.value;
      delete fields[result.field];
      cleared++;
      details.push(`NULL ${result.field} (was "${previousValue}") — ${result.reason}`);
      continue;
    }
    // "uncertain" -- fail closed: keep the value, flag it, never confirm it silently.
    existing.extractionStatus = "needs_review";
    existing.requiresReview = true;
    uncertain++;
    details.push(`UNCERTAIN ${result.field} = "${existing.value}" -- flagged for review, not auto-confirmed (${result.reason})`);
  }

  console.log(`[llm-verification] confirmed ${confirmed}, cleared ${cleared}, uncertain ${uncertain}`);
  return { cleared, confirmed, uncertain, details };
}

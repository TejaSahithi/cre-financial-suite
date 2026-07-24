// @ts-nocheck
/**
 * OpenAI Fact Ledger — Fact → Standard Field Mapper
 *
 * Deterministic (no LLM). Scores each fact against every LEASE_SCHEMA field's
 * labels[] PLUS field-contract.ts's aliases for that field (the other
 * vocabularies' names for the same concept — e.g. a fact phrased using
 * "tenant's notice address" should still map onto tenant_address even
 * though that field's own LEASE_SCHEMA labels list is short). This is what
 * closes the parity gap legacy_hybrid didn't have: legacy_hybrid's rule
 * extractor and LLM groups already benefit from lease-workflow.ts's
 * FIELD_SPECS aliases via buildLeaseFieldMap()'s getFirstValue(row,
 * spec.aliases); this mapper previously had no equivalent. Calls the
 * existing, unmodified validateRecords() from validator.ts so type/range/
 * enum enforcement and lease cross-field sanity checks are identical to
 * legacy_hybrid — this module never reimplements validation.
 *
 * Facts that don't clear a real label match for any field pass through
 * untouched as unmappedFacts, for dynamic-fact-surfacer.ts to surface.
 */

import { getSchema, type FieldDef } from "../schemas.ts";
import { validateRecords } from "../validator.ts";
import { getFieldContract } from "../field-contract.ts";
import { evaluateCandidateForField } from "../candidate-decision.ts";
import type { ExtractedField, ExtractedRecord, ModuleType } from "../types.ts";
import type { Fact, FactFieldMappingResult } from "./types.ts";

const MIN_LABEL_SCORE = 3; // shortest meaningful label match (e.g. "by:" is too weak alone)

/**
 * Domain-aware (Release 1): fact.category is a real classified value (the
 * 34-clause CLAUSE_DEFINITIONS vocabulary), a stronger signal than keyword
 * length alone. A category explicitly rejected for this field hard-vetoes
 * the candidate before any keyword scoring happens — this is the actual
 * fix for a late-payment clause outscoring a CAM field's own weaker labels
 * (e.g. "administrative fee" matching admin_fee_pct's label list even when
 * the clause is genuinely about late fees, not CAM).
 */
function scoreFactAgainstField(fact: Fact, fieldName: string, def: FieldDef, moduleType: ModuleType): number {
  const decision = evaluateCandidateForField({
    field: def,
    fieldKey: fieldName,
    moduleType,
    value: fact.value,
    sourceText: fact.sourceText,
    factCategory: fact.category,
    confidence: fact.confidence,
    sourceType: "fact_ledger",
  });
  if (decision.decision === "reject") return 0;

  const haystack = `${fact.sourceText} ${String(fact.value ?? "")}`.toLowerCase();
  let score = 0;
  const contract = getFieldContract(fieldName);
  const candidateLabels = [...(def.labels || []), ...(contract?.aliases || [])];
  for (const label of candidateLabels) {
    const needle = label.toLowerCase().replace(/_/g, " ");
    if (needle.length < 3) continue;
    if (haystack.includes(needle)) score = Math.max(score, needle.length);
  }

  // Only bonus an "accept" driven by a REAL classified category match
  // (matchedAllowedCategories non-empty) -- an "accept" reached via
  // candidate-decision.ts's step-6 text fallback (no category available)
  // is derived from this same field's own `labels`, the identical signal
  // `score` above already counted; bonusing it again let an unconfigured
  // field's own more-specific label match get outscored by a shorter match
  // that only "won" because this field happened to have evidencePolicy
  // configured (a real regression this fixed: see field-contract.test.ts's
  // tax_responsibility/responsibility_taxes duplicate-concept-field test).
  if (decision.decision === "accept" && decision.matchedAllowedCategories.length > 0) score += 10;
  else if (decision.decision === "needs_review") score = Math.floor(score / 2); // cross-domain candidate — heavy penalty, not a hard zero

  return score;
}

/** Best-effort date parse, defensive against unparseable/garbled OCR text
 *  (e.g. "IST March 2019" from a misread "1st"). Returns null rather than
 *  NaN/Invalid Date so callers can safely skip a fact they can't parse
 *  instead of risking a wrong chronological assignment. */
function tryParseDate(value: unknown): Date | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const direct = new Date(text);
  if (!Number.isNaN(direct.getTime())) return direct;
  // Strip ordinal suffixes ("1st"/"2nd"/"3rd"/"4th") — a common source-text
  // shape Date.parse doesn't handle ("1st March 2019").
  const stripped = text.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, "$1");
  const retry = new Date(stripped);
  return Number.isNaN(retry.getTime()) ? null : retry;
}

/**
 * Deterministic safety net for the "lease term shall be from [START] through
 * [END]" shape — a single compound sentence stating both the start and end
 * date together, with no field-specific label word ("commencement",
 * "expiration") anywhere in it. The fact-ledger prompt is instructed to
 * split this into two distinct facts (see fact-ledger-extractor.ts's "LEASE
 * TERM DATES" instruction), both category "clause:lease_term" — but
 * per-field keyword/category scoring alone can't tell them apart: both
 * facts share the same sourceText, so they'd score IDENTICALLY against
 * start_date/end_date/commencement_date/expiration_date regardless of which
 * one is actually earlier, and ties always resolve to whichever field is
 * declared first in the schema — leaving the other field permanently empty
 * rather than wrong. This resolves that specific, narrow ambiguity the only
 * way it CAN be resolved generically: the earlier calendar date is the
 * start, the later one is the end. Only engages when there are exactly two
 * distinct, successfully-parsed lease_term-categorized dates; anything else
 * (0, 1, or 3+ candidates, or a parse failure) falls through to normal
 * per-field scoring unchanged.
 */
function resolveLeaseTermDatePair(facts: Fact[]): { consumed: Set<Fact>; assignments: Record<string, Fact> } {
  const candidates = facts
    .filter((fact) => fact.category === "clause:lease_term")
    .map((fact) => ({ fact, date: tryParseDate(fact.value) }))
    .filter((entry): entry is { fact: Fact; date: Date } => entry.date !== null);

  const consumed = new Set<Fact>();
  const assignments: Record<string, Fact> = {};
  if (candidates.length < 2) return { consumed, assignments };

  // Two distinct calendar dates only -- 3+ candidates (e.g. a renewal-option
  // deadline also miscategorized as lease_term) is ambiguous enough that
  // guessing is worse than leaving it to normal scoring/unmapped.
  const distinctTimes = new Set(candidates.map((c) => c.date.getTime()));
  if (distinctTimes.size !== 2) return { consumed, assignments };

  const sorted = [...candidates].sort((a, b) => a.date.getTime() - b.date.getTime());
  const earliest = sorted[0].fact;
  const latest = sorted[sorted.length - 1].fact;

  for (const field of ["start_date", "commencement_date"]) assignments[field] = earliest;
  for (const field of ["end_date", "expiration_date"]) assignments[field] = latest;
  consumed.add(earliest);
  consumed.add(latest);
  return { consumed, assignments };
}

/**
 * Map a flat fact ledger onto LEASE_SCHEMA (or the given module's schema)
 * standard fields. Produces exactly one ExtractedRecord (rowIndex 0) — every
 * module this pipeline serves today is single-row per document.
 */
export function mapFactsToStandardFields(args: {
  facts: Fact[];
  moduleType: ModuleType;
}): FactFieldMappingResult {
  const { facts, moduleType } = args;
  const schema = getSchema(moduleType);
  const fieldNames = Object.keys(schema).filter((name) => !schema[name].derived);

  const bestByField = new Map<string, { fact: Fact; score: number }>();
  const unmappedFacts: Fact[] = [];
  const rejectedCandidates: Array<{
    field_key: string;
    candidate_value: unknown;
    candidate_category: string;
    decision: string;
    reason: string;
    source_page: number | null;
    source_text: string;
  }> = [];

  const leaseTermPair = resolveLeaseTermDatePair(facts);
  for (const [fieldName, fact] of Object.entries(leaseTermPair.assignments)) {
    if (!fieldNames.includes(fieldName)) continue; // non-lease module schemas don't have these fields
    bestByField.set(fieldName, { fact, score: MIN_LABEL_SCORE });
  }

  for (const fact of facts) {
    if (leaseTermPair.consumed.has(fact)) continue; // already assigned by the date-pair resolver above
    let bestField: string | null = null;
    let bestScore = 0;
    for (const fieldName of fieldNames) {
      const fieldDef = schema[fieldName];
      const score = scoreFactAgainstField(fact, fieldName, fieldDef, moduleType);
      // Best-effort audit trail: only worth recording a rejection against
      // the field a fact's own labels/text would otherwise have matched —
      // re-checking every field for every fact would be noisy. A non-zero
      // pre-veto keyword score with a zero post-veto score means the veto
      // fired; that's the interesting case for reviewers/tuning.
      if (score === 0 && (fieldDef.allowedClauseCategories?.length || fieldDef.rejectedClauseCategories?.length)) {
        const rawLabelScore = (fieldDef.labels || []).some((label) =>
          label.length >= 3 && `${fact.sourceText} ${String(fact.value ?? "")}`.toLowerCase().includes(label.toLowerCase().replace(/_/g, " ")),
        );
        if (rawLabelScore) {
          rejectedCandidates.push({
            field_key: fieldName,
            candidate_value: fact.value,
            candidate_category: fact.category,
            decision: "reject",
            reason: "category_incompatible",
            source_page: fact.sourcePage,
            source_text: fact.sourceText,
          });
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestField = fieldName;
      }
    }

    if (!bestField || bestScore < MIN_LABEL_SCORE) {
      unmappedFacts.push(fact);
      continue;
    }

    const existing = bestByField.get(bestField);
    if (
      !existing ||
      bestScore > existing.score ||
      (bestScore === existing.score && fact.confidence > existing.fact.confidence)
    ) {
      bestByField.set(bestField, { fact, score: bestScore });
    }
  }

  const fields: Record<string, ExtractedField> = {};
  for (const [fieldName, { fact }] of bestByField.entries()) {
    fields[fieldName] = {
      value: fact.value,
      source: "llm",
      confidence: fact.confidence,
      sourceText: fact.sourceText,
      sourcePage: fact.sourcePage,
    };
  }

  const record: ExtractedRecord = { fields, rowIndex: 0 };
  const validated = validateRecords([record], moduleType);

  return {
    records: validated.records,
    validationErrors: validated.errors,
    unmappedFacts,
    rejectedCandidates,
  };
}

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

  for (const fact of facts) {
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

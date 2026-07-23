// @ts-nocheck
/**
 * Azure Document Intelligence + OpenAI (local implementation) — deterministic acceptance
 * evaluation for a business-extraction ExtractionPipelineResult.
 *
 * Replaces the pre-Phase-4E "is at least one field non-empty" gate
 * (normalize-pdf-output's countMeaningfulRowValues) with a profile-aware
 * evaluator that can distinguish "accepted", "needs review", "eligible for
 * legacy fallback", and "rejected outright" — and that reads STRUCTURED
 * provider failure classification rather than
 * inferring what went wrong by parsing a warning string.
 *
 * Reuses payload-guard.ts's isMeaningfulFieldValue/parsedDataHasMeaningfulValues
 * primitives — NOT uploadedFileRowHasMeaningfulValues, whose
 * {ui_review_payload,parsed_data,normalized_output} signature is shaped for
 * an already-persisted uploaded_files row, not the pre-persistence
 * ExtractionPipelineResult this evaluator actually receives.
 */

import { isMeaningfulFieldValue } from "./payload-guard.ts";
import type { ExtractionPipelineResult } from "./types.ts";


export type ExtractionAcceptanceState = "accepted" | "accepted_needs_review" | "fallback_eligible" | "rejected";

export interface ExtractionAcceptance {
  state: ExtractionAcceptanceState;
  reason: string;
  meaningfulFieldCount: number;
  validFieldKeyCount: number;
  evidenceBackedCount: number;
  warnings: string[];
}

export interface AcceptanceContext {
  /** Which provider produced this result — legacy is held to the same
   *  evaluator (Correction round 2, item 8: no automatic legacy trust). */
  provider: "openai_fact_ledger" | "vertex_fact_ledger" | "legacy_hybrid";
  /** Document profile, when known — assignment/amendment/consent/notice/
   *  guaranty are not required to hit base-lease field coverage. */
  documentProfile?: string | null;
  /** Recognized schema field keys for this module — used to compute
   *  validFieldKeyCount. When omitted, all present keys are treated as valid
   *  (keeps the evaluator usable without a full schema wired in yet). */
  recognizedFieldKeys?: Set<string>;
}

// Profiles that legitimately contain far fewer fields than a full base
// lease — never held to base-lease coverage expectations.
const REDUCED_COVERAGE_PROFILES = new Set(["assignment", "amendment", "consent", "notice", "guaranty"]);

// Structured classifications that make a result eligible for legacy
// fallback (mirrors the fallback-eligibility matrix in the Phase 4E design,
// re-verified against current OpenAI provider wrapper this session).
// "authentication" is deliberately absent — a bad/missing credential is
// never fallback-eligible.
//
// These values must match the LLMFailureClassification strings llm.ts's
// classifyOpenAIError() actually emits ("authentication", "rate_limit",
// "provider_server_error", "transport", "timeout") plus the two
// classifications fact-ledger-extractor.ts sets itself
// ("malformed_response", "empty_extraction"). This set previously used
// "rate_limited"/"server_error"/"network_error", which never matched
// anything llm.ts produces, so a rate-limited or 5xx OpenAI failure fell
// through to the unclassified branch below instead of being recognized as
// fallback-eligible.
const FALLBACK_ELIGIBLE_CLASSIFICATIONS = new Set<string>([
  "timeout",
  "rate_limit",
  "provider_server_error",
  "transport",
  "budget_exhausted",
  "model_unavailable",
  "malformed_response",
  "empty_extraction",
]);

function countValidFieldKeys(rows: Record<string, unknown>[], recognizedFieldKeys?: Set<string>): number {
  if (!recognizedFieldKeys) {
    const keys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row || {})) keys.add(key);
    }
    return keys.size;
  }
  let count = 0;
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      if (recognizedFieldKeys.has(key)) count++;
    }
  }
  return count;
}

function countMeaningfulFields(rows: Record<string, unknown>[]): number {
  let count = 0;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const value of Object.values(row)) {
      if (isMeaningfulFieldValue(value)) count++;
    }
  }
  return count;
}

function countEvidenceBacked(result: ExtractionPipelineResult): number {
  const debug = (result.metadata as any)?.extractionDebug;
  const anchors = debug?.openai_fact_ledger?.evidence_anchors ?? debug?.vertex_fact_ledger?.evidence_anchors;
  if (Array.isArray(anchors)) return anchors.length;
  // Legacy path: merged_field_sources entries with a real source_text count
  // as evidence-backed, mirroring how fact-mapper.ts already treats them.
  const merged = debug?.merged_field_sources;
  if (merged && typeof merged === "object") {
    return Object.values(merged).filter((f: any) => !!f?.source_text).length;
  }
  return 0;
}

/**
 * Structured failure classification the result's producer attached (per
 * Phase 4E's structured-error plumbing) — never inferred from warning text.
 */
function readFailureClassification(result: ExtractionPipelineResult): string | undefined {
  return (result.metadata as any)?.extractionDebug?.openai_fact_ledger?.failure_classification ?? (result.metadata as any)?.extractionDebug?.vertex_fact_ledger?.failure_classification;
}

export function evaluateExtractionAcceptance(
  result: ExtractionPipelineResult,
  context: AcceptanceContext,
): ExtractionAcceptance {
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const meaningfulFieldCount = countMeaningfulFields(rows);
  const validFieldKeyCount = countValidFieldKeys(rows, context.recognizedFieldKeys);
  const evidenceBackedCount = countEvidenceBacked(result);
  const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
  const isReducedCoverageProfile = context.documentProfile
    ? REDUCED_COVERAGE_PROFILES.has(context.documentProfile)
    : false;

  const classification = readFailureClassification(result);

  // 1. Structurally unusable / explicitly failed method, with zero
  //    meaningful content -- the clearest rejection/fallback signal.
  const hasNoContent = rows.length === 0 || meaningfulFieldCount === 0;
  const isFallbackShapedMethod = result.method === "fallback";

  if (hasNoContent && isFallbackShapedMethod) {
    if (classification && FALLBACK_ELIGIBLE_CLASSIFICATIONS.has(classification)) {
      return {
        state: "fallback_eligible",
        reason: classification,
        meaningfulFieldCount,
        validFieldKeyCount,
        evidenceBackedCount,
        warnings,
      };
    }
    if (classification === "authentication") {
      return {
        state: "rejected",
        reason: "authentication",
        meaningfulFieldCount,
        validFieldKeyCount,
        evidenceBackedCount,
        warnings,
      };
    }
    // No structured classification available at all (e.g. a legacy result
    // with a genuinely empty extraction, or an unclassified failure) --
    // still empty, so still fallback-eligible for a OpenAI result and
    // rejected for a legacy result (legacy has nothing further to fall
    // back to within this orchestrator).
    return {
      state: context.provider === "openai_fact_ledger" || context.provider === "vertex_fact_ledger" ? "fallback_eligible" : "rejected",
      reason: classification ?? "empty_extraction",
      meaningfulFieldCount,
      validFieldKeyCount,
      evidenceBackedCount,
      warnings,
    };
  }

  // 2. Validation errors present alongside content -- conflicting/ambiguous
  //    facts resolve to needs_review, never automatic fallback.
  const hasValidationErrors = Array.isArray(result.validationErrors) && result.validationErrors.length > 0;

  // 3. Evidence coverage assessment -- profile-aware, never requiring
  //    base-lease coverage from a reduced-coverage profile, and never
  //    triggering fallback merely because optional fields are absent.
  const hasSomeContent = meaningfulFieldCount > 0;
  const lowEvidenceCoverage = hasSomeContent && evidenceBackedCount === 0 && !isReducedCoverageProfile;

  if (hasValidationErrors || lowEvidenceCoverage) {
    return {
      state: "accepted_needs_review",
      reason: hasValidationErrors ? "validation_errors_present" : "low_evidence_coverage",
      meaningfulFieldCount,
      validFieldKeyCount,
      evidenceBackedCount,
      warnings,
    };
  }

  return {
    state: "accepted",
    reason: "accepted",
    meaningfulFieldCount,
    validFieldKeyCount,
    evidenceBackedCount,
    warnings,
  };
}

// Test hook (same pattern as other _shared/extraction modules).
export const __test__ = {
  countMeaningfulFields,
  countValidFieldKeys,
  countEvidenceBacked,
  readFailureClassification,
  FALLBACK_ELIGIBLE_CLASSIFICATIONS,
  REDUCED_COVERAGE_PROFILES,
};

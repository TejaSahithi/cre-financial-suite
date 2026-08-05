// @ts-nocheck
/**
 * Cross-stage handoff for the bounded per-domain enrich chain (see
 * docs/lease-extraction-architecture-audit-2026-07-29.md and the "Bounded Per-Domain Enrich
 * Refactor" plan).
 *
 * pipeline_jobs.output is confirmed dead/unused in this codebase (an
 * in-repo migration comment says so explicitly), and pipeline_jobs.metadata
 * is used only for bookkeeping/same-job resumption, never stage-to-stage
 * handoff. The one real, WORKING cross-stage handoff precedent in this
 * codebase is uploaded_files columns -- so bounded stages read/write a new,
 * additive sub-object on the EXISTING normalized_output.metadata.extractionDebug
 * column (no new table, no new column), keyed by stage name.
 *
 * Each stage ALSO merges its own resolved raw-field keys directly into
 * extractionDebug.merged_field_sources -- the exact shape both existing
 * pipelines already populate and lease-truth-assembly.ts's
 * assembleCanonicalFields() already consumes, unchanged.
 */

import { ENRICH_STAGE_SEQUENCE, type EnrichBoundedStageName } from "./stage-sequence.ts";

export type BoundedStageStatus = "completed" | "failed" | "incomplete";

/**
 * Bumped whenever a stage function's logic changes in a way that would make
 * an old persisted result unsafe to reuse as-is. Checked by
 * isStageAlreadyCompleted() as part of the idempotency guard -- a stored
 * result whose version doesn't match the current STAGE_RESULT_VERSION is
 * treated as not-yet-completed (recomputed), the same way a stored result
 * for the wrong generation_id is.
 */
export const STAGE_RESULT_VERSION = "v1";

export interface BoundedStageResultEntry {
  status: BoundedStageStatus;
  generation_id: string | null;
  stage_version: string;
  completed_at: string;
  data: unknown;
  limits_hit?: string[];
  error_code?: string | null;
  error_message?: string | null;
}

export type BoundedStageResults = Partial<Record<EnrichBoundedStageName, BoundedStageResultEntry>>;

const MERGED_FIELD_SOURCE_KEYS = ["value", "source", "confidence", "source_text", "source_page"] as const;

/** Reads the pooled bounded-stage state from a fetched normalized_output blob. Never throws on missing/malformed input. */
export function readBoundedStageResults(normalizedOutput: any): BoundedStageResults {
  const results = normalizedOutput?.metadata?.extractionDebug?.bounded_stage_results;
  return results && typeof results === "object" ? results : {};
}

export function readMergedFieldSources(normalizedOutput: any): Record<string, any> {
  const merged = normalizedOutput?.metadata?.extractionDebug?.merged_field_sources;
  return merged && typeof merged === "object" ? merged : {};
}

/**
 * Merges one stage's contribution into normalizedOutput, returning a NEW
 * object (does not mutate the input) ready to persist. `fieldContributions`
 * is this stage's slice of the merged_field_sources shape
 * ({rawFieldKey: {value, source, confidence, source_text, source_page}});
 * pass {} for stages that don't resolve schema fields directly (e.g.
 * enrich_clauses, enrich_derivation).
 */
export function mergeBoundedStageResult(args: {
  normalizedOutput: any;
  stage: EnrichBoundedStageName;
  generationId: string | null;
  status: BoundedStageStatus;
  data: unknown;
  fieldContributions?: Record<string, any>;
  limitsHit?: string[];
  errorCode?: string | null;
  errorMessage?: string | null;
}): any {
  const {
    normalizedOutput, stage, generationId, status, data,
    fieldContributions = {}, limitsHit = [], errorCode = null, errorMessage = null,
  } = args;

  const base = normalizedOutput && typeof normalizedOutput === "object" ? normalizedOutput : {};
  const metadata = base.metadata && typeof base.metadata === "object" ? base.metadata : {};
  const extractionDebug = metadata.extractionDebug && typeof metadata.extractionDebug === "object" ? metadata.extractionDebug : {};
  const priorResults = readBoundedStageResults(base);
  const priorMergedFieldSources = readMergedFieldSources(base);

  const entry: BoundedStageResultEntry = {
    status,
    generation_id: generationId,
    stage_version: STAGE_RESULT_VERSION,
    completed_at: new Date().toISOString(),
    data,
    limits_hit: limitsHit,
    error_code: errorCode,
    error_message: errorMessage,
  };

  // Only well-shaped contributions get merged into merged_field_sources --
  // a malformed entry from a buggy stage must not corrupt the shared
  // evidence contract assembleCanonicalFields() depends on.
  const cleanContributions: Record<string, any> = {};
  for (const [key, value] of Object.entries(fieldContributions || {})) {
    if (!value || typeof value !== "object") continue;
    const cleaned: Record<string, unknown> = {};
    for (const shapeKey of MERGED_FIELD_SOURCE_KEYS) {
      if ((value as any)[shapeKey] !== undefined) cleaned[shapeKey] = (value as any)[shapeKey];
    }
    cleanContributions[key] = cleaned;
  }

  return {
    ...base,
    metadata: {
      ...metadata,
      extractionDebug: {
        ...extractionDebug,
        bounded_stage_results: { ...priorResults, [stage]: entry },
        merged_field_sources: { ...priorMergedFieldSources, ...cleanContributions },
      },
    },
  };
}

/** True once every stage before (and including) `throughStage` has a "completed" or "incomplete" (not "failed", not missing) entry. */
export function priorStagesResolved(results: BoundedStageResults, sequenceUpToExclusive: EnrichBoundedStageName[]): boolean {
  return sequenceUpToExclusive.every((stage) => {
    const entry = results[stage];
    return entry != null && entry.status !== "failed";
  });
}
export function boundedStageEntryCompletedForGeneration(entry: any, generationId: string | null) {
  return entry?.status === "completed" &&
    entry?.generation_id === generationId &&
    entry?.stage_version === STAGE_RESULT_VERSION;
}

export function resolveNextBoundedEnrichStageToResume(args: {
  results: BoundedStageResults;
  generationId: string | null;
  sequence?: readonly EnrichBoundedStageName[];
}): EnrichBoundedStageName | null {
  const { results, generationId, sequence = ENRICH_STAGE_SEQUENCE } = args;
  const stages = [...sequence];
  if (stages.length === 0) return null;

  const finalStage = stages[stages.length - 1];
  if (boundedStageEntryCompletedForGeneration(results[finalStage], generationId)) return null;

  for (const stage of stages) {
    const entry = results[stage];
    if (entry?.status === "failed" && entry?.generation_id === generationId && entry?.stage_version === STAGE_RESULT_VERSION) {
      return null;
    }
  }

  let lastCompletedIndex = -1;
  for (let index = 0; index < stages.length; index += 1) {
    if (boundedStageEntryCompletedForGeneration(results[stages[index]], generationId)) {
      lastCompletedIndex = index;
    }
  }

  return stages[lastCompletedIndex + 1] ?? null;
}
/**
 * Idempotency guard: a stage handler must call this BEFORE doing any real
 * work (no recompute, no Azure/OpenAI calls, no duplicate persistence) --
 * per the requirement that a repeated invocation of an already-completed
 * stage returns the existing result rather than redoing it. A stored
 * result only counts as reusable when it is for the SAME generation_id
 * (never mix results across generations) AND the SAME stage_version (a
 * stage-logic change invalidates old results rather than silently reusing
 * them under new code).
 */
export function isStageAlreadyCompleted(args: {
  normalizedOutput: any;
  stage: EnrichBoundedStageName;
  generationId: string | null;
}): { reusable: boolean; entry: BoundedStageResultEntry | null } {
  const { normalizedOutput, stage, generationId } = args;
  const results = readBoundedStageResults(normalizedOutput);
  const entry = results[stage] ?? null;
  if (!entry || entry.status !== "completed") return { reusable: false, entry: null };
  if (entry.generation_id !== generationId) return { reusable: false, entry: null };
  if (entry.stage_version !== STAGE_RESULT_VERSION) return { reusable: false, entry: null };
  return { reusable: true, entry };
}

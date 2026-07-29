// @ts-nocheck
/**
 * Hard input limits per bounded enrich stage (see docs/lease-extraction-architecture-audit-2026-07-29.md
 * and the "Bounded Per-Domain Enrich Refactor" plan).
 *
 * Per the user's explicit requirement, a document exceeding a stage's limit
 * must NOT fall back to one giant whole-document invocation (that's the
 * exact shape of the original 546 crash). Real bounded-slice splitting
 * (processing a page/block range and re-enqueueing the same stage for the
 * next slice) is deliberately NOT implemented in this change-set -- an
 * oversized stage instead fails explicitly with BOUNDED_STAGE_LIMIT_EXCEEDED
 * (see completion.ts's BoundedStageOutcome.limitExceeded), a normal terminal
 * failure, never a silent whole-document fallback.
 *
 * These defaults are initial estimates, not measured limits -- no real
 * per-stage memory/duration profiling exists yet (Deno does not expose
 * precise heap stats; see the telemetry module for what IS measurable).
 * They exist so a limit check has something to check against from day one;
 * expect to tune them once shadow-mode telemetry from real documents (see
 * the plan's "Feature-flagging and phased rollout" section) is available.
 */

import type { EnrichBoundedStageName } from "./enrich-bounded-stage/stage-sequence.ts";

export interface EnrichStageLimits {
  /** Max doclingRaw.text_blocks entries this stage will process in one invocation. */
  maxTextBlocks: number;
  /** Max doclingRaw.full_text characters this stage will scan in one invocation. */
  maxFullTextChars: number;
  /** Max distinct pages this stage will process in one invocation. */
  maxPages: number;
}

const DEFAULT_LIMITS: EnrichStageLimits = {
  maxTextBlocks: 4000,
  maxFullTextChars: 250_000,
  maxPages: 120,
};

// Clause records and the field map are the two proven highest-cost phases
// (buildClauseRecords is called out in-code as "the dominant cost behind...
// 546 failures"; buildLeaseFieldMap is comparably sized -- ~91 field specs,
// 756 lines) -- given tighter limits than the default so they split into
// bounded slices sooner, before the derivation/evidence stages that run on
// their already-computed, much smaller output.
const STAGE_LIMITS: Partial<Record<EnrichBoundedStageName, EnrichStageLimits>> = {
  enrich_clauses: { maxTextBlocks: 2500, maxFullTextChars: 150_000, maxPages: 80 },
  enrich_fields: { maxTextBlocks: 2500, maxFullTextChars: 150_000, maxPages: 80 },
  enrich_items: DEFAULT_LIMITS,
  // Derivation and truth-assembly operate on already-computed, bounded
  // structures (leaseFields/clauses/expenseRules), not on raw document text
  // -- no per-page/per-block limit applies to them.
};

export function getEnrichStageLimits(stage: EnrichBoundedStageName): EnrichStageLimits {
  return STAGE_LIMITS[stage] ?? DEFAULT_LIMITS;
}

export interface StageInputSize {
  textBlockCount: number;
  fullTextChars: number;
  pageCount: number;
}

export interface StageLimitCheck {
  withinLimits: boolean;
  exceededBy: string[];
}

export function checkStageInputAgainstLimits(stage: EnrichBoundedStageName, size: StageInputSize): StageLimitCheck {
  const limits = getEnrichStageLimits(stage);
  const exceededBy: string[] = [];
  if (size.textBlockCount > limits.maxTextBlocks) exceededBy.push(`textBlockCount ${size.textBlockCount} > ${limits.maxTextBlocks}`);
  if (size.fullTextChars > limits.maxFullTextChars) exceededBy.push(`fullTextChars ${size.fullTextChars} > ${limits.maxFullTextChars}`);
  if (size.pageCount > limits.maxPages) exceededBy.push(`pageCount ${size.pageCount} > ${limits.maxPages}`);
  return { withinLimits: exceededBy.length === 0, exceededBy };
}

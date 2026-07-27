// @ts-nocheck
/**
 * The ordered sequence of bounded enrich sub-stages that replace the single
 * monolithic "enrich" pipeline_jobs stage when ENRICH_BOUNDED_STAGE_MODE is
 * "shadow" or "active" (see FAILED_EXTRACTION_ROOT_CAUSE.md and the
 * "Bounded Per-Domain Enrich Refactor" plan).
 *
 * One shared array, rather than each stage hardcoding its own successor --
 * this is what completeBoundedEnrichStage() consults to decide what to
 * enqueue next, instead of 9 hand-copied "what comes after me" branches.
 */

export const ENRICH_STAGE_SEQUENCE = [
  "enrich_clauses",
  "enrich_fields",
  "enrich_items",
  "enrich_derivation",
  "enrich_evidence_core_terms",
  "enrich_evidence_rent_and_charges",
  "enrich_evidence_expenses_and_cam",
  "enrich_evidence_operating_obligations",
  "enrich_evidence_legal_rights_and_dates",
  "enrich_truth_assembly",
] as const;

export type EnrichBoundedStageName = typeof ENRICH_STAGE_SEQUENCE[number];

export const ENRICH_EVIDENCE_DOMAIN_STAGES: EnrichBoundedStageName[] = [
  "enrich_evidence_core_terms",
  "enrich_evidence_rent_and_charges",
  "enrich_evidence_expenses_and_cam",
  "enrich_evidence_operating_obligations",
  "enrich_evidence_legal_rights_and_dates",
];

export function isEnrichBoundedStageName(value: unknown): value is EnrichBoundedStageName {
  return typeof value === "string" && (ENRICH_STAGE_SEQUENCE as readonly string[]).includes(value);
}

/** The first stage a fresh bounded-enrich chain should enqueue. */
export function firstEnrichBoundedStage(): EnrichBoundedStageName {
  return ENRICH_STAGE_SEQUENCE[0];
}

/** Returns the next stage name, or null if `stage` was the last one (enrich_truth_assembly). */
export function nextEnrichBoundedStage(stage: EnrichBoundedStageName): EnrichBoundedStageName | null {
  const index = ENRICH_STAGE_SEQUENCE.indexOf(stage);
  if (index === -1 || index === ENRICH_STAGE_SEQUENCE.length - 1) return null;
  return ENRICH_STAGE_SEQUENCE[index + 1];
}

export function isFinalEnrichBoundedStage(stage: EnrichBoundedStageName): boolean {
  return stage === ENRICH_STAGE_SEQUENCE[ENRICH_STAGE_SEQUENCE.length - 1];
}

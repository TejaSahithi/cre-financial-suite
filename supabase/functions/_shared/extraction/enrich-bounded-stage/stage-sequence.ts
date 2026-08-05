// @ts-nocheck
/**
 * The ordered sequence of bounded enrich sub-stages that replace the single
 * monolithic "enrich" pipeline_jobs stage. Bounded mode is mandatory at
 * runtime (see docs/lease-extraction-architecture-audit-2026-07-29.md and the
 * "Bounded Per-Domain Enrich Refactor" plan).
 *
 * One shared array, rather than each stage hardcoding its own successor --
 * this is what completeBoundedEnrichStage() consults to decide what to
 * enqueue next, instead of 9 hand-copied "what comes after me" branches.
 */

// Phase 4: the 5 enrich_evidence_<domain> stage names in the middle of this
// sequence are now sourced from the domain registry
// (domains/domain-registry.ts's ENRICH_EVIDENCE_DOMAIN_STAGES, itself built
// from each domain's boundedEnrichStageName) instead of hand-written here
// twice -- same 5 names, same order, verified in
// _tests/domain-registry-byte-compatibility.test.ts. The 4-before/1-after
// stage names are fixed pipeline phases, not per-domain concepts, and stay
// literal.
import { ENRICH_EVIDENCE_DOMAIN_STAGES as REGISTRY_ENRICH_EVIDENCE_DOMAIN_STAGES } from "../domains/domain-registry.ts";

const EXPENSES_AND_CAM_DOMAIN_STAGE = "enrich_evidence_expenses_and_cam";

export const EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES = [
  "enrich_evidence_expenses_recoveries",
  "enrich_evidence_cam_rules",
  "enrich_evidence_taxes",
  "enrich_evidence_insurance",
  "enrich_evidence_utilities",
] as const;

const EXPANDED_ENRICH_EVIDENCE_STAGES = REGISTRY_ENRICH_EVIDENCE_DOMAIN_STAGES
  .flatMap((stage) =>
    stage === EXPENSES_AND_CAM_DOMAIN_STAGE
      ? [...EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES, EXPENSES_AND_CAM_DOMAIN_STAGE]
      : [stage]
  );

export const ENRICH_STAGE_SEQUENCE = [
  "enrich_clauses",
  "enrich_fields",
  "enrich_items",
  "enrich_derivation",
  ...EXPANDED_ENRICH_EVIDENCE_STAGES,
  "enrich_truth_assembly",
] as const;

export type EnrichBoundedStageName = typeof ENRICH_STAGE_SEQUENCE[number];

export const ENRICH_EVIDENCE_DOMAIN_STAGES: EnrichBoundedStageName[] =
  REGISTRY_ENRICH_EVIDENCE_DOMAIN_STAGES as EnrichBoundedStageName[];
export type ExpensesAndCamEvidenceSubstage =
  typeof EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES[number];

export function isExpensesAndCamEvidenceSubstage(
  value: unknown,
): value is ExpensesAndCamEvidenceSubstage {
  return typeof value === "string" &&
    (EXPENSES_AND_CAM_EVIDENCE_SUBSTAGES as readonly string[]).includes(value);
}

export function isEnrichBoundedStageName(
  value: unknown,
): value is EnrichBoundedStageName {
  return typeof value === "string" &&
    (ENRICH_STAGE_SEQUENCE as readonly string[]).includes(value);
}

/** The first stage a fresh bounded-enrich chain should enqueue. */
export function firstEnrichBoundedStage(): EnrichBoundedStageName {
  return ENRICH_STAGE_SEQUENCE[0];
}

/** Returns the next stage name, or null if `stage` was the last one (enrich_truth_assembly). */
export function nextEnrichBoundedStage(
  stage: EnrichBoundedStageName,
): EnrichBoundedStageName | null {
  const index = ENRICH_STAGE_SEQUENCE.indexOf(stage);
  if (index === -1 || index === ENRICH_STAGE_SEQUENCE.length - 1) return null;
  return ENRICH_STAGE_SEQUENCE[index + 1];
}

export function isFinalEnrichBoundedStage(
  stage: EnrichBoundedStageName,
): boolean {
  return stage === ENRICH_STAGE_SEQUENCE[ENRICH_STAGE_SEQUENCE.length - 1];
}

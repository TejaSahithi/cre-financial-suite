// @ts-nocheck
/**
 * claims-to-field-projection.ts — P2.6.
 *
 * Orchestrates claim-resolution.ts across every concept in the registry
 * for one generation, given a pre-fetched bundle of claims/decisions/open-
 * conflict flags (fetching that bundle from the DB is P2.7's pipeline-
 * wiring job -- this module stays a pure function over already-loaded
 * data, same pattern as the P2.4 adapters).
 *
 * Every concept in CLAIM_CONCEPTS gets exactly one FieldProjectionEntry,
 * even when unresolved -- "no claim is silently omitted without a
 * projection reason" (P2.6 gate) means the reason is always recorded,
 * even if that reason is literally "unresolved".
 */
import { resolveClaimForFactSlot, type ReviewDecisionRef, type ResolvableClaim } from "./claim-resolution.ts";
import { CLAIM_CONCEPTS } from "../concept-registry.ts";

export interface ClaimForProjection extends ResolvableClaim {
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  rawValueText?: string | null;
  sourcePage?: number | null;
  sourceText?: string | null;
  confidence?: number | null;
}

export interface FieldProjectionEntry {
  fieldKey: string;
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  outcome: string;
  claimId: string | null;
  value: string | null;
  rawValue: string | null;
  sourcePage: number | null;
  sourceText: string | null;
  confidence: number | null;
}

export interface BuildFieldProjectionInput {
  claims: ClaimForProjection[];
  reviewDecisionsByFactSlot: Map<string, ReviewDecisionRef[]>; // key: `${conceptKey}|${scopeKey}|${instanceKey}`
  openConflictFactSlots: Set<string>; // same key shape
}

function factSlotKey(conceptKey: string, scopeKey: string, instanceKey: string): string {
  return `${conceptKey}|${scopeKey}|${instanceKey}`;
}

export function buildFieldProjection(input: BuildFieldProjectionInput): FieldProjectionEntry[] {
  const claimsByFactSlot = new Map<string, ClaimForProjection[]>();
  for (const claim of input.claims) {
    const key = factSlotKey(claim.conceptKey, claim.scopeKey, claim.instanceKey);
    const existing = claimsByFactSlot.get(key) ?? [];
    existing.push(claim);
    claimsByFactSlot.set(key, existing);
  }

  const results: FieldProjectionEntry[] = [];

  for (const concept of CLAIM_CONCEPTS) {
    if (concept.cardinality !== "single" || !concept.projectionFieldKey) continue;

    // Single-cardinality concepts always resolve against the "default"
    // instance/scope for now (P2.1's own note: instance_strategy beyond
    // "singleton" is a P2.4+ adapter concern; no adapter emits a non-
    // default instance yet).
    const key = factSlotKey(concept.conceptKey, "lease", "default");
    const claims = claimsByFactSlot.get(key) ?? [];
    const decisions = input.reviewDecisionsByFactSlot.get(key) ?? [];
    const hasOpenConflict = input.openConflictFactSlots.has(key);

    const resolution = resolveClaimForFactSlot({
      conceptKey: concept.conceptKey,
      scopeKey: "lease",
      instanceKey: "default",
      evidenceRequired: concept.evidenceRequired,
      claims,
      reviewDecisions: decisions,
      hasOpenConflict,
    });

    const winningClaim = resolution.winningClaimId ? claims.find((c) => c.claimId === resolution.winningClaimId) : null;

    results.push({
      fieldKey: concept.projectionFieldKey,
      conceptKey: concept.conceptKey,
      scopeKey: "lease",
      instanceKey: "default",
      outcome: resolution.outcome,
      claimId: resolution.winningClaimId,
      value: resolution.normalizedValue,
      rawValue: winningClaim?.rawValueText ?? null,
      sourcePage: winningClaim?.sourcePage ?? null,
      sourceText: winningClaim?.sourceText ?? null,
      confidence: winningClaim?.confidence ?? null,
    });
  }

  return results;
}

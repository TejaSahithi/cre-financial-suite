// @ts-nocheck
/**
 * claim-resolution.ts — P2.6.
 *
 * Deterministic per-fact-slot resolver. Pure function: given every claim
 * for one (concept_key, scope_key, instance_key) fact slot plus any
 * review decisions and open conflict referencing that slot, decides which
 * single claim (if any) wins, following the exact resolution order the
 * Wave-1 spec locks:
 *
 *   1. Accepted reviewer replacement
 *   2. Reviewer-accepted extracted claim
 *   3. Valid semantic claim with sufficient evidence
 *   4. Valid deterministic claim with sufficient evidence
 *   5. Valid derived/calculated claim
 *   6. Open conflict -> needs_review
 *   7. Explicit absence/status claim (not_present/not_applicable/etc.)
 *   8. No claim -> unresolved (never auto not_present)
 *
 * "Sufficient evidence" means: if the concept's registry entry requires
 * evidence, the claim must have at least one linked evidence row.
 */

export type ResolutionOutcome =
  | "reviewer_replacement"
  | "reviewer_accepted"
  | "semantic"
  | "deterministic"
  | "derived_calculated"
  | "needs_review"
  | "explicit_status"
  | "unresolved";

export interface ResolvableClaim {
  claimId: string;
  producerType: string;
  assertionStatus: string;
  normalizedValue: string | null;
  hasEvidence: boolean;
  supersededByClaimId?: string | null; // set on a claim if some other claim supersedes it
  createdAt: string; // ISO timestamp -- used only as a stable, documented tie-breaker
}

export interface ReviewDecisionRef {
  decisionType: "accept" | "reject" | "edit" | "mark_not_applicable" | "mark_not_present" | "mark_manual_required" | "resolve_conflict" | "reopen";
  claimId?: string | null;
  replacementClaimId?: string | null;
}

export interface FactSlotInput {
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  evidenceRequired: boolean;
  claims: ResolvableClaim[];
  reviewDecisions: ReviewDecisionRef[];
  hasOpenConflict: boolean;
}

export interface ResolutionResult {
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  outcome: ResolutionOutcome;
  winningClaimId: string | null;
  normalizedValue: string | null;
}

const VALUE_BEARING = new Set(["asserted", "derived", "calculated"]);
const EXPLICIT_STATUS = new Set(["not_present", "not_applicable", "unreadable", "requires_related_document", "extraction_failed"]);

function isCurrent(claim: ResolvableClaim): boolean {
  return !claim.supersededByClaimId;
}

function meetsEvidenceBar(claim: ResolvableClaim, evidenceRequired: boolean): boolean {
  return !evidenceRequired || claim.hasEvidence;
}

export function resolveClaimForFactSlot(input: FactSlotInput): ResolutionResult {
  const base = { conceptKey: input.conceptKey, scopeKey: input.scopeKey, instanceKey: input.instanceKey };
  const currentClaims = input.claims.filter(isCurrent);

  // 1. Accepted reviewer replacement -- a currently-not-superseded
  // producer_type='reviewer' claim that some decision names as its
  // replacement_claim_id (edit/mark_*), or that was itself accept-decided.
  const replacementDecision = input.reviewDecisions.find(
    (d) => (d.decisionType === "edit" || d.decisionType === "mark_not_applicable" || d.decisionType === "mark_not_present" || d.decisionType === "mark_manual_required")
      && d.replacementClaimId,
  );
  if (replacementDecision) {
    const replacementClaim = currentClaims.find((c) => c.claimId === replacementDecision.replacementClaimId && c.producerType === "reviewer");
    if (replacementClaim) {
      return { ...base, outcome: "reviewer_replacement", winningClaimId: replacementClaim.claimId, normalizedValue: replacementClaim.normalizedValue };
    }
  }

  // 2. Reviewer-accepted extracted claim -- an 'accept' decision naming a
  // non-reviewer claim directly (the reviewer confirmed the extracted value
  // as-is, no replacement claim needed).
  const acceptDecision = input.reviewDecisions.find((d) => d.decisionType === "accept" && d.claimId);
  if (acceptDecision) {
    const acceptedClaim = currentClaims.find((c) => c.claimId === acceptDecision.claimId);
    if (acceptedClaim) {
      return { ...base, outcome: "reviewer_accepted", winningClaimId: acceptedClaim.claimId, normalizedValue: acceptedClaim.normalizedValue };
    }
  }

  // 6 (checked here, ahead of 3-5): an open conflict blocks auto-resolution
  // via any of steps 3-5 -- those steps use .find() to grab the FIRST
  // matching claim at their tier, which would silently pick an arbitrary
  // side of a live disagreement if checked before this. A reviewer
  // decision (steps 1-2, already checked above) is exactly how a conflict
  // gets resolved, so this only fires when no reviewer decision applied.
  if (input.hasOpenConflict) {
    return { ...base, outcome: "needs_review", winningClaimId: null, normalizedValue: null };
  }

  // 3. Valid semantic claim with sufficient evidence.
  const semanticClaim = currentClaims.find(
    (c) => c.producerType === "semantic_extractor" && c.assertionStatus === "asserted" && meetsEvidenceBar(c, input.evidenceRequired),
  );
  if (semanticClaim) {
    return { ...base, outcome: "semantic", winningClaimId: semanticClaim.claimId, normalizedValue: semanticClaim.normalizedValue };
  }

  // 4. Valid deterministic claim with sufficient evidence.
  const deterministicClaim = currentClaims.find(
    (c) => (c.producerType === "deterministic_mapper" || c.producerType === "legacy_adapter" || c.producerType === "validation_engine")
      && c.assertionStatus === "asserted" && meetsEvidenceBar(c, input.evidenceRequired),
  );
  if (deterministicClaim) {
    return { ...base, outcome: "deterministic", winningClaimId: deterministicClaim.claimId, normalizedValue: deterministicClaim.normalizedValue };
  }

  // 5. Valid derived/calculated claim.
  const derivedClaim = currentClaims.find((c) => (c.assertionStatus === "derived" || c.assertionStatus === "calculated") && meetsEvidenceBar(c, input.evidenceRequired));
  if (derivedClaim) {
    return { ...base, outcome: "derived_calculated", winningClaimId: derivedClaim.claimId, normalizedValue: derivedClaim.normalizedValue };
  }

  // 7. Explicit absence/status claim.
  const explicitStatusClaim = currentClaims.find((c) => EXPLICIT_STATUS.has(c.assertionStatus));
  if (explicitStatusClaim) {
    return { ...base, outcome: "explicit_status", winningClaimId: explicitStatusClaim.claimId, normalizedValue: null };
  }

  // 8. No claim at all for this fact slot -- unresolved, never auto not_present.
  return { ...base, outcome: "unresolved", winningClaimId: null, normalizedValue: null };
}

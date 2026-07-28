// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer (Phase 2) — status vocabulary.
 *
 * Matches the strict-outputs pilot's own StrictFieldStatus vocabulary
 * (schemas/schema-registry.ts) deliberately -- one status language across
 * both the shadow pilot and this canonical layer, rather than a third
 * competing enum. "not_stated" (LEASE_SCHEMA's own field-level concept) and
 * "missing"/"needs_review" (ui_review_payload's projection-time labels) are
 * NOT part of this vocabulary -- those are legacy-shape concerns handled by
 * claim-converters.ts's round-trip functions, not the claim's own identity.
 */

export type ClaimStatus =
  | "explicit"
  | "derived"
  | "conditional"
  | "not_found"
  | "ambiguous"
  | "conflicting"
  | "illegible";

export const CLAIM_STATUS_VALUES: readonly ClaimStatus[] = [
  "explicit",
  "derived",
  "conditional",
  "not_found",
  "ambiguous",
  "conflicting",
  "illegible",
];

/**
 * Independent of ClaimStatus: ClaimStatus describes what the SOURCE TEXT
 * supports: ClaimVerificationStatus describes what this pipeline run has
 * done to double-check that support. A claim can be status="explicit" and
 * verificationStatus="unverified" (nothing has re-checked it yet),
 * "verified" (llm-field-validator.ts confirmed it, or claim-validation.ts's
 * evidence check passed), "needs_review" (a check flagged it but did not
 * clear the value -- the exact "flag, don't delete" behavior
 * lease-truth-assembly.ts's findAlreadyReviewedFallback now also follows),
 * or "rejected" (a verifier explicitly nulled it -- see
 * verifierResultToClaims in claim-converters.ts).
 */
export type ClaimVerificationStatus = "unverified" | "verified" | "needs_review" | "rejected";

export const CLAIM_VERIFICATION_STATUS_VALUES: readonly ClaimVerificationStatus[] = [
  "unverified",
  "verified",
  "needs_review",
  "rejected",
];

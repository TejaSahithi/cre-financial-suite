// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer (Phase 2) — evidence verification.
 *
 * No real document-node graph exists yet (see evidence-reference.ts's
 * docstring), so this does NOT do documentNodes.get(nodeId) lookups. It
 * reuses evidence-index.ts's existing resolveVerifiedSourcePage(), the same
 * fuzzy quote-against-document verification adaptive-extractor.ts and
 * merger.ts already trust today -- not a new, unproven verification
 * mechanism.
 */

import { resolveVerifiedSourcePage } from "../evidence-index.ts";
import type { ExtractedClaim } from "./extracted-claim.ts";

export type EvidenceInvalidReason =
  | "populated_claim_without_evidence"
  | "evidence_quote_not_found"
  | "evidence_page_mismatch";

export interface EvidenceValidationResult {
  valid: boolean;
  reason: EvidenceInvalidReason | null;
  /** Index into claim.evidence of the first entry that failed, when
   *  reason is quote/page-related. */
  evidenceIndex: number | null;
}

/**
 * Pure check -- does not mutate the claim. A populated claim (normalizedValue
 * != null) with zero evidence entries fails; an entry whose quote cannot be
 * found anywhere in the document fails; an entry whose claimed page
 * disagrees with the page the quote actually verifies against fails. A
 * "not_found"/"illegible" claim (normalizedValue == null) with zero
 * evidence is valid by construction -- there is nothing to ground.
 */
export function verifyClaimEvidence(
  claim: ExtractedClaim,
  doclingRaw: Record<string, unknown> | null | undefined,
): EvidenceValidationResult {
  if (claim.normalizedValue != null && claim.evidence.length === 0) {
    return { valid: false, reason: "populated_claim_without_evidence", evidenceIndex: null };
  }

  for (let i = 0; i < claim.evidence.length; i++) {
    const evidence = claim.evidence[i];
    if (!evidence.quote) continue; // nothing to verify for this entry

    const verifiedPage = resolveVerifiedSourcePage(doclingRaw, evidence.quote, evidence.pageNumber);
    if (verifiedPage == null) {
      return { valid: false, reason: "evidence_quote_not_found", evidenceIndex: i };
    }
    if (evidence.pageNumber != null && verifiedPage !== evidence.pageNumber) {
      return { valid: false, reason: "evidence_page_mismatch", evidenceIndex: i };
    }
  }

  return { valid: true, reason: null, evidenceIndex: null };
}

/**
 * Runs verifyClaimEvidence and returns a NEW claim reflecting the result --
 * never mutates the input, never clears normalizedValue on failure. An
 * invalid result sets verificationStatus="needs_review" and requiresReview
 * =true with a human-readable reason appended to reviewReasons; a valid
 * result on a claim that was still "unverified" is promoted to "verified"
 * (a claim already "rejected" by a verifier, e.g. verifierResultToClaims,
 * is left alone -- this function only ever tightens review status, it never
 * downgrades an explicit rejection back to verified).
 */
export function applyEvidenceVerification(
  claim: ExtractedClaim,
  doclingRaw: Record<string, unknown> | null | undefined,
): ExtractedClaim {
  const result = verifyClaimEvidence(claim, doclingRaw);
  if (result.valid) {
    if (claim.verificationStatus !== "unverified") return claim;
    return { ...claim, verificationStatus: "verified" };
  }

  const reasonText =
    result.reason === "populated_claim_without_evidence"
      ? "Claim has a value but no supporting evidence."
      : result.reason === "evidence_quote_not_found"
        ? "Evidence quote could not be verified against the source document."
        : "Evidence quote verifies to a different page than claimed.";

  return {
    ...claim,
    verificationStatus: "needs_review",
    requiresReview: true,
    reviewReasons: claim.reviewReasons.includes(reasonText) ? claim.reviewReasons : [...claim.reviewReasons, reasonText],
  };
}

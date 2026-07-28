// @ts-nocheck
/**
 * Phase 6A structural validation + evidence verification for
 * ExpenseObligation (6A.4).
 *
 * Evidence verification reuses evidence-index.ts's resolveVerifiedSourcePage
 * -- the SAME primitive claim-validation.ts's verifyClaimEvidence already
 * uses -- adapted to ExpenseObligation's own field names rather than
 * force-fitting ExtractedClaim's shape (they have different "what counts
 * as populated" semantics: every ExpenseObligation reaching this layer
 * represents a real obligation a specialist chose to report -- Phase 5's
 * prompts explicitly instruct "if the evidence does not address this
 * topic area, return an empty obligations array" rather than a
 * not-found placeholder -- so every obligation here is expected to carry
 * evidence, unconditionally, unlike ExtractedClaim's normalizedValue-gated
 * check).
 */

import { resolveVerifiedSourcePage } from "../../evidence-index.ts";
import type { ExpenseObligation } from "./expense-obligation.ts";

export type ExpenseObligationInvalidReason = "obligation_without_evidence" | "evidence_quote_not_found" | "evidence_page_mismatch";

export interface ExpenseObligationEvidenceResult {
  valid: boolean;
  reason: ExpenseObligationInvalidReason | null;
  evidenceIndex: number | null;
}

export function verifyExpenseObligationEvidence(
  obligation: ExpenseObligation,
  doclingRaw: Record<string, unknown> | null | undefined,
): ExpenseObligationEvidenceResult {
  if (obligation.evidence.length === 0) {
    return { valid: false, reason: "obligation_without_evidence", evidenceIndex: null };
  }
  for (let i = 0; i < obligation.evidence.length; i++) {
    const evidence = obligation.evidence[i];
    if (!evidence.quote) continue;
    const verifiedPage = resolveVerifiedSourcePage(doclingRaw, evidence.quote, evidence.pageNumber);
    if (verifiedPage == null) return { valid: false, reason: "evidence_quote_not_found", evidenceIndex: i };
    if (evidence.pageNumber != null && verifiedPage !== evidence.pageNumber) return { valid: false, reason: "evidence_page_mismatch", evidenceIndex: i };
  }
  return { valid: true, reason: null, evidenceIndex: null };
}

/** Never mutates the input; never downgrades an already-"rejected"
 *  verificationStatus (mirrors claim-validation.ts's applyEvidenceVerification
 *  exactly). A valid, still-"unverified" obligation is promoted to
 *  "verified"; an invalid one becomes "needs_review" + requiresReview with
 *  a reason appended. */
export function applyExpenseObligationEvidenceVerification(
  obligation: ExpenseObligation,
  doclingRaw: Record<string, unknown> | null | undefined,
): ExpenseObligation {
  const result = verifyExpenseObligationEvidence(obligation, doclingRaw);
  if (result.valid) {
    if (obligation.verificationStatus !== "unverified") return obligation;
    return { ...obligation, verificationStatus: "verified" };
  }
  const reasonText =
    result.reason === "obligation_without_evidence" ? "Obligation has no supporting evidence."
      : result.reason === "evidence_quote_not_found" ? "Evidence quote could not be verified against the source document."
        : "Evidence quote verifies to a different page than claimed.";
  return {
    ...obligation,
    verificationStatus: obligation.verificationStatus === "rejected" ? obligation.verificationStatus : "needs_review",
    requiresReview: true,
    reviewReasons: obligation.reviewReasons.includes(reasonText) ? obligation.reviewReasons : [...obligation.reviewReasons, reasonText],
  };
}

// ── Structural rules (6A.4) ──────────────────────────────────────────────────

export interface StructuralValidationOutcome {
  /** false => the obligation is structurally invalid and must be EXCLUDED
   *  from the canonical set (contributes to invalidObligationCount), not
   *  just flagged. */
  valid: boolean;
  invalidReason: string | null;
  reviewReasons: string[];
}

export function validateExpenseObligationStructure(obligation: ExpenseObligation): StructuralValidationOutcome {
  if (obligation.amountType === "fixed_amount" && obligation.amount === null) {
    return { valid: false, invalidReason: "fixed_amount_without_amount", reviewReasons: [] };
  }

  const reviewReasons: string[] = [];
  // Defensive check for a failure mode Phase 5's insurance-specialist prompt
  // already prevents upstream (verified live on real data) -- catches a
  // future prompt regression rather than assuming one can't happen.
  if (obligation.paymentMechanism === "included_in_base_rent" && obligation.responsibleParty === "landlord") {
    reviewReasons.push("included_in_rent_does_not_prove_legal_responsibility");
  }
  if (obligation.allocationMethod === "pro_rata_share" && obligation.responsibleParty === "not_stated") {
    reviewReasons.push("allocation_present_without_responsible_party");
  }
  if (obligation.cap?.type.includes("percentage") && obligation.cap.value === null) {
    reviewReasons.push("percentage_cap_without_percentage");
  }
  return { valid: true, invalidReason: null, reviewReasons };
}

/** Applies validateExpenseObligationStructure's outcome: invalid
 *  obligations are dropped (caller counts them separately), valid ones get
 *  their review reasons appended (deduplicated) and requiresReview set. */
export function applyStructuralValidation(obligations: ExpenseObligation[]): {
  valid: ExpenseObligation[];
  invalidCount: number;
} {
  const valid: ExpenseObligation[] = [];
  let invalidCount = 0;
  for (const obligation of obligations) {
    const outcome = validateExpenseObligationStructure(obligation);
    if (!outcome.valid) {
      invalidCount++;
      continue;
    }
    if (outcome.reviewReasons.length === 0) {
      valid.push(obligation);
      continue;
    }
    const mergedReasons = [...obligation.reviewReasons];
    for (const reason of outcome.reviewReasons) if (!mergedReasons.includes(reason)) mergedReasons.push(reason);
    valid.push({ ...obligation, requiresReview: true, reviewReasons: mergedReasons });
  }
  return { valid, invalidCount };
}

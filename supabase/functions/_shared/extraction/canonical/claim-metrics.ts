// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer — summary diagnostics for the MLB shadow
 * canary. conversionValueMismatches/duplicateClaimIds/lostFieldCodes are the
 * canary's required gate (all three must be 0/0/[] before Phase 4 starts).
 */

import { claimsToLegacyFields } from "./claim-converters.ts";
import type { ExtractedClaim } from "./extracted-claim.ts";
import type { ExtractedField } from "../types.ts";

export interface CanonicalClaimMetrics {
  totalClaims: number;
  populatedClaims: number;
  verifiedEvidenceClaims: number;
  needsReviewClaims: number;
  missingEvidenceClaims: number;
  /** A claim whose value does not survive claimsToLegacyFields() round-trip
   *  unchanged (excluding "rejected" claims, which are SUPPOSED to
   *  disappear -- see claimsToLegacyFields' own docstring). Must be 0. */
  conversionValueMismatches: number;
  /** Count of duplicate claimIds (0 when every claim has a unique id). */
  duplicateClaimIds: number;
  /** A populated field present in the original authoritative fields object
   *  that produced no claim at all. Must be []. */
  lostFieldCodes: string[];
}

export function computeCanonicalClaimMetrics(args: {
  originalFields: Record<string, ExtractedField>;
  claims: ExtractedClaim[];
}): CanonicalClaimMetrics {
  const { originalFields, claims } = args;

  const totalClaims = claims.length;
  const populatedClaims = claims.filter((c) => c.normalizedValue != null).length;
  const verifiedEvidenceClaims = claims.filter((c) => c.verificationStatus === "verified").length;
  const needsReviewClaims = claims.filter((c) => c.verificationStatus === "needs_review").length;
  const missingEvidenceClaims = claims.filter((c) => c.normalizedValue != null && c.evidence.length === 0).length;

  const roundTripped = claimsToLegacyFields(claims);
  let conversionValueMismatches = 0;
  for (const claim of claims) {
    if (claim.verificationStatus === "rejected") continue; // intentionally absent post-round-trip
    const roundTrippedValue = roundTripped[claim.fieldCode]?.value ?? null;
    const originalValue = claim.normalizedValue ?? null;
    if (String(roundTrippedValue) !== String(originalValue)) conversionValueMismatches++;
  }

  const claimIds = claims.map((c) => c.claimId);
  const duplicateClaimIds = claimIds.length - new Set(claimIds).size;

  const originalFieldKeys = Object.entries(originalFields)
    .filter(([, field]) => field.value != null)
    .map(([key]) => key);
  const claimFieldKeys = new Set(claims.map((c) => c.fieldCode));
  const lostFieldCodes = originalFieldKeys.filter((key) => !claimFieldKeys.has(key));

  return {
    totalClaims,
    populatedClaims,
    verifiedEvidenceClaims,
    needsReviewClaims,
    missingEvidenceClaims,
    conversionValueMismatches,
    duplicateClaimIds,
    lostFieldCodes,
  };
}

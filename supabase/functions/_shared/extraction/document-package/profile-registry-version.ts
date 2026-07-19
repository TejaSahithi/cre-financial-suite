// @ts-nocheck
/**
 * P3.1 — document profile registry version.
 *
 * Deliberately independent of both CLAIMS_REGISTRY_VERSION
 * ("lease-claims-v1", P2.1) and EXTRACTION_CONTRACT_VERSION
 * ("lease-review-evidence-v3", P1.7) -- profile registry versioning is its
 * own concern, not to be conflated with the claims registry or the
 * compatibility payload contract, exactly per the same non-conflation
 * principle already applied when P2.1 introduced CLAIMS_REGISTRY_VERSION.
 */
export const DOCUMENT_PROFILE_REGISTRY_VERSION = "lease-document-profiles-v1";

// @ts-nocheck
/**
 * P2.1 — claim concept registry version.
 *
 * Deliberately independent of the Lease Review compatibility-payload
 * contract version (`_shared/extraction/contract-version.ts`'s
 * EXTRACTION_CONTRACT_VERSION, "lease-review-evidence-v3") -- claims
 * registry versioning and payload contract versioning are separate
 * concepts that happen to both currently be "v-something" strings, per
 * the original P2 spec's explicit instruction not to conflate them.
 */
export const CLAIMS_REGISTRY_VERSION = "lease-claims-v1";

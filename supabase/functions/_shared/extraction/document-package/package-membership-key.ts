// @ts-nocheck
/**
 * Deterministic package-key derivation — P3.3.
 *
 * Never uses upload timestamp, filename, or a similarity score. The same
 * (org, lease, canonical primary file) triple always derives the same key,
 * which is what makes package creation idempotent via
 * create_lease_document_package's existing ON CONFLICT (org_id, package_key)
 * DO NOTHING path (P3.2) — this module only computes the key, it never
 * writes anything.
 */

export const PACKAGE_KEY_CONTRACT_VERSION = "v1";

export function computePackageKey(params: {
  orgId: string;
  leaseId: string | null;
  canonicalPrimaryUploadedFileId: string;
}): string {
  const leasePart = params.leaseId ?? "none";
  return `${params.orgId}:${leasePart}:${params.canonicalPrimaryUploadedFileId}:${PACKAGE_KEY_CONTRACT_VERSION}`;
}

/** Deterministic membership_key for a (package, file, generation, role)
 *  quadruple — mirrors add_document_to_lease_package's own default-key
 *  formula (P3.2) so a resolver-derived decision and a direct RPC call
 *  compute the identical key for the identical input. */
export function computeMembershipKey(params: {
  orgId: string;
  packageId: string;
  uploadedFileId: string;
  generationId: string;
  membershipRole: string;
}): string {
  return `${params.orgId}:${params.packageId}:${params.uploadedFileId}:${params.generationId}:${params.membershipRole}`;
}

/** Deterministic decision_key for lease_package_membership_decisions —
 *  scoped to the specific (file, run, generation) that produced the
 *  decision, so a repeated resolver run for the same generation is
 *  idempotent, while a genuinely new generation produces a new decision
 *  row rather than colliding with or overwriting the old one. */
export function computeDecisionKey(params: {
  orgId: string;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
}): string {
  return `resolver:${params.orgId}:${params.uploadedFileId}:${params.extractionRunId}:${params.generationId}`;
}

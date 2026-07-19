// @ts-nocheck
/**
 * Deterministic P3.4 relationship key derivation.
 *
 * The key deliberately excludes timestamps, insertion order, database row
 * order, filename and confidence. Evidence IDs are normalized before joining
 * so input order cannot change identity.
 */

import { RELATIONSHIP_DETECTOR_CONTRACT_VERSION, type RelationshipCandidate } from "./relationship-types.ts";

function stablePart(value: string | undefined | null, fallback: string): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

export function computeRelationshipEvidenceFingerprint(candidate: Pick<RelationshipCandidate, "evidenceClaimIds" | "dynamicEvidenceClaimIds" | "explicitReference">): string {
  const evidence = [...(candidate.evidenceClaimIds ?? []), ...(candidate.dynamicEvidenceClaimIds ?? [])]
    .map((id) => String(id))
    .filter(Boolean)
    .sort();
  if (evidence.length > 0) return evidence.join(",");
  return candidate.explicitReference ? "explicit-reference:no-claim-id" : "no-evidence";
}

export function computeRelationshipKey(params: {
  orgId: string;
  packageId: string;
  candidate: RelationshipCandidate;
  detectorContractVersion?: string;
}): string {
  const version = stablePart(params.detectorContractVersion, RELATIONSHIP_DETECTOR_CONTRACT_VERSION);
  return [
    "relationship",
    params.orgId,
    params.packageId,
    params.candidate.sourcePackageDocumentId,
    stablePart(params.candidate.targetPackageDocumentId, "missing-target"),
    params.candidate.relationshipType,
    stablePart(params.candidate.sourceSegmentId, "no-source-segment"),
    stablePart(params.candidate.targetSegmentId, "no-target-segment"),
    version,
    computeRelationshipEvidenceFingerprint(params.candidate),
  ].join(":");
}

export function attachRelationshipKeys(input: {
  orgId: string;
  packageId: string;
  detectorContractVersion?: string;
  candidates: RelationshipCandidate[];
}): RelationshipCandidate[] {
  return input.candidates.map((candidate) => ({
    ...candidate,
    relationshipKey: computeRelationshipKey({
      orgId: input.orgId,
      packageId: input.packageId,
      detectorContractVersion: input.detectorContractVersion,
      candidate,
    }),
  }));
}

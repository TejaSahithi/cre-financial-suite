// @ts-nocheck
/**
 * Deterministic P3.4 relationship validator.
 *
 * This does not select effective claims or apply precedence. It only validates
 * the candidate edge and evidence provenance.
 */

import type { PackageDocumentForRelationship, RelationshipCandidate, RelationshipDetectionInput } from "./relationship-types.ts";
import { RELATIONSHIP_REASON_CODES } from "./relationship-types.ts";
import { getDocumentProfile } from "../profile-registry.ts";

const TARGET_COMPATIBILITY: Record<string, Set<string>> = {
  base_document: new Set(["base_lease"]),
  assigns: new Set(["base_lease"]),
  amends: new Set(["base_lease", "lease_amendment", "assignment_and_amendment"]),
  supersedes: new Set(["base_lease", "lease_amendment", "assignment_and_amendment", "lease_extension", "lease_renewal"]),
  extends: new Set(["base_lease"]),
  renews: new Set(["base_lease"]),
  guarantees: new Set(["base_lease"]),
  resolves_commencement: new Set(["base_lease"]),
  incorporates: new Set(["base_lease", "lease_amendment", "assignment_and_amendment"]),
  attachment_to: new Set(["base_lease", "lease_amendment", "assignment_and_amendment"]),
  related_unknown: new Set(["base_lease", "unknown_supported_document"]),
};

export function validateRelationshipCandidate(input: RelationshipDetectionInput, candidate: RelationshipCandidate): RelationshipCandidate {
  const reasonCodes = new Set(candidate.reasonCodes ?? []);
  const documents = new Map(input.documents.map((doc) => [doc.id, doc]));
  const source = documents.get(candidate.sourcePackageDocumentId);
  const target = candidate.targetPackageDocumentId ? documents.get(candidate.targetPackageDocumentId) : undefined;

  if (!source || source.packageId !== input.packageId) reasonCodes.add(RELATIONSHIP_REASON_CODES.TARGET_NOT_IN_PACKAGE);
  if (target && target.packageId !== input.packageId) reasonCodes.add(RELATIONSHIP_REASON_CODES.TARGET_NOT_IN_PACKAGE);
  if (target && target.id === source?.id) reasonCodes.add(RELATIONSHIP_REASON_CODES.SELF_RELATIONSHIP);
  if (source && source.membershipStatus === "rejected") reasonCodes.add(RELATIONSHIP_REASON_CODES.SOURCE_GENERATION_STALE);
  if (target && target.membershipStatus !== "confirmed") reasonCodes.add(RELATIONSHIP_REASON_CODES.TARGET_PROFILE_INCOMPATIBLE);

  const sourceProfile = source ? getDocumentProfile(source.profileKey) : undefined;
  if (sourceProfile && !sourceProfile.allowedRelationshipRoles.includes(candidate.relationshipType) && candidate.relationshipType !== "base_document") {
    reasonCodes.add(RELATIONSHIP_REASON_CODES.SOURCE_PROFILE_INCOMPATIBLE);
  }
  if (target && !(TARGET_COMPATIBILITY[candidate.relationshipType] ?? new Set()).has(target.profileKey)) {
    reasonCodes.add(RELATIONSHIP_REASON_CODES.TARGET_PROFILE_INCOMPATIBLE);
  }

  const evidenceIds = new Set([...(candidate.evidenceClaimIds ?? []), ...(candidate.dynamicEvidenceClaimIds ?? [])]);
  for (const evidenceId of evidenceIds) {
    const claim = input.claims.find((item) => item.id === evidenceId);
    if (!claim || !source || claim.uploadedFileId !== source.uploadedFileId || claim.extractionRunId !== source.extractionRunId || claim.generationId !== source.generationId) {
      reasonCodes.add(RELATIONSHIP_REASON_CODES.EVIDENCE_GENERATION_MISMATCH);
    }
  }

  if (candidate.proposedStatus === "confirmed" && evidenceIds.size === 0 && candidate.relationshipType !== "base_document") {
    reasonCodes.add(RELATIONSHIP_REASON_CODES.EVIDENCE_MISSING);
  }
  if (candidate.proposedStatus === "confirmed" && !candidate.explicitReference && candidate.relationshipType !== "base_document") {
    reasonCodes.add(RELATIONSHIP_REASON_CODES.EXPLICIT_REFERENCE_MISSING);
  }
  if ((candidate.dynamicEvidenceClaimIds?.length ?? 0) > 0 && (candidate.evidenceClaimIds?.length ?? 0) === 0 && candidate.proposedStatus === "confirmed") {
    reasonCodes.add(RELATIONSHIP_REASON_CODES.DYNAMIC_EVIDENCE_UNCORROBORATED);
  }

  const invalidCodes = new Set([
    RELATIONSHIP_REASON_CODES.SOURCE_PROFILE_INCOMPATIBLE,
    RELATIONSHIP_REASON_CODES.TARGET_PROFILE_INCOMPATIBLE,
    RELATIONSHIP_REASON_CODES.SOURCE_GENERATION_STALE,
    RELATIONSHIP_REASON_CODES.TARGET_NOT_IN_PACKAGE,
    RELATIONSHIP_REASON_CODES.EVIDENCE_GENERATION_MISMATCH,
    RELATIONSHIP_REASON_CODES.SELF_RELATIONSHIP,
  ]);
  const validationStatus = [...reasonCodes].some((code) => invalidCodes.has(code))
    ? "invalid"
    : candidate.proposedStatus === "confirmed"
      ? "valid"
      : candidate.proposedStatus === "requires_related_document" || candidate.proposedStatus === "ambiguous"
        ? "needs_review"
        : candidate.validationStatus;

  return {
    ...candidate,
    validationStatus,
    reasonCodes: [...reasonCodes].sort(),
    reviewerConfirmationRequired: candidate.proposedStatus !== "confirmed" || validationStatus !== "valid",
  };
}

export function validateRelationshipCandidates(input: RelationshipDetectionInput, candidates: RelationshipCandidate[]): RelationshipCandidate[] {
  return candidates.map((candidate) => validateRelationshipCandidate(input, candidate));
}

export function isRelationshipTargetCompatible(relationshipType: string, target: PackageDocumentForRelationship): boolean {
  return (TARGET_COMPATIBILITY[relationshipType] ?? new Set()).has(target.profileKey);
}

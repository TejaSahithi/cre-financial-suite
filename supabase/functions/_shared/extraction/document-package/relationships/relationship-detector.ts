// @ts-nocheck
/**
 * Shared P3.4 detector helpers plus the aggregate detector entrypoint.
 */

import type {
  PackageDocumentForRelationship,
  RelationshipCandidate,
  RelationshipClaimSignal,
  RelationshipDetectionInput,
  RelationshipType,
} from "./relationship-types.ts";
import { RELATIONSHIP_REASON_CODES } from "./relationship-types.ts";
import { attachRelationshipKeys } from "./relationship-key.ts";
import { detectAssignmentRelationships } from "./assignment-relationship-detector.ts";
import { detectAmendmentRelationships } from "./amendment-relationship-detector.ts";
import { detectExtensionRenewalRelationships } from "./extension-renewal-detector.ts";
import { detectGuarantyRelationships } from "./guaranty-relationship-detector.ts";
import { detectCommencementRelationships } from "./commencement-relationship-detector.ts";
import { detectAddendumRelationships } from "./addendum-relationship-detector.ts";
import { detectAttachmentRelationships } from "./attachment-relationship-detector.ts";

export const BASE_TARGET_PROFILES = new Set(["base_lease"]);
export const PRIOR_AMENDMENT_TARGET_PROFILES = new Set(["lease_amendment", "assignment_and_amendment"]);

export function stableDocuments(documents: PackageDocumentForRelationship[]): PackageDocumentForRelationship[] {
  return [...documents].sort((a, b) => a.id.localeCompare(b.id));
}

export function claimsForDocument(input: RelationshipDetectionInput, doc: PackageDocumentForRelationship): RelationshipClaimSignal[] {
  return input.claims
    .filter((claim) =>
      (claim.packageDocumentId && claim.packageDocumentId === doc.id) ||
      (!claim.packageDocumentId && claim.uploadedFileId === doc.uploadedFileId)
    )
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function assertedClaims(claims: RelationshipClaimSignal[]): RelationshipClaimSignal[] {
  return claims.filter((claim) => claim.assertionStatus === "asserted" && claim.normalizedValue !== null && String(claim.normalizedValue).trim() !== "");
}

export function claimsByConcept(claims: RelationshipClaimSignal[], conceptKeys: string[]): RelationshipClaimSignal[] {
  const wanted = new Set(conceptKeys);
  return assertedClaims(claims).filter((claim) => wanted.has(claim.conceptKey));
}

export function dynamicClaimsByConcept(claims: RelationshipClaimSignal[], conceptKeys: string[]): RelationshipClaimSignal[] {
  const wanted = new Set(conceptKeys);
  return assertedClaims(claims).filter((claim) => claim.conceptKey.startsWith("dynamic.") && wanted.has(claim.conceptKey));
}

export function hasAnyClaim(claims: RelationshipClaimSignal[], conceptKeys: string[]): boolean {
  return claimsByConcept(claims, conceptKeys).length > 0;
}

export function confirmedDocuments(input: RelationshipDetectionInput): PackageDocumentForRelationship[] {
  return stableDocuments(input.documents).filter((doc) => doc.packageId === input.packageId && doc.membershipStatus === "confirmed");
}

export function targetDocuments(input: RelationshipDetectionInput, profileKeys: Set<string>): PackageDocumentForRelationship[] {
  return confirmedDocuments(input).filter((doc) => profileKeys.has(doc.profileKey));
}

export function makeCandidate(params: {
  relationshipType: RelationshipType;
  source: PackageDocumentForRelationship;
  target?: PackageDocumentForRelationship;
  candidateTargets?: PackageDocumentForRelationship[];
  evidenceClaims?: RelationshipClaimSignal[];
  dynamicEvidenceClaims?: RelationshipClaimSignal[];
  explicitReference: boolean;
  reasonCodes: string[];
  requiresRelatedDocument?: { requirementType: string; reasonCode: string };
  confidence?: number;
}): RelationshipCandidate {
  const targetIds = params.candidateTargets?.map((doc) => doc.id).sort();
  const hasDynamicOnly = (params.dynamicEvidenceClaims?.length ?? 0) > 0 && (params.evidenceClaims?.length ?? 0) === 0;
  const proposedStatus = params.requiresRelatedDocument
    ? "requires_related_document"
    : targetIds && targetIds.length > 1
      ? "ambiguous"
      : params.target && params.explicitReference && !hasDynamicOnly
        ? "confirmed"
        : "proposed";
  const validationStatus = proposedStatus === "confirmed"
    ? "valid"
    : proposedStatus === "requires_related_document"
      ? "needs_review"
      : proposedStatus === "ambiguous" || hasDynamicOnly
        ? "needs_review"
        : "pending";
  return {
    relationshipType: params.relationshipType,
    sourcePackageDocumentId: params.source.id,
    targetPackageDocumentId: params.target?.id,
    sourceSegmentId: params.source.segmentId ?? undefined,
    targetSegmentId: params.target?.segmentId ?? undefined,
    proposedStatus,
    validationStatus,
    confidence: params.confidence,
    reasonCodes: uniqueStrings([
      ...params.reasonCodes,
      ...(hasDynamicOnly ? [RELATIONSHIP_REASON_CODES.DYNAMIC_EVIDENCE_UNCORROBORATED] : []),
      ...(proposedStatus === "confirmed" ? [RELATIONSHIP_REASON_CODES.RELATIONSHIP_VALID] : []),
      ...(proposedStatus !== "confirmed" && !params.requiresRelatedDocument ? [RELATIONSHIP_REASON_CODES.REVIEWER_CONFIRMATION_REQUIRED] : []),
    ]),
    evidenceClaimIds: uniqueStrings((params.evidenceClaims ?? []).map((claim) => claim.id)),
    dynamicEvidenceClaimIds: uniqueStrings((params.dynamicEvidenceClaims ?? []).map((claim) => claim.id)),
    candidateTargetDocumentIds: targetIds,
    explicitReference: params.explicitReference,
    reviewerConfirmationRequired: proposedStatus !== "confirmed",
    requiresRelatedDocument: params.requiresRelatedDocument,
  };
}

export function relationshipForCompatibleTarget(params: {
  input: RelationshipDetectionInput;
  source: PackageDocumentForRelationship;
  relationshipType: RelationshipType;
  compatibleTargets: PackageDocumentForRelationship[];
  evidenceClaims: RelationshipClaimSignal[];
  dynamicEvidenceClaims?: RelationshipClaimSignal[];
  explicitReference: boolean;
  reasonCodes: string[];
  missingRequirementType: string;
  missingReasonCode: string;
  confidence?: number;
}): RelationshipCandidate {
  const targets = stableDocuments(params.compatibleTargets).filter((doc) => doc.id !== params.source.id);
  if (targets.length === 0) {
    return makeCandidate({
      relationshipType: params.relationshipType,
      source: params.source,
      evidenceClaims: params.evidenceClaims,
      dynamicEvidenceClaims: params.dynamicEvidenceClaims,
      explicitReference: params.explicitReference,
      reasonCodes: [...params.reasonCodes, RELATIONSHIP_REASON_CODES.RELATED_DOCUMENT_REQUIRED],
      requiresRelatedDocument: { requirementType: params.missingRequirementType, reasonCode: params.missingReasonCode },
      confidence: params.confidence,
    });
  }
  if (targets.length > 1) {
    return makeCandidate({
      relationshipType: params.relationshipType,
      source: params.source,
      candidateTargets: targets,
      evidenceClaims: params.evidenceClaims,
      dynamicEvidenceClaims: params.dynamicEvidenceClaims,
      explicitReference: params.explicitReference,
      reasonCodes: [...params.reasonCodes, RELATIONSHIP_REASON_CODES.TARGET_AMBIGUOUS],
      confidence: params.confidence,
    });
  }
  return makeCandidate({
    relationshipType: params.relationshipType,
    source: params.source,
    target: targets[0],
    evidenceClaims: params.evidenceClaims,
    dynamicEvidenceClaims: params.dynamicEvidenceClaims,
    explicitReference: params.explicitReference,
    reasonCodes: params.reasonCodes,
    confidence: params.confidence,
  });
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function detectDocumentRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const candidates = [
    ...detectBaseDocumentRelationships(input),
    ...detectAssignmentRelationships(input),
    ...detectAmendmentRelationships(input),
    ...detectExtensionRenewalRelationships(input),
    ...detectGuarantyRelationships(input),
    ...detectCommencementRelationships(input),
    ...detectAddendumRelationships(input),
    ...detectAttachmentRelationships(input),
  ];
  return attachRelationshipKeys({
    orgId: input.orgId,
    packageId: input.packageId,
    detectorContractVersion: input.detectorContractVersion,
    candidates: candidates.sort((a, b) =>
      [
        a.relationshipType,
        a.sourcePackageDocumentId,
        a.targetPackageDocumentId ?? "",
        (a.candidateTargetDocumentIds ?? []).join(","),
        a.evidenceClaimIds.join(","),
        (a.dynamicEvidenceClaimIds ?? []).join(","),
      ].join("|").localeCompare([
        b.relationshipType,
        b.sourcePackageDocumentId,
        b.targetPackageDocumentId ?? "",
        (b.candidateTargetDocumentIds ?? []).join(","),
        b.evidenceClaimIds.join(","),
        (b.dynamicEvidenceClaimIds ?? []).join(","),
      ].join("|"))
    ),
  });
}

function detectBaseDocumentRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseDocs = confirmedDocuments(input).filter((doc) => doc.profileKey === "base_lease" && doc.membershipRole === "primary_base_document");
  return baseDocs.map((doc) => {
    const agrees = !input.packagePrimaryDocumentId || input.packagePrimaryDocumentId === doc.id;
    return makeCandidate({
      relationshipType: "base_document",
      source: doc,
      explicitReference: true,
      reasonCodes: agrees
        ? [RELATIONSHIP_REASON_CODES.BASE_DOCUMENT_CONFIRMED]
        : [RELATIONSHIP_REASON_CODES.BASE_DOCUMENT_CONFIRMED, RELATIONSHIP_REASON_CODES.REVIEWER_CONFIRMATION_REQUIRED],
      evidenceClaims: [],
      confidence: 1,
    });
  }).map((candidate) => ({
    ...candidate,
    proposedStatus: "confirmed",
    validationStatus: "valid",
    reviewerConfirmationRequired: false,
    reasonCodes: uniqueStrings([...candidate.reasonCodes, RELATIONSHIP_REASON_CODES.RELATIONSHIP_VALID]),
  }));
}

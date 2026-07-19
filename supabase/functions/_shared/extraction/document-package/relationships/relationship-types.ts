// @ts-nocheck
/**
 * P3.4 relationship detection contract.
 *
 * Pure detector types only. These candidates do not apply precedence, create
 * package-effective claims, mutate P2 claims, or change Lease Review output.
 */

import type { DocumentProfileKey } from "../profile-types.ts";

export const RELATIONSHIP_DETECTOR_CONTRACT_VERSION = "lease-document-relationships-v1";

export type RelationshipType =
  | "base_document"
  | "amends"
  | "assigns"
  | "supersedes"
  | "extends"
  | "renews"
  | "guarantees"
  | "resolves_commencement"
  | "incorporates"
  | "attachment_to"
  | "related_unknown";

export type ProposedRelationshipStatus = "proposed" | "confirmed" | "ambiguous" | "requires_related_document";
export type RelationshipValidationStatus = "pending" | "valid" | "invalid" | "needs_review";

export interface RelationshipClaimSignal {
  id: string;
  packageDocumentId?: string | null;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  conceptKey: string;
  normalizedValue: string | null;
  assertionStatus: string;
}

export interface PackageDocumentForRelationship {
  id: string;
  packageId: string;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  profileKey: DocumentProfileKey | "unclassified";
  membershipRole: string;
  membershipStatus: string;
  segmentId?: string | null;
}

export interface RelationshipCandidate {
  relationshipType: RelationshipType;
  sourcePackageDocumentId: string;
  targetPackageDocumentId?: string;
  sourceSegmentId?: string;
  targetSegmentId?: string;
  proposedStatus: ProposedRelationshipStatus;
  validationStatus: RelationshipValidationStatus;
  confidence?: number;
  reasonCodes: string[];
  evidenceClaimIds: string[];
  dynamicEvidenceClaimIds?: string[];
  candidateTargetDocumentIds?: string[];
  explicitReference: boolean;
  reviewerConfirmationRequired: boolean;
  requiresRelatedDocument?: {
    requirementType: string;
    reasonCode: string;
  };
  relationshipKey?: string;
}

export interface RelationshipDetectionInput {
  orgId: string;
  packageId: string;
  packagePrimaryDocumentId?: string | null;
  detectorContractVersion?: string;
  documents: PackageDocumentForRelationship[];
  claims: RelationshipClaimSignal[];
}

export const RELATIONSHIP_REASON_CODES = {
  SOURCE_PROFILE_INCOMPATIBLE: "SOURCE_PROFILE_INCOMPATIBLE",
  TARGET_PROFILE_INCOMPATIBLE: "TARGET_PROFILE_INCOMPATIBLE",
  SOURCE_GENERATION_STALE: "SOURCE_GENERATION_STALE",
  TARGET_NOT_IN_PACKAGE: "TARGET_NOT_IN_PACKAGE",
  TARGET_AMBIGUOUS: "TARGET_AMBIGUOUS",
  EXPLICIT_REFERENCE_MISSING: "EXPLICIT_REFERENCE_MISSING",
  EVIDENCE_MISSING: "EVIDENCE_MISSING",
  EVIDENCE_GENERATION_MISMATCH: "EVIDENCE_GENERATION_MISMATCH",
  DYNAMIC_EVIDENCE_UNCORROBORATED: "DYNAMIC_EVIDENCE_UNCORROBORATED",
  SELF_RELATIONSHIP: "SELF_RELATIONSHIP",
  UPLOAD_ORDER_NOT_EVIDENCE: "UPLOAD_ORDER_NOT_EVIDENCE",
  RELATED_DOCUMENT_REQUIRED: "RELATED_DOCUMENT_REQUIRED",
  RELATIONSHIP_VALID: "RELATIONSHIP_VALID",
  REVIEWER_CONFIRMATION_REQUIRED: "REVIEWER_CONFIRMATION_REQUIRED",
  BASE_DOCUMENT_CONFIRMED: "BASE_DOCUMENT_CONFIRMED",
  ASSIGNMENT_EXPLICIT_REFERENCE: "ASSIGNMENT_EXPLICIT_REFERENCE",
  AMENDMENT_EXPLICIT_REFERENCE: "AMENDMENT_EXPLICIT_REFERENCE",
  PRIOR_AMENDMENT_REFERENCE: "PRIOR_AMENDMENT_REFERENCE",
  EXTENSION_EXPLICIT_REFERENCE: "EXTENSION_EXPLICIT_REFERENCE",
  RENEWAL_EXPLICIT_REFERENCE: "RENEWAL_EXPLICIT_REFERENCE",
  GUARANTY_EXPLICIT_REFERENCE: "GUARANTY_EXPLICIT_REFERENCE",
  COMMENCEMENT_EXPLICIT_REFERENCE: "COMMENCEMENT_EXPLICIT_REFERENCE",
  ADDENDUM_EXPLICIT_REFERENCE: "ADDENDUM_EXPLICIT_REFERENCE",
  ATTACHMENT_EXPLICIT_REFERENCE: "ATTACHMENT_EXPLICIT_REFERENCE",
  SUPERSEDES_EXPLICIT_LANGUAGE: "SUPERSEDES_EXPLICIT_LANGUAGE",
  COMBINED_PROFILE_INDEPENDENT_RELATIONSHIPS: "COMBINED_PROFILE_INDEPENDENT_RELATIONSHIPS",
  NO_PRECEDENCE_APPLIED: "NO_PRECEDENCE_APPLIED",
  NO_EFFECTIVE_CLAIMS_CREATED: "NO_EFFECTIVE_CLAIMS_CREATED",
} as const;

// @ts-nocheck
/**
 * P3.5 package-resolution types.
 *
 * These types describe immutable P2 source claims plus confirmed P3 package
 * membership/relationship state. They do not project compatibility JSON,
 * mutate source claims, or change Lease Review output.
 */

import type { DocumentProfileKey } from "../profile-types.ts";
import type { RelationshipType } from "../relationships/relationship-types.ts";

export type PackageResolutionStatus =
  | "effective"
  | "inherited"
  | "overridden"
  | "needs_review"
  | "requires_related_document"
  | "not_present"
  | "not_applicable"
  | "unreadable"
  | "extraction_failed";

export type PackageResolutionConflictType =
  | "multiple_explicit_overrides"
  | "relationship_ambiguous"
  | "amendment_order_ambiguous"
  | "competing_assignments"
  | "competing_commencement_certificates"
  | "supersession_ambiguous"
  | "incompatible_package_documents"
  | "stale_generation_candidate"
  | "missing_related_document"
  | "domain_scope_conflict";

export interface PackageResolutionDocument {
  id: string;
  orgId: string;
  packageId: string;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  activeGenerationId?: string | null;
  profileKey: DocumentProfileKey | "unclassified";
  membershipRole: string;
  membershipStatus: string;
}

export interface PackageResolutionClaim {
  id: string;
  orgId: string;
  packageDocumentId: string;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  conceptKey: string;
  scopeKey?: string | null;
  instanceKey?: string | null;
  assertionStatus: string;
  normalizedValue: string | null;
  registryStatus?: "registered" | "unregistered";
  producerType?: string;
  confidence?: number | null;
  hasEvidence?: boolean;
}

export interface PackageResolutionRelationship {
  id: string;
  orgId: string;
  packageId: string;
  sourcePackageDocumentId: string;
  targetPackageDocumentId?: string | null;
  relationshipType: RelationshipType;
  relationshipStatus: string;
  validationStatus: string;
  generationId: string;
  evidenceClaimId?: string | null;
  evidenceClaimIds?: string[];
}

export interface PackageResolutionRequirement {
  id: string;
  orgId: string;
  packageId: string;
  requestingPackageDocumentId: string;
  requirementType: string;
  requirementStatus: string;
  reasonCode: string;
}

export interface PackageResolutionReviewerDecision {
  conflictKey?: string;
  conflictType?: PackageResolutionConflictType;
  conceptKey: string;
  scopeKey?: string | null;
  instanceKey?: string | null;
  selectedClaimId?: string | null;
  operation: "choose_claim" | "reject_override" | "confirm_relationship_order" | "waive_related_document_requirement" | "reopen";
}

export interface PackageClaimResolution {
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  status: PackageResolutionStatus;
  selectedClaimId?: string;
  baseClaimId?: string;
  overridingClaimId?: string;
  sourcePackageDocumentId?: string;
  sourceRelationshipId?: string;
  precedenceRule: string;
  reasonCodes: string[];
  relationshipPath: string[];
  conflict?: {
    type: PackageResolutionConflictType;
    candidateClaimIds: string[];
    candidateRelationshipIds: string[];
  };
  relatedDocumentRequirementId?: string;
}

export interface PackageClaimOverride {
  baseClaimId?: string;
  overridingClaimId: string;
  relationshipId: string;
  conceptKey: string;
  overrideType: string;
  validationStatus: "valid" | "invalid" | "needs_review";
  reasonCodes: string[];
}

export interface PackageConflict {
  conflictKey: string;
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  conflictType: PackageResolutionConflictType;
  candidateClaimIds: string[];
  candidateRelationshipIds: string[];
  reasonCodes: string[];
}

export interface PackageResolutionInput {
  orgId: string;
  packageId: string;
  leaseId?: string | null;
  documents: PackageResolutionDocument[];
  claims: PackageResolutionClaim[];
  relationships: PackageResolutionRelationship[];
  requirements?: PackageResolutionRequirement[];
  reviewerDecisions?: PackageResolutionReviewerDecision[];
  requestedConceptKeys?: string[];
  resolutionVersion?: string;
}

export interface PackageResolutionResult {
  resolutions: PackageClaimResolution[];
  overrides: PackageClaimOverride[];
  conflicts: PackageConflict[];
}

export const PACKAGE_RESOLUTION_REASON_CODES = {
  BASE_CLAIM_EFFECTIVE: "BASE_CLAIM_EFFECTIVE",
  BASE_CLAIM_INHERITED: "BASE_CLAIM_INHERITED",
  EXPLICIT_OVERRIDE_SELECTED: "EXPLICIT_OVERRIDE_SELECTED",
  REVIEWER_SELECTED_CLAIM: "REVIEWER_SELECTED_CLAIM",
  SOURCE_CLAIM_IMMUTABLE: "SOURCE_CLAIM_IMMUTABLE",
  RELATIONSHIP_CONFIRMED_VALID: "RELATIONSHIP_CONFIRMED_VALID",
  RELATIONSHIP_NOT_CONFIRMED_VALID: "RELATIONSHIP_NOT_CONFIRMED_VALID",
  RELATIONSHIP_DOMAIN_NOT_PERMITTED: "RELATIONSHIP_DOMAIN_NOT_PERMITTED",
  CONCEPT_NOT_EXPLICITLY_ADDRESSED: "CONCEPT_NOT_EXPLICITLY_ADDRESSED",
  MISSING_RELATED_DOCUMENT: "MISSING_RELATED_DOCUMENT",
  COMPETING_CANDIDATES_NEED_REVIEW: "COMPETING_CANDIDATES_NEED_REVIEW",
  STALE_SOURCE_GENERATION: "STALE_SOURCE_GENERATION",
  CROSS_ORG_OR_PACKAGE_REJECTED: "CROSS_ORG_OR_PACKAGE_REJECTED",
  DYNAMIC_CLAIM_NOT_AUTHORITATIVE: "DYNAMIC_CLAIM_NOT_AUTHORITATIVE",
  NO_UPLOAD_ORDER_PRECEDENCE: "NO_UPLOAD_ORDER_PRECEDENCE",
  NO_FILENAME_PRECEDENCE: "NO_FILENAME_PRECEDENCE",
  NO_DATE_CALCULATION: "NO_DATE_CALCULATION",
  NO_COMPATIBILITY_PROJECTION: "NO_COMPATIBILITY_PROJECTION",
} as const;

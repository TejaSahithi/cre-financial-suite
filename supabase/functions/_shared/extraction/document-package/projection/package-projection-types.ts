// @ts-nocheck
/**
 * P3.6 package projection types.
 *
 * These types adapt completed P3.5 package-effective claims into the existing
 * P2 Lease Review compatibility projection shape. They do not mutate P2
 * source claims and do not write extraction_data/workflow_output.
 */

import type { CompatibilityExtractionData } from "../../claims/adapters/compatibility-payload-builder.ts";
import type { FieldProjectionEntry } from "../../claims/adapters/claims-to-field-projection.ts";
import type {
  PackageClaimResolution,
  PackageConflict,
  PackageResolutionClaim,
  PackageResolutionDocument,
  PackageResolutionRequirement,
} from "../resolution/package-resolution-types.ts";

export type PackageProjectionStatus =
  | "base"
  | "inherited"
  | "overridden"
  | "party_role_changed"
  | "resolved_by_certificate"
  | "addendum_override"
  | "reviewer_resolved"
  | "needs_review"
  | "requires_related_document"
  | "unavailable";

export type PackageProjectionRunStatus = "running" | "completed" | "failed" | "superseded";

export type PackageProjectionDiffClassification =
  | "equal"
  | "representation_only"
  | "inherited_from_base"
  | "explicit_amendment_override"
  | "assignment_party_change"
  | "extension_or_renewal_change"
  | "resolved_by_commencement_certificate"
  | "guaranty_added"
  | "rent_addendum_override"
  | "cam_addendum_override"
  | "work_letter_override"
  | "requires_related_document"
  | "package_conflict"
  | "missing_in_package_projection"
  | "extra_in_package_projection"
  | "value_mismatch"
  | "evidence_mismatch"
  | "status_mismatch"
  | "confidence_mismatch"
  | "ordering_mismatch";

export interface PackageProjectionResolutionRun {
  id: string;
  orgId: string;
  packageId: string;
  leaseId?: string | null;
  status: PackageProjectionRunStatus | "completed";
  resolutionVersion?: string;
}

export interface PackageProjectionSourceClaim extends PackageResolutionClaim {
  claimId?: string;
  rawValueText?: string | null;
  sourcePage?: number | null;
  sourceText?: string | null;
  createdAt?: string | null;
  supersededByClaimId?: string | null;
  originalFieldKey?: string | null;
  originalLabel?: string | null;
}

export interface PackageProjectionInput {
  orgId: string;
  packageId: string;
  leaseId?: string | null;
  resolutionRun: PackageProjectionResolutionRun;
  documents: PackageResolutionDocument[];
  sourceClaims: PackageProjectionSourceClaim[];
  effectiveClaims: PackageClaimResolution[];
  conflicts?: PackageConflict[];
  requirements?: PackageResolutionRequirement[];
}

export interface PackageFieldProjectionEntry extends FieldProjectionEntry {
  packageEffectiveClaimId?: string | null;
  selectedSourceClaimId?: string | null;
  baseSourceClaimId?: string | null;
  overridingSourceClaimId?: string | null;
  sourcePackageDocumentId?: string | null;
  sourceRelationshipId?: string | null;
  packageStatus: PackageProjectionStatus;
  precedenceRule: string;
  projectionReason: string;
  relationshipPath: string[];
  conflict?: PackageClaimResolution["conflict"];
  relatedDocumentRequirementId?: string | null;
  originalDynamicKey?: string | null;
  originalLabel?: string | null;
}

export interface PackageCompatibilityProjection {
  fieldProjection: PackageFieldProjectionEntry[];
  compatibilitySlice: CompatibilityExtractionData;
  metadata: {
    projectedFieldCount: number;
    inheritedFieldCount: number;
    overriddenFieldCount: number;
    needsReviewFieldCount: number;
    requiresRelatedDocumentCount: number;
    dynamicFieldCount: number;
    conflictCount: number;
  };
}

export interface PackageProjectionDiffResult {
  fieldKey: string;
  classification: PackageProjectionDiffClassification;
  legacyValue?: unknown;
  packageValue?: unknown;
  packageStatus?: PackageProjectionStatus;
  precedenceRule?: string;
}

export interface PackageProjectionServiceResult extends PackageCompatibilityProjection {
  persisted: boolean;
  diff?: PackageProjectionDiffResult[];
  diffSummary?: Record<string, number>;
  persistResult?: unknown;
}

export const PACKAGE_PROJECTION_ERROR_CODES = {
  PACKAGE_PROJECTION_INPUT_INVALID: "PACKAGE_PROJECTION_INPUT_INVALID",
  PACKAGE_RESOLUTION_NOT_COMPLETED: "PACKAGE_RESOLUTION_NOT_COMPLETED",
  PACKAGE_EFFECTIVE_CLAIM_MISSING: "PACKAGE_EFFECTIVE_CLAIM_MISSING",
  PACKAGE_EFFECTIVE_CLAIM_DUPLICATE: "PACKAGE_EFFECTIVE_CLAIM_DUPLICATE",
  PACKAGE_SELECTED_CLAIM_STALE: "PACKAGE_SELECTED_CLAIM_STALE",
  PACKAGE_SELECTED_CLAIM_OUTSIDE_PACKAGE: "PACKAGE_SELECTED_CLAIM_OUTSIDE_PACKAGE",
  PACKAGE_CONFLICT_STATUS_MISMATCH: "PACKAGE_CONFLICT_STATUS_MISMATCH",
  PACKAGE_RELATED_DOCUMENT_LINK_MISSING: "PACKAGE_RELATED_DOCUMENT_LINK_MISSING",
  PACKAGE_COMPATIBILITY_BUILD_FAILED: "PACKAGE_COMPATIBILITY_BUILD_FAILED",
} as const;

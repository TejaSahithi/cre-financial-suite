// @ts-nocheck
/**
 * Package-membership decision types — P3.3.
 *
 * The resolver (package-membership-resolver.ts) is a pure function over
 * these types: no DB access, fully deterministic, fully unit-testable with
 * LEASE_DOCUMENT_PACKAGE_MODE=off. Persistence (the service layer) is a
 * separate concern.
 */

import type { DocumentProfileKey } from "./profile-types.ts";

export type MembershipRole =
  | "primary_base_document"
  | "related_document"
  | "amendment_document"
  | "assignment_document"
  | "extension_document"
  | "renewal_document"
  | "commencement_document"
  | "guaranty_document"
  | "addendum_document"
  | "exhibit_document"
  | "unknown_document";

export type MembershipStatus = "proposed" | "confirmed" | "ambiguous" | "rejected";

export type MembershipSource = "legacy_link" | "deterministic" | "reviewer" | "system";

export type MembershipDecisionType =
  | "create_package"
  | "join_existing_package"
  | "propose_existing_package"
  | "ambiguous"
  | "requires_related_document"
  | "unsupported";

export interface PackageMembershipDecision {
  decision: MembershipDecisionType;
  packageId?: string;
  membershipRole: MembershipRole;
  membershipStatus: MembershipStatus;
  membershipSource: MembershipSource;
  confidence?: number;
  reasonCodes: string[];
  evidenceClaimIds: string[];
  candidatePackageIds?: string[];
  relatedDocumentRequirement?: {
    requirementType: string;
    reasonCode: string;
  };
}

/** A minimal, already-normalized claim projection — never raw evidence text.
 *  Callers build this from real `lease_claims` rows (concept_key/scope_key/
 *  instance_key/normalized_value/assertion_status/id) — the resolver never
 *  reads a claims table itself. */
export interface MembershipClaimSignal {
  id: string;
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  normalizedValue: string | null;
  assertionStatus: string;
}

/** Existing lease-linkage signals — sourced from `leases`/`uploaded_files`,
 *  never inferred from name/address similarity. */
export interface LeaseLinkageSignal {
  leaseId: string | null;
  /** True when this uploaded_file_id already equals leases.source_file_id
   *  for leaseId — the legacy one-source link, read-only here. */
  isLegacySourceDocument: boolean;
  propertyId: string | null;
  unitId: string | null;
  tenantId: string | null;
}

/** One candidate package returned by the candidate-finder — never ranked by
 *  recency; the resolver decides ambiguity vs. selection. */
export interface PackageCandidate {
  packageId: string;
  leaseId: string | null;
  /** Which strong-identifier tier produced this candidate (documentation/
   *  reason-code input only). */
  matchedVia: "legacy_source_file" | "explicit_lease_linkage" | "explicit_document_reference";
  /** Whether this package already has a CONFIRMED primary_base_document
   *  member — read from lease_package_documents by the candidate-finder,
   *  since the resolver itself never queries the DB. */
  hasConfirmedPrimaryBaseDocument: boolean;
}

export interface MembershipResolverInput {
  profileKey: DocumentProfileKey | "unclassified";
  claims: MembershipClaimSignal[];
  leaseLinkage: LeaseLinkageSignal;
  candidates: PackageCandidate[];
}

export const REASON_CODES = {
  MULTIPLE_PACKAGE_CANDIDATES: "MULTIPLE_PACKAGE_CANDIDATES",
  ORIGINAL_LEASE_REFERENCE_AMBIGUOUS: "ORIGINAL_LEASE_REFERENCE_AMBIGUOUS",
  LEASE_LINK_CONFLICT: "LEASE_LINK_CONFLICT",
  PARTY_MATCH_INSUFFICIENT: "PARTY_MATCH_INSUFFICIENT",
  PREMISES_MATCH_INSUFFICIENT: "PREMISES_MATCH_INSUFFICIENT",
  PROFILE_NOT_PACKAGE_RESOLVABLE: "PROFILE_NOT_PACKAGE_RESOLVABLE",
  REVIEWER_CONFIRMATION_REQUIRED: "REVIEWER_CONFIRMATION_REQUIRED",
  LEGACY_SOURCE_DOCUMENT: "LEGACY_SOURCE_DOCUMENT",
  BASE_LEASE_WITH_LEASE_LINKAGE: "BASE_LEASE_WITH_LEASE_LINKAGE",
  NO_LEASE_LINKAGE_NO_CANDIDATE: "NO_LEASE_LINKAGE_NO_CANDIDATE",
  EXPLICIT_REFERENCE_MATCHED_ONE_CANDIDATE: "EXPLICIT_REFERENCE_MATCHED_ONE_CANDIDATE",
} as const;

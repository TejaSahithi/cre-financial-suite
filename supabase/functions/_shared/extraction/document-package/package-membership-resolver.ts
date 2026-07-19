// @ts-nocheck
/**
 * Package-membership resolver — P3.3.
 *
 * Pure function: no DB access, fully deterministic given its inputs,
 * fully unit-testable with LEASE_DOCUMENT_PACKAGE_MODE=off. Never confirms
 * membership from upload ordering, name/address similarity, "same
 * property" alone, filename conventions, or model confidence alone --
 * those signals are not even present in this module's input shape.
 */

import type { DocumentProfileKey } from "./profile-types.ts";
import type {
  MembershipDecisionType,
  MembershipResolverInput,
  MembershipRole,
  PackageCandidate,
  PackageMembershipDecision,
} from "./package-membership-types.ts";
import { REASON_CODES } from "./package-membership-types.ts";
import { detectRelatedDocumentRequirement } from "./package-requirement-detector.ts";

const PROFILE_TO_ROLE: Record<Exclude<DocumentProfileKey, "base_lease">, MembershipRole> = {
  lease_assignment: "assignment_document",
  lease_amendment: "amendment_document",
  assignment_and_amendment: "assignment_document",
  lease_extension: "extension_document",
  lease_renewal: "renewal_document",
  commencement_certificate: "commencement_document",
  guaranty: "guaranty_document",
  rent_addendum: "addendum_document",
  cam_addendum: "addendum_document",
  work_letter: "exhibit_document",
  exhibit: "exhibit_document",
  unknown_supported_document: "unknown_document",
};

/** base_lease never becomes primary_base_document merely because the
 *  candidate package lacks one yet -- it only avoids the role when a
 *  DIFFERENT confirmed primary already exists (a genuine conflict, handled
 *  separately as ambiguous), never as a default. */
function mapProfileToMembershipRole(profileKey: DocumentProfileKey | "unclassified"): MembershipRole {
  if (profileKey === "unclassified") return "unknown_document";
  if (profileKey === "base_lease") return "primary_base_document";
  return PROFILE_TO_ROLE[profileKey];
}

function decisionWithRequirement(
  decision: PackageMembershipDecision,
  input: MembershipResolverInput,
  targetPackage: PackageCandidate | undefined,
): PackageMembershipDecision {
  const requirement = detectRelatedDocumentRequirement({
    profileKey: input.profileKey,
    claims: input.claims,
    hasBaseDocumentInPackage: targetPackage?.hasConfirmedPrimaryBaseDocument ?? false,
    hasPriorAmendmentInPackage: false,
  });
  if (!requirement) return decision;
  return {
    ...decision,
    relatedDocumentRequirement: { requirementType: requirement.requirementType, reasonCode: requirement.reasonCode },
    evidenceClaimIds: [...decision.evidenceClaimIds, ...requirement.evidenceClaimIds],
  };
}

export function resolvePackageMembership(input: MembershipResolverInput): PackageMembershipDecision {
  const membershipRole = mapProfileToMembershipRole(input.profileKey);

  // --- Case 1: legacy source document -------------------------------------
  if (input.leaseLinkage.isLegacySourceDocument) {
    const legacyCandidates = input.candidates.filter((c) => c.matchedVia === "legacy_source_file");
    if (legacyCandidates.length > 1) {
      return {
        decision: "ambiguous",
        membershipRole: "primary_base_document",
        membershipStatus: "ambiguous",
        membershipSource: "legacy_link",
        reasonCodes: [REASON_CODES.LEASE_LINK_CONFLICT],
        evidenceClaimIds: [],
        candidatePackageIds: legacyCandidates.map((c) => c.packageId),
      };
    }
    if (legacyCandidates.length === 1) {
      return {
        decision: "join_existing_package",
        packageId: legacyCandidates[0].packageId,
        membershipRole: "primary_base_document",
        membershipStatus: "confirmed",
        membershipSource: "legacy_link",
        reasonCodes: [REASON_CODES.LEGACY_SOURCE_DOCUMENT],
        evidenceClaimIds: [],
      };
    }
    return {
      decision: "create_package",
      membershipRole: "primary_base_document",
      membershipStatus: "confirmed",
      membershipSource: "legacy_link",
      reasonCodes: [REASON_CODES.LEGACY_SOURCE_DOCUMENT],
      evidenceClaimIds: [],
    };
  }

  // --- Case 2: base_lease with explicit lease linkage ---------------------
  if (input.profileKey === "base_lease" && input.leaseLinkage.leaseId) {
    const leaseCandidates = input.candidates.filter((c) => c.matchedVia !== "explicit_document_reference");
    if (leaseCandidates.length > 1) {
      return {
        decision: "ambiguous",
        membershipRole,
        membershipStatus: "ambiguous",
        membershipSource: "deterministic",
        reasonCodes: [REASON_CODES.MULTIPLE_PACKAGE_CANDIDATES],
        evidenceClaimIds: [],
        candidatePackageIds: leaseCandidates.map((c) => c.packageId),
      };
    }
    if (leaseCandidates.length === 1) {
      const target = leaseCandidates[0];
      if (target.hasConfirmedPrimaryBaseDocument) {
        // A different base_lease document is already the confirmed primary
        // for this package -- a genuine conflict, never auto-resolved.
        return {
          decision: "ambiguous",
          membershipRole,
          membershipStatus: "ambiguous",
          membershipSource: "deterministic",
          reasonCodes: [REASON_CODES.LEASE_LINK_CONFLICT],
          evidenceClaimIds: [],
          candidatePackageIds: [target.packageId],
        };
      }
      return decisionWithRequirement(
        {
          decision: "join_existing_package",
          packageId: target.packageId,
          membershipRole,
          membershipStatus: "confirmed",
          membershipSource: "deterministic",
          reasonCodes: [REASON_CODES.BASE_LEASE_WITH_LEASE_LINKAGE],
          evidenceClaimIds: [],
        },
        input,
        target,
      );
    }
    return {
      decision: "create_package",
      membershipRole,
      membershipStatus: "confirmed",
      membershipSource: "deterministic",
      reasonCodes: [REASON_CODES.BASE_LEASE_WITH_LEASE_LINKAGE],
      evidenceClaimIds: [],
    };
  }

  // --- Case 3: related document with explicit package reference -----------
  const relatedCandidates = input.candidates.filter(
    (c) => c.matchedVia === "explicit_lease_linkage" || c.matchedVia === "explicit_document_reference",
  );

  if (relatedCandidates.length > 1) {
    return {
      decision: "ambiguous",
      membershipRole,
      membershipStatus: "ambiguous",
      membershipSource: "deterministic",
      reasonCodes: [REASON_CODES.ORIGINAL_LEASE_REFERENCE_AMBIGUOUS],
      evidenceClaimIds: [],
      candidatePackageIds: relatedCandidates.map((c) => c.packageId),
    };
  }

  if (relatedCandidates.length === 1) {
    const target = relatedCandidates[0];
    return decisionWithRequirement(
      {
        decision: "join_existing_package",
        packageId: target.packageId,
        membershipRole,
        membershipStatus: "confirmed",
        membershipSource: "deterministic",
        reasonCodes: [REASON_CODES.EXPLICIT_REFERENCE_MATCHED_ONE_CANDIDATE],
        evidenceClaimIds: [],
      },
      input,
      target,
    );
  }

  // Zero candidates: nothing to join or create automatically for a
  // non-base-lease, non-legacy document. If the profile explicitly requires
  // a base document, this is a genuine requires_related_document outcome
  // (no package at all yet); otherwise it needs reviewer attention to
  // create/attach a package manually.
  const requirement = detectRelatedDocumentRequirement({
    profileKey: input.profileKey,
    claims: input.claims,
    hasBaseDocumentInPackage: false,
    hasPriorAmendmentInPackage: false,
  });
  if (requirement) {
    return {
      decision: "requires_related_document",
      membershipRole,
      membershipStatus: "proposed",
      membershipSource: "deterministic",
      reasonCodes: [REASON_CODES.NO_LEASE_LINKAGE_NO_CANDIDATE],
      evidenceClaimIds: requirement.evidenceClaimIds,
      relatedDocumentRequirement: { requirementType: requirement.requirementType, reasonCode: requirement.reasonCode },
    };
  }

  return {
    decision: "propose_existing_package",
    membershipRole,
    membershipStatus: "proposed",
    membershipSource: "deterministic",
    reasonCodes: [REASON_CODES.REVIEWER_CONFIRMATION_REQUIRED, REASON_CODES.NO_LEASE_LINKAGE_NO_CANDIDATE],
    evidenceClaimIds: [],
  };
}

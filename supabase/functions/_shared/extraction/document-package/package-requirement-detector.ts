// @ts-nocheck
/**
 * Related-document requirement detector — P3.3.
 *
 * Fires ONLY on explicit document-profile or claim evidence — never on "a
 * field happens to be absent." Reuses DOCUMENT_PROFILES' own
 * `requiresBaseDocument` flag (P3.1) rather than hand-rolling a second,
 * potentially-drifting list of "which profiles need a base document."
 */

import type { DocumentProfileKey } from "./profile-types.ts";
import { getDocumentProfile } from "./profile-registry.ts";
import type { MembershipClaimSignal } from "./package-membership-types.ts";

export interface DetectedRequirement {
  requirementType:
    | "base_lease" | "prior_amendment" | "original_assignment" | "commencement_certificate"
    | "guaranty" | "referenced_addendum" | "exhibit" | "other_related_document";
  reasonCode: string;
  evidenceClaimIds: string[];
}

export interface RequirementDetectionInput {
  profileKey: DocumentProfileKey | "unclassified";
  claims: MembershipClaimSignal[];
  /** Whether the package this document resolved (or would resolve) into
   *  already has a confirmed primary_base_document member. */
  hasBaseDocumentInPackage: boolean;
  /** Whether a prior amendment referenced by this amendment already
   *  resolves to an existing package document. Honest limitation: no real
   *  concept exists yet to compute this precisely (see the dynamic-key
   *  comment below) -- callers that cannot determine this should pass
   *  `false` (the conservative default: assume not yet resolved) rather
   *  than omitting the requirement check entirely. */
  hasPriorAmendmentInPackage: boolean;
}

/** Well-known dynamic (unregistered) claim key names that, when present,
 *  carry a signal this detector can act on today. No registered concept
 *  exists yet for "prior amendment reference" (confirmed absent from
 *  field-contract.ts's real 92 canonicalKey entries) -- this is an honest,
 *  documented P3.4+ gap, not fabricated here. */
const PRIOR_AMENDMENT_REFERENCE_DYNAMIC_KEYS = ["dynamic.prior_amendment_reference", "dynamic.referenced_amendment_number"];

export function detectRelatedDocumentRequirement(input: RequirementDetectionInput): DetectedRequirement | null {
  if (input.profileKey === "unclassified") return null;

  const profile = getDocumentProfile(input.profileKey);
  if (!profile) return null;

  if (profile.requiresBaseDocument && !input.hasBaseDocumentInPackage) {
    return {
      requirementType: "base_lease",
      reasonCode: `${input.profileKey}_references_missing_base_lease`,
      evidenceClaimIds: [],
    };
  }

  // Reached only when the base-document gate above didn't already fire --
  // i.e. either the profile doesn't require a base document, or one is
  // already present. A referenced-prior-amendment gap is a distinct,
  // independent signal from "no base document at all," so it is checked
  // unconditionally here (on the dynamic claim's presence only), not gated
  // on hasBaseDocumentInPackage a second time.
  if (input.profileKey === "lease_amendment" && !input.hasPriorAmendmentInPackage) {
    const priorAmendmentClaims = input.claims.filter((c) => PRIOR_AMENDMENT_REFERENCE_DYNAMIC_KEYS.includes(c.conceptKey) && c.normalizedValue);
    if (priorAmendmentClaims.length > 0) {
      return {
        requirementType: "prior_amendment",
        reasonCode: "amendment_references_missing_prior_amendment",
        evidenceClaimIds: priorAmendmentClaims.map((c) => c.id),
      };
    }
  }

  return null;
}

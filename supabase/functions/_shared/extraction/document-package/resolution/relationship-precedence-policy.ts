// @ts-nocheck
/**
 * P3.5 relationship/domain precedence policy.
 *
 * This is the narrow authority map. Relationship type alone is never enough;
 * the later/source document must explicitly carry a claim for the concept.
 */

import type { RelationshipType } from "../relationships/relationship-types.ts";
import { getPackageConceptDomain, type PackageConceptDomain } from "./concept-domain-policy.ts";

export interface RelationshipEffectPolicy {
  permitted: boolean;
  precedenceRule: string;
  overrideType: string;
  reasonCodes: string[];
  requiresReview?: boolean;
}

const ASSIGNMENT_ALLOWED = new Set(["parties", "assignment", "notices"]);
const AMENDMENT_ALLOWED = new Set([
  "parties",
  "assignment",
  "premises",
  "term",
  "rent",
  "expenses",
  "cam",
  "insurance",
  "utilities",
  "repairs",
  "options",
  "critical_dates",
  "notices",
  "signatures",
  "work",
  "document",
]);
const TERM_ALLOWED = new Set(["term", "rent", "options", "critical_dates", "notices"]);
const COMMENCEMENT_ALLOWED = new Set(["term"]);
const GUARANTY_ALLOWED = new Set(["parties"]);
const RENT_ADDENDUM_ALLOWED = new Set(["rent"]);
const CAM_ADDENDUM_ALLOWED = new Set(["cam", "expenses"]);
const WORK_ALLOWED = new Set(["work"]);

function permitted(domain: PackageConceptDomain, allowed: Set<string>): boolean {
  return allowed.has(domain);
}

export function getRelationshipEffectPolicy(params: {
  relationshipType: RelationshipType;
  sourceProfileKey?: string;
  conceptKey: string;
}): RelationshipEffectPolicy {
  const domain = getPackageConceptDomain(params.conceptKey);
  if (domain === "dynamic") {
    return {
      permitted: false,
      precedenceRule: "dynamic_claim_requires_corroboration",
      overrideType: "invalid_dynamic",
      reasonCodes: ["DYNAMIC_CLAIM_NOT_AUTHORITATIVE"],
      requiresReview: true,
    };
  }

  switch (params.relationshipType) {
    case "assigns":
      return {
        permitted: permitted(domain, ASSIGNMENT_ALLOWED),
        precedenceRule: "assignment_party_change",
        overrideType: "assignment_party_change",
        reasonCodes: ["ASSIGNMENT_SCOPE_LIMITED"],
      };
    case "amends":
      return {
        permitted: permitted(domain, AMENDMENT_ALLOWED),
        precedenceRule: "explicit_amendment_override",
        overrideType: "explicit_amendment",
        reasonCodes: ["AMENDMENT_EXPLICIT_CONCEPT_ONLY"],
      };
    case "extends":
      return {
        permitted: permitted(domain, TERM_ALLOWED),
        precedenceRule: "extension_term_change",
        overrideType: "extension_term_change",
        reasonCodes: ["EXTENSION_EXPLICIT_TERM_ONLY", "NO_DATE_CALCULATION"],
      };
    case "renews":
      return {
        permitted: permitted(domain, TERM_ALLOWED),
        precedenceRule: "renewal_term_change",
        overrideType: "renewal_term_change",
        reasonCodes: ["RENEWAL_EXPLICIT_TERM_ONLY", "NO_DATE_CALCULATION"],
      };
    case "resolves_commencement":
      return {
        permitted: permitted(domain, COMMENCEMENT_ALLOWED),
        precedenceRule: "commencement_certificate_resolution",
        overrideType: "commencement_resolution",
        reasonCodes: ["COMMENCEMENT_EXPLICIT_DATE_ONLY", "NO_DATE_CALCULATION"],
      };
    case "guarantees":
      return {
        permitted: permitted(domain, GUARANTY_ALLOWED) && /guarant/i.test(params.conceptKey),
        precedenceRule: "guaranty_adds_guarantor_claim",
        overrideType: "guaranty_party_addition",
        reasonCodes: ["GUARANTY_DOES_NOT_REPLACE_TENANT"],
      };
    case "incorporates":
    case "attachment_to": {
      const profile = params.sourceProfileKey ?? "";
      const allowed = profile === "rent_addendum"
        ? RENT_ADDENDUM_ALLOWED
        : profile === "cam_addendum"
          ? CAM_ADDENDUM_ALLOWED
          : profile === "work_letter"
            ? WORK_ALLOWED
            : AMENDMENT_ALLOWED;
      return {
        permitted: permitted(domain, allowed),
        precedenceRule: `${profile || "attachment"}_domain_override`,
        overrideType: profile === "rent_addendum"
          ? "domain_addendum"
          : profile === "cam_addendum"
            ? "domain_addendum"
            : profile === "work_letter"
              ? "work_letter"
              : "explicit_attachment",
        reasonCodes: ["DOMAIN_SCOPE_LIMITED"],
        requiresReview: !permitted(domain, allowed),
      };
    }
    case "supersedes":
      return {
        permitted: permitted(domain, AMENDMENT_ALLOWED),
        precedenceRule: "explicit_supersession",
        overrideType: "explicit_supersession",
        reasonCodes: ["SUPERSESSION_EXPLICIT_LANGUAGE_REQUIRED"],
      };
    case "base_document":
      return {
        permitted: true,
        precedenceRule: "base_document_source_claim",
        overrideType: "base_document",
        reasonCodes: ["BASE_DOCUMENT_EFFECTIVE"],
      };
    default:
      return {
        permitted: false,
        precedenceRule: "relationship_type_not_authorized",
        overrideType: "invalid_relationship",
        reasonCodes: ["RELATIONSHIP_DOMAIN_NOT_PERMITTED"],
        requiresReview: true,
      };
  }
}

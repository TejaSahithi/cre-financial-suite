// @ts-nocheck
import type { PackageDocumentForRelationship, RelationshipCandidate, RelationshipDetectionInput } from "./relationship-types.ts";
import { RELATIONSHIP_REASON_CODES } from "./relationship-types.ts";
import {
  BASE_TARGET_PROFILES,
  PRIOR_AMENDMENT_TARGET_PROFILES,
  claimsByConcept,
  claimsForDocument,
  relationshipForCompatibleTarget,
  stableDocuments,
  targetDocuments,
} from "./relationship-detector.ts";

const AMENDMENT_PROFILES = new Set(["lease_amendment", "assignment_and_amendment"]);
const AMENDMENT_REFERENCE_CLAIMS = ["original_lease_date", "all_other_terms_remain_same"];
const AMENDMENT_DYNAMIC_CLAIMS = ["dynamic.amendment_language", "dynamic.amendment_number", "dynamic.amendment_effective_date", "dynamic.referenced_lease_identifier"];
const PRIOR_AMENDMENT_DYNAMIC_CLAIMS = ["dynamic.prior_amendment_reference", "dynamic.referenced_amendment_number"];
const SUPERSEDES_LANGUAGE_CLAIMS = ["dynamic.supersedes_language", "dynamic.restatement_language"];

export function detectAmendmentRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseTargets = targetDocuments(input, BASE_TARGET_PROFILES);
  const priorTargets = targetDocuments(input, PRIOR_AMENDMENT_TARGET_PROFILES);
  const candidates: RelationshipCandidate[] = [];
  for (const source of stableDocuments(input.documents).filter((doc) => AMENDMENT_PROFILES.has(doc.profileKey))) {
    const claims = claimsForDocument(input, source);
    const evidence = claimsByConcept(claims, AMENDMENT_REFERENCE_CLAIMS);
    const dynamicEvidence = claimsByConcept(claims, AMENDMENT_DYNAMIC_CLAIMS);
    candidates.push(relationshipForCompatibleTarget({
      input,
      source,
      relationshipType: "amends",
      compatibleTargets: baseTargets,
      evidenceClaims: evidence,
      dynamicEvidenceClaims: dynamicEvidence.filter((claim) => claim.conceptKey.startsWith("dynamic.")),
      explicitReference: evidence.length > 0 || dynamicEvidence.length > 0,
      reasonCodes: [
        RELATIONSHIP_REASON_CODES.AMENDMENT_EXPLICIT_REFERENCE,
        RELATIONSHIP_REASON_CODES.NO_PRECEDENCE_APPLIED,
        ...(source.profileKey === "assignment_and_amendment" ? [RELATIONSHIP_REASON_CODES.COMBINED_PROFILE_INDEPENDENT_RELATIONSHIPS] : []),
      ],
      missingRequirementType: "base_lease",
      missingReasonCode: "amendment_references_missing_base_lease",
      confidence: evidence.length > 0 ? 0.84 : 0.52,
    }));

    const priorEvidence = claimsByConcept(claims, PRIOR_AMENDMENT_DYNAMIC_CLAIMS);
    if (priorEvidence.length > 0) {
      candidates.push(relationshipForCompatibleTarget({
        input,
        source,
        relationshipType: "incorporates",
        compatibleTargets: priorTargets.filter((target: PackageDocumentForRelationship) => target.id !== source.id),
        evidenceClaims: [],
        dynamicEvidenceClaims: priorEvidence,
        explicitReference: true,
        reasonCodes: [RELATIONSHIP_REASON_CODES.PRIOR_AMENDMENT_REFERENCE, RELATIONSHIP_REASON_CODES.NO_PRECEDENCE_APPLIED],
        missingRequirementType: "prior_amendment",
        missingReasonCode: "amendment_references_missing_prior_amendment",
        confidence: 0.5,
      }));
    }

    const supersedesEvidence = claimsByConcept(claims, SUPERSEDES_LANGUAGE_CLAIMS);
    if (supersedesEvidence.length > 0) {
      candidates.push(relationshipForCompatibleTarget({
        input,
        source,
        relationshipType: "supersedes",
        compatibleTargets: [...baseTargets, ...priorTargets].filter((target) => target.id !== source.id),
        evidenceClaims: [],
        dynamicEvidenceClaims: supersedesEvidence,
        explicitReference: true,
        reasonCodes: [RELATIONSHIP_REASON_CODES.SUPERSEDES_EXPLICIT_LANGUAGE, RELATIONSHIP_REASON_CODES.NO_PRECEDENCE_APPLIED],
        missingRequirementType: "referenced_document",
        missingReasonCode: "supersedes_referenced_document_missing",
        confidence: 0.56,
      }));
    }
  }
  return candidates;
}

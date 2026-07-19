// @ts-nocheck
import type { RelationshipCandidate, RelationshipDetectionInput } from "./relationship-types.ts";
import { RELATIONSHIP_REASON_CODES } from "./relationship-types.ts";
import {
  BASE_TARGET_PROFILES,
  claimsByConcept,
  claimsForDocument,
  relationshipForCompatibleTarget,
  stableDocuments,
  targetDocuments,
} from "./relationship-detector.ts";

export function detectGuarantyRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseTargets = targetDocuments(input, BASE_TARGET_PROFILES);
  return stableDocuments(input.documents)
    .filter((source) => source.profileKey === "guaranty")
    .map((source) => {
      const claims = claimsForDocument(input, source);
      const evidence = claimsByConcept(claims, ["guarantor_name", "tenant_name", "original_lease_date"]);
      const dynamicEvidence = claimsByConcept(claims, ["dynamic.guaranty_language", "dynamic.referenced_lease_identifier"]);
      return relationshipForCompatibleTarget({
        input,
        source,
        relationshipType: "guarantees",
        compatibleTargets: baseTargets,
        evidenceClaims: evidence,
        dynamicEvidenceClaims: dynamicEvidence,
        explicitReference: evidence.length > 0 || dynamicEvidence.length > 0,
        reasonCodes: [RELATIONSHIP_REASON_CODES.GUARANTY_EXPLICIT_REFERENCE, RELATIONSHIP_REASON_CODES.NO_EFFECTIVE_CLAIMS_CREATED],
        missingRequirementType: "base_lease",
        missingReasonCode: "guaranty_references_missing_base_lease",
        confidence: evidence.length > 0 ? 0.82 : 0.5,
      });
    });
}

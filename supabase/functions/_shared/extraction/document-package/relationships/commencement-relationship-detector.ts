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

export function detectCommencementRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseTargets = targetDocuments(input, BASE_TARGET_PROFILES);
  return stableDocuments(input.documents)
    .filter((source) => source.profileKey === "commencement_certificate")
    .map((source) => {
      const claims = claimsForDocument(input, source);
      const evidence = claimsByConcept(claims, ["commencement_date", "expiration_date", "rent_commencement_date", "original_lease_date"]);
      const dynamicEvidence = claimsByConcept(claims, ["dynamic.commencement_certificate_language", "dynamic.referenced_lease_identifier"]);
      return relationshipForCompatibleTarget({
        input,
        source,
        relationshipType: "resolves_commencement",
        compatibleTargets: baseTargets,
        evidenceClaims: evidence,
        dynamicEvidenceClaims: dynamicEvidence,
        explicitReference: evidence.length > 0 || dynamicEvidence.length > 0,
        reasonCodes: [RELATIONSHIP_REASON_CODES.COMMENCEMENT_EXPLICIT_REFERENCE, RELATIONSHIP_REASON_CODES.NO_EFFECTIVE_CLAIMS_CREATED],
        missingRequirementType: "base_lease",
        missingReasonCode: "commencement_certificate_references_missing_base_lease",
        confidence: evidence.length > 0 ? 0.82 : 0.5,
      });
    });
}

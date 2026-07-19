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

export function detectExtensionRenewalRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseTargets = targetDocuments(input, BASE_TARGET_PROFILES);
  const candidates: RelationshipCandidate[] = [];
  for (const source of stableDocuments(input.documents)) {
    if (source.profileKey !== "lease_extension" && source.profileKey !== "lease_renewal") continue;
    const claims = claimsForDocument(input, source);
    const evidence = claimsByConcept(claims, ["original_lease_date", "expiration_date", "renewal_options"]);
    const dynamicEvidence = claimsByConcept(claims, [
      source.profileKey === "lease_extension" ? "dynamic.extension_language" : "dynamic.renewal_language",
      "dynamic.referenced_lease_identifier",
    ]);
    candidates.push(relationshipForCompatibleTarget({
      input,
      source,
      relationshipType: source.profileKey === "lease_extension" ? "extends" : "renews",
      compatibleTargets: baseTargets,
      evidenceClaims: evidence,
      dynamicEvidenceClaims: dynamicEvidence,
      explicitReference: evidence.length > 0 || dynamicEvidence.length > 0,
      reasonCodes: [
        source.profileKey === "lease_extension" ? RELATIONSHIP_REASON_CODES.EXTENSION_EXPLICIT_REFERENCE : RELATIONSHIP_REASON_CODES.RENEWAL_EXPLICIT_REFERENCE,
        RELATIONSHIP_REASON_CODES.NO_PRECEDENCE_APPLIED,
      ],
      missingRequirementType: "base_lease",
      missingReasonCode: `${source.profileKey}_references_missing_base_lease`,
      confidence: evidence.length > 0 ? 0.82 : 0.5,
    }));
  }
  return candidates;
}

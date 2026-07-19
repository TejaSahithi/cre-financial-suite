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

const ADDENDUM_PROFILES = new Set(["rent_addendum", "cam_addendum"]);

export function detectAddendumRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseTargets = targetDocuments(input, BASE_TARGET_PROFILES);
  const candidates: RelationshipCandidate[] = [];
  for (const source of stableDocuments(input.documents).filter((doc) => ADDENDUM_PROFILES.has(doc.profileKey))) {
    const claims = claimsForDocument(input, source);
    const isRent = source.profileKey === "rent_addendum";
    const evidence = claimsByConcept(claims, isRent
      ? ["monthly_rent", "annual_rent", "escalation_rate", "original_lease_date"]
      : ["cam_amount", "cam_cap_type", "cam_cap_pct", "original_lease_date"]);
    const dynamicEvidence = claimsByConcept(claims, [
      isRent ? "dynamic.rent_addendum_language" : "dynamic.cam_addendum_language",
      "dynamic.referenced_lease_identifier",
    ]);
    candidates.push(relationshipForCompatibleTarget({
      input,
      source,
      relationshipType: "incorporates",
      compatibleTargets: baseTargets,
      evidenceClaims: evidence,
      dynamicEvidenceClaims: dynamicEvidence,
      explicitReference: evidence.length > 0 || dynamicEvidence.length > 0,
      reasonCodes: [
        RELATIONSHIP_REASON_CODES.ADDENDUM_EXPLICIT_REFERENCE,
        isRent ? "RENT_DOMAIN_ONLY" : "CAM_DOMAIN_ONLY",
        RELATIONSHIP_REASON_CODES.NO_PRECEDENCE_APPLIED,
      ],
      missingRequirementType: "base_lease",
      missingReasonCode: `${source.profileKey}_references_missing_base_lease`,
      confidence: evidence.length > 0 ? 0.8 : 0.5,
    }));
  }
  return candidates;
}

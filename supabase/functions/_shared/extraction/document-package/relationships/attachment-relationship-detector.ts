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

const ATTACHMENT_PROFILES = new Set(["work_letter", "exhibit", "unknown_supported_document"]);

export function detectAttachmentRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const baseTargets = targetDocuments(input, BASE_TARGET_PROFILES);
  const candidates: RelationshipCandidate[] = [];
  for (const source of stableDocuments(input.documents).filter((doc) => ATTACHMENT_PROFILES.has(doc.profileKey))) {
    const claims = claimsForDocument(input, source);
    const incorporationEvidence = claimsByConcept(claims, ["ti_allowance", "original_lease_date"]);
    const attachmentEvidence = claimsByConcept(claims, ["dynamic.attachment_language", "dynamic.exhibit_language", "dynamic.work_letter_language", "dynamic.referenced_lease_identifier"]);
    if (incorporationEvidence.length === 0 && attachmentEvidence.length === 0 && source.profileKey === "unknown_supported_document") {
      continue;
    }
    candidates.push(relationshipForCompatibleTarget({
      input,
      source,
      relationshipType: source.profileKey === "work_letter" && incorporationEvidence.length > 0 ? "incorporates" : "attachment_to",
      compatibleTargets: baseTargets,
      evidenceClaims: incorporationEvidence,
      dynamicEvidenceClaims: attachmentEvidence,
      explicitReference: incorporationEvidence.length > 0 || attachmentEvidence.length > 0,
      reasonCodes: [
        source.profileKey === "work_letter" ? RELATIONSHIP_REASON_CODES.ADDENDUM_EXPLICIT_REFERENCE : RELATIONSHIP_REASON_CODES.ATTACHMENT_EXPLICIT_REFERENCE,
        RELATIONSHIP_REASON_CODES.NO_PRECEDENCE_APPLIED,
      ],
      missingRequirementType: "base_lease",
      missingReasonCode: `${source.profileKey}_references_missing_base_lease`,
      confidence: incorporationEvidence.length > 0 ? 0.78 : 0.48,
    }));
  }
  return candidates;
}

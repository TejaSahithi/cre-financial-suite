// @ts-nocheck
import type { RelationshipCandidate, RelationshipDetectionInput } from "./relationship-types.ts";
import { RELATIONSHIP_REASON_CODES } from "./relationship-types.ts";
import {
  BASE_TARGET_PROFILES,
  claimsByConcept,
  claimsForDocument,
  hasAnyClaim,
  relationshipForCompatibleTarget,
  stableDocuments,
  targetDocuments,
} from "./relationship-detector.ts";

const ASSIGNMENT_PROFILES = new Set(["lease_assignment", "assignment_and_amendment"]);
const ASSIGNMENT_PARTY_CLAIMS = ["assignor_name", "assignee_name", "assignment_effective_date"];
const ASSIGNMENT_REFERENCE_CLAIMS = ["original_lease_date", "document_profile"];
const ASSIGNMENT_LANGUAGE_CLAIMS = ["dynamic.assignment_language", "dynamic.original_lease_reference", "dynamic.referenced_lease_identifier"];

export function detectAssignmentRelationships(input: RelationshipDetectionInput): RelationshipCandidate[] {
  const targets = targetDocuments(input, BASE_TARGET_PROFILES);
  const candidates: RelationshipCandidate[] = [];
  for (const source of stableDocuments(input.documents).filter((doc) => ASSIGNMENT_PROFILES.has(doc.profileKey))) {
    const claims = claimsForDocument(input, source);
    const strongEvidence = claimsByConcept(claims, ASSIGNMENT_REFERENCE_CLAIMS);
    const dynamicEvidence = claimsByConcept(claims, ASSIGNMENT_LANGUAGE_CLAIMS);
    const partyOnly = hasAnyClaim(claims, ASSIGNMENT_PARTY_CLAIMS) && strongEvidence.length === 0 && dynamicEvidence.length === 0;
    if (partyOnly && targets.length > 0) {
      candidates.push({
        ...relationshipForCompatibleTarget({
          input,
          source,
          relationshipType: "assigns",
          compatibleTargets: [],
          evidenceClaims: [],
          explicitReference: false,
          reasonCodes: [RELATIONSHIP_REASON_CODES.EXPLICIT_REFERENCE_MISSING, RELATIONSHIP_REASON_CODES.REVIEWER_CONFIRMATION_REQUIRED],
          missingRequirementType: "base_lease",
          missingReasonCode: "assignment_explicit_reference_missing",
          confidence: 0.35,
        }),
        proposedStatus: "proposed",
        validationStatus: "pending",
        requiresRelatedDocument: undefined,
      });
      continue;
    }
    candidates.push(relationshipForCompatibleTarget({
      input,
      source,
      relationshipType: "assigns",
      compatibleTargets: targets,
      evidenceClaims: strongEvidence,
      dynamicEvidenceClaims: dynamicEvidence.filter((claim) => claim.conceptKey.startsWith("dynamic.")),
      explicitReference: strongEvidence.length > 0 || dynamicEvidence.length > 0,
      reasonCodes: [
        RELATIONSHIP_REASON_CODES.ASSIGNMENT_EXPLICIT_REFERENCE,
        ...(source.profileKey === "assignment_and_amendment" ? [RELATIONSHIP_REASON_CODES.COMBINED_PROFILE_INDEPENDENT_RELATIONSHIPS] : []),
      ],
      missingRequirementType: "base_lease",
      missingReasonCode: "assignment_references_missing_base_lease",
      confidence: strongEvidence.length > 0 ? 0.86 : 0.55,
    }));
  }
  return candidates;
}

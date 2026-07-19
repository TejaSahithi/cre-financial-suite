// @ts-nocheck
/**
 * P3.5 pure package-claim resolver.
 *
 * No DB access. No runtime writes. No compatibility projection. The resolver
 * selects package-effective claims only from immutable source claim IDs and
 * confirmed/valid document relationships.
 */

import { PACKAGE_RESOLUTION_VERSION } from "./package-resolution-version.ts";
import { BASE_DEPENDENT_CONCEPTS, isRegisteredAuthoritativeConcept } from "./concept-domain-policy.ts";
import { getRelationshipEffectPolicy } from "./relationship-precedence-policy.ts";
import { buildPackageConflict, conflictTypeForRelationshipTypes } from "./package-conflict-detector.ts";
import type {
  PackageClaimOverride,
  PackageClaimResolution,
  PackageConflict,
  PackageResolutionClaim,
  PackageResolutionDocument,
  PackageResolutionInput,
  PackageResolutionRelationship,
  PackageResolutionRequirement,
  PackageResolutionResult,
} from "./package-resolution-types.ts";
import { PACKAGE_RESOLUTION_REASON_CODES } from "./package-resolution-types.ts";

const VALUE_BEARING = new Set(["asserted", "derived", "calculated"]);
const EXPLICIT_STATUS = new Set(["not_present", "not_applicable", "unreadable", "extraction_failed"]);

interface OverrideCandidate {
  claim: PackageResolutionClaim;
  baseClaim?: PackageResolutionClaim;
  relationship: PackageResolutionRelationship;
  sourceDocument: PackageResolutionDocument;
  precedenceRule: string;
  overrideType: string;
  reasonCodes: string[];
}

function scopeKey(claimOrValue?: { scopeKey?: string | null } | null): string {
  return claimOrValue?.scopeKey || "lease";
}

function instanceKey(claimOrValue?: { instanceKey?: string | null } | null): string {
  return claimOrValue?.instanceKey || "default";
}

function slotKey(conceptKey: string, scope = "lease", instance = "default"): string {
  return `${conceptKey}\u0000${scope}\u0000${instance}`;
}

function compareStrings(a: string, b: string): number {
  return a.localeCompare(b);
}

function isActiveDocument(document: PackageResolutionDocument): boolean {
  return document.membershipStatus === "confirmed"
    && document.orgId
    && document.packageId
    && (!document.activeGenerationId || document.activeGenerationId === document.generationId);
}

function isBaseDocument(document: PackageResolutionDocument): boolean {
  return document.membershipRole === "primary_base_document" || document.profileKey === "base_lease";
}

function isValueBearingClaim(claim: PackageResolutionClaim): boolean {
  return VALUE_BEARING.has(claim.assertionStatus) && claim.normalizedValue !== null;
}

function claimBelongsToDocument(claim: PackageResolutionClaim, document: PackageResolutionDocument): boolean {
  return claim.orgId === document.orgId
    && claim.packageDocumentId === document.id
    && claim.uploadedFileId === document.uploadedFileId
    && claim.extractionRunId === document.extractionRunId
    && claim.generationId === document.generationId;
}

function isConfirmedValidRelationship(relationship: PackageResolutionRelationship): boolean {
  return relationship.relationshipStatus === "confirmed" && relationship.validationStatus === "valid";
}

function claimOrder(a: PackageResolutionClaim, b: PackageResolutionClaim): number {
  return compareStrings(a.id, b.id);
}

function requirementOrder(a: PackageResolutionRequirement, b: PackageResolutionRequirement): number {
  return compareStrings(a.id, b.id);
}

function resolutionOrder(a: PackageClaimResolution, b: PackageClaimResolution): number {
  return slotKey(a.conceptKey, a.scopeKey, a.instanceKey).localeCompare(slotKey(b.conceptKey, b.scopeKey, b.instanceKey));
}

function normalizedValuesDiffer(candidates: OverrideCandidate[]): boolean {
  return new Set(candidates.map((candidate) => candidate.claim.normalizedValue ?? "")).size > 1;
}

function dedupeCandidatesBySourceClaim(candidates: OverrideCandidate[]): OverrideCandidate[] {
  const deduped = new Map<string, OverrideCandidate>();
  for (const candidate of candidates) {
    const existing = deduped.get(candidate.claim.id);
    if (!existing || compareStrings(candidate.relationship.id, existing.relationship.id) < 0) {
      deduped.set(candidate.claim.id, candidate);
    }
  }
  return [...deduped.values()].sort((a, b) => compareStrings(a.claim.id, b.claim.id));
}

function isBaseDependentConcept(conceptKey: string): boolean {
  return BASE_DEPENDENT_CONCEPTS.includes(conceptKey);
}

function reviewerSelectionFor(input: PackageResolutionInput, conceptKey: string, scope: string, instance: string) {
  return (input.reviewerDecisions ?? []).find((decision) =>
    decision.operation === "choose_claim"
    && decision.conceptKey === conceptKey
    && scopeKey(decision) === scope
    && instanceKey(decision) === instance
    && decision.selectedClaimId
  );
}

function makeRequiresRelatedDocument(params: {
  conceptKey: string;
  scopeKey?: string;
  instanceKey?: string;
  requirement: PackageResolutionRequirement;
}): PackageClaimResolution {
  return {
    conceptKey: params.conceptKey,
    scopeKey: params.scopeKey ?? "lease",
    instanceKey: params.instanceKey ?? "default",
    status: "requires_related_document",
    precedenceRule: "missing_related_document",
    reasonCodes: [
      PACKAGE_RESOLUTION_REASON_CODES.MISSING_RELATED_DOCUMENT,
      params.requirement.reasonCode,
    ],
    relationshipPath: [],
    relatedDocumentRequirementId: params.requirement.id,
  };
}

export function resolvePackageClaims(input: PackageResolutionInput): PackageResolutionResult {
  const resolutionVersion = input.resolutionVersion ?? PACKAGE_RESOLUTION_VERSION;
  const documentsById = new Map(input.documents.map((document) => [document.id, document]));
  const activeDocuments = input.documents
    .filter((document) => document.orgId === input.orgId && document.packageId === input.packageId && isActiveDocument(document))
    .sort((a, b) => compareStrings(a.id, b.id));
  const activeDocumentIds = new Set(activeDocuments.map((document) => document.id));
  const baseDocuments = activeDocuments.filter(isBaseDocument);
  const hasBaseDocument = baseDocuments.length > 0;

  const activeClaims = input.claims
    .filter((claim) => {
      const document = documentsById.get(claim.packageDocumentId);
      return document
        && activeDocumentIds.has(document.id)
        && claim.orgId === input.orgId
        && claimBelongsToDocument(claim, document)
        && isRegisteredAuthoritativeConcept(claim.conceptKey);
    })
    .sort(claimOrder);

  const staleClaims = input.claims.filter((claim) => {
    const document = documentsById.get(claim.packageDocumentId);
    return !document || !activeDocumentIds.has(document.id) || !claimBelongsToDocument(claim, document);
  });

  const claimsBySlot = new Map<string, PackageResolutionClaim[]>();
  for (const claim of activeClaims) {
    const key = slotKey(claim.conceptKey, scopeKey(claim), instanceKey(claim));
    claimsBySlot.set(key, [...(claimsBySlot.get(key) ?? []), claim]);
  }

  const baseClaimsBySlot = new Map<string, PackageResolutionClaim[]>();
  for (const claim of activeClaims) {
    const document = documentsById.get(claim.packageDocumentId);
    if (!document || !isBaseDocument(document)) continue;
    const key = slotKey(claim.conceptKey, scopeKey(claim), instanceKey(claim));
    baseClaimsBySlot.set(key, [...(baseClaimsBySlot.get(key) ?? []), claim]);
  }

  const validRelationships = input.relationships
    .filter((relationship) => {
      const source = documentsById.get(relationship.sourcePackageDocumentId);
      const target = relationship.targetPackageDocumentId ? documentsById.get(relationship.targetPackageDocumentId) : undefined;
      return relationship.orgId === input.orgId
        && relationship.packageId === input.packageId
        && isConfirmedValidRelationship(relationship)
        && source
        && activeDocumentIds.has(source.id)
        && (!relationship.targetPackageDocumentId || (target && activeDocumentIds.has(target.id)))
        && relationship.generationId === source.generationId;
    })
    .sort((a, b) => compareStrings(a.id, b.id));

  const openRequirements = (input.requirements ?? [])
    .filter((requirement) =>
      requirement.orgId === input.orgId
      && requirement.packageId === input.packageId
      && (requirement.requirementStatus === "open" || requirement.requirementStatus === "ambiguous")
    )
    .sort(requirementOrder);

  const overrideCandidatesBySlot = new Map<string, OverrideCandidate[]>();
  const invalidDomainConflicts: PackageConflict[] = [];
  for (const relationship of validRelationships) {
    if (relationship.relationshipType === "base_document") continue;
    const sourceDocument = documentsById.get(relationship.sourcePackageDocumentId);
    if (!sourceDocument) continue;
    const sourceClaims = activeClaims.filter((claim) => claim.packageDocumentId === sourceDocument.id && isValueBearingClaim(claim));
    for (const claim of sourceClaims) {
      const policy = getRelationshipEffectPolicy({
        relationshipType: relationship.relationshipType,
        sourceProfileKey: sourceDocument.profileKey,
        conceptKey: claim.conceptKey,
      });
      const key = slotKey(claim.conceptKey, scopeKey(claim), instanceKey(claim));
      if (!policy.permitted) {
        invalidDomainConflicts.push(buildPackageConflict({
          orgId: input.orgId,
          packageId: input.packageId,
          conceptKey: claim.conceptKey,
          scopeKey: scopeKey(claim),
          instanceKey: instanceKey(claim),
          conflictType: "domain_scope_conflict",
          candidateClaimIds: [claim.id],
          candidateRelationshipIds: [relationship.id],
          reasonCodes: policy.reasonCodes,
          resolutionVersion,
        }));
        continue;
      }
      const baseClaim = (baseClaimsBySlot.get(key) ?? []).filter(isValueBearingClaim).sort(claimOrder)[0];
      overrideCandidatesBySlot.set(key, [
        ...(overrideCandidatesBySlot.get(key) ?? []),
        {
          claim,
          baseClaim,
          relationship,
          sourceDocument,
          precedenceRule: policy.precedenceRule,
          overrideType: policy.overrideType,
          reasonCodes: policy.reasonCodes,
        },
      ]);
    }
  }

  const conceptKeys = new Set<string>(input.requestedConceptKeys ?? []);
  for (const claim of activeClaims) conceptKeys.add(claim.conceptKey);
  for (const concept of BASE_DEPENDENT_CONCEPTS) {
    if (!hasBaseDocument && openRequirements.some((requirement) => requirement.requirementType === "base_lease")) {
      conceptKeys.add(concept);
    }
  }

  const resolutions: PackageClaimResolution[] = [];
  const overrides: PackageClaimOverride[] = [];
  const conflicts: PackageConflict[] = [...invalidDomainConflicts];
  const seenSlots = new Set<string>();

  for (const conceptKey of [...conceptKeys].sort()) {
    const slotCandidates = [...claimsBySlot.keys()]
      .filter((key) => key.startsWith(`${conceptKey}\u0000`));
    if (slotCandidates.length === 0) slotCandidates.push(slotKey(conceptKey));

    for (const key of slotCandidates.sort()) {
      if (seenSlots.has(key)) continue;
      seenSlots.add(key);
      const [slotConcept, scope, instance] = key.split("\u0000");
      const slotClaims = (claimsBySlot.get(key) ?? []).sort(claimOrder);
      const baseClaims = (baseClaimsBySlot.get(key) ?? []).sort(claimOrder);
      const candidates = dedupeCandidatesBySourceClaim(overrideCandidatesBySlot.get(key) ?? []);
      const reviewerSelection = reviewerSelectionFor(input, slotConcept, scope, instance);
      const openRequirement = openRequirements.find((requirement) =>
        requirement.requirementType === "base_lease"
        || (requirement.requirementType === "prior_amendment" && activeDocumentIds.has(requirement.requestingPackageDocumentId))
      );

      if (staleClaims.some((claim) => claim.conceptKey === slotConcept && scopeKey(claim) === scope && instanceKey(claim) === instance)) {
        const staleConflict = buildPackageConflict({
          orgId: input.orgId,
          packageId: input.packageId,
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          conflictType: "stale_generation_candidate",
          candidateClaimIds: staleClaims.filter((claim) => claim.conceptKey === slotConcept).map((claim) => claim.id),
          candidateRelationshipIds: [],
          reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.STALE_SOURCE_GENERATION],
          resolutionVersion,
        });
        conflicts.push(staleConflict);
        resolutions.push({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          status: "needs_review",
          precedenceRule: "stale_generation_rejected",
          reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.STALE_SOURCE_GENERATION],
          relationshipPath: [],
          conflict: {
            type: staleConflict.conflictType,
            candidateClaimIds: staleConflict.candidateClaimIds,
            candidateRelationshipIds: staleConflict.candidateRelationshipIds,
          },
        });
        continue;
      }

      if (reviewerSelection?.selectedClaimId) {
        const selected = activeClaims.find((claim) => claim.id === reviewerSelection.selectedClaimId);
        if (selected && selected.conceptKey === slotConcept && scopeKey(selected) === scope && instanceKey(selected) === instance) {
          resolutions.push({
            conceptKey: slotConcept,
            scopeKey: scope,
            instanceKey: instance,
            status: "effective",
            selectedClaimId: selected.id,
            sourcePackageDocumentId: selected.packageDocumentId,
            precedenceRule: "reviewer_confirmed_package_resolution",
            reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.REVIEWER_SELECTED_CLAIM],
            relationshipPath: [],
          });
          continue;
        }
      }

      if (candidates.length > 1 && (normalizedValuesDiffer(candidates) || new Set(candidates.map((candidate) => candidate.relationship.id)).size > 1)) {
        const conflict = buildPackageConflict({
          orgId: input.orgId,
          packageId: input.packageId,
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          conflictType: conflictTypeForRelationshipTypes(candidates.map((candidate) => candidate.relationship.relationshipType)),
          candidateClaimIds: candidates.map((candidate) => candidate.claim.id),
          candidateRelationshipIds: candidates.map((candidate) => candidate.relationship.id),
          reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.COMPETING_CANDIDATES_NEED_REVIEW],
          resolutionVersion,
        });
        conflicts.push(conflict);
        resolutions.push({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          status: "needs_review",
          precedenceRule: "package_conflict_requires_review",
          reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.COMPETING_CANDIDATES_NEED_REVIEW],
          relationshipPath: candidates.map((candidate) => candidate.relationship.id).sort(),
          conflict: {
            type: conflict.conflictType,
            candidateClaimIds: conflict.candidateClaimIds,
            candidateRelationshipIds: conflict.candidateRelationshipIds,
          },
        });
        continue;
      }

      if (candidates.length === 1) {
        const candidate = candidates[0];
        overrides.push({
          baseClaimId: candidate.baseClaim?.id,
          overridingClaimId: candidate.claim.id,
          relationshipId: candidate.relationship.id,
          conceptKey: slotConcept,
          overrideType: candidate.overrideType,
          validationStatus: "valid",
          reasonCodes: [...candidate.reasonCodes, PACKAGE_RESOLUTION_REASON_CODES.RELATIONSHIP_CONFIRMED_VALID].sort(),
        });
        resolutions.push({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          status: "effective",
          selectedClaimId: candidate.claim.id,
          baseClaimId: candidate.baseClaim?.id,
          overridingClaimId: candidate.claim.id,
          sourcePackageDocumentId: candidate.claim.packageDocumentId,
          sourceRelationshipId: candidate.relationship.id,
          precedenceRule: candidate.precedenceRule,
          reasonCodes: [...candidate.reasonCodes, PACKAGE_RESOLUTION_REASON_CODES.EXPLICIT_OVERRIDE_SELECTED, PACKAGE_RESOLUTION_REASON_CODES.SOURCE_CLAIM_IMMUTABLE].sort(),
          relationshipPath: [candidate.relationship.id],
        });
        continue;
      }

      const valueBaseClaim = baseClaims.filter(isValueBearingClaim)[0];
      if (valueBaseClaim) {
        const hasLaterPackageContext = validRelationships.some((relationship) => relationship.relationshipType !== "base_document")
          || activeDocuments.some((document) => !isBaseDocument(document));
        resolutions.push({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          status: hasLaterPackageContext ? "inherited" : "effective",
          selectedClaimId: valueBaseClaim.id,
          baseClaimId: valueBaseClaim.id,
          sourcePackageDocumentId: valueBaseClaim.packageDocumentId,
          precedenceRule: hasLaterPackageContext ? "base_claim_inherited_unchanged" : "base_document_source_claim",
          reasonCodes: [
            hasLaterPackageContext ? PACKAGE_RESOLUTION_REASON_CODES.BASE_CLAIM_INHERITED : PACKAGE_RESOLUTION_REASON_CODES.BASE_CLAIM_EFFECTIVE,
            PACKAGE_RESOLUTION_REASON_CODES.SOURCE_CLAIM_IMMUTABLE,
          ],
          relationshipPath: [],
        });
        continue;
      }

      const valueSlotClaims = slotClaims.filter(isValueBearingClaim).sort(claimOrder);
      if (!hasBaseDocument && valueSlotClaims.length === 1 && !isBaseDependentConcept(slotConcept)) {
        const selected = valueSlotClaims[0];
        resolutions.push({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          status: "effective",
          selectedClaimId: selected.id,
          sourcePackageDocumentId: selected.packageDocumentId,
          precedenceRule: "single_explicit_package_claim_without_base",
          reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.SOURCE_CLAIM_IMMUTABLE],
          relationshipPath: [],
        });
        continue;
      }

      const explicitStatusClaim = slotClaims.find((claim) => EXPLICIT_STATUS.has(claim.assertionStatus));
      if (explicitStatusClaim) {
        resolutions.push({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          status: explicitStatusClaim.assertionStatus,
          selectedClaimId: explicitStatusClaim.id,
          sourcePackageDocumentId: explicitStatusClaim.packageDocumentId,
          precedenceRule: "explicit_source_status",
          reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.SOURCE_CLAIM_IMMUTABLE],
          relationshipPath: [],
        });
        continue;
      }

      if (openRequirement && (!hasBaseDocument || openRequirement.requirementType === "prior_amendment")) {
        resolutions.push(makeRequiresRelatedDocument({
          conceptKey: slotConcept,
          scopeKey: scope,
          instanceKey: instance,
          requirement: openRequirement,
        }));
        continue;
      }

      resolutions.push({
        conceptKey: slotConcept,
        scopeKey: scope,
        instanceKey: instance,
        status: "not_present",
        precedenceRule: "no_package_source_claim",
        reasonCodes: [PACKAGE_RESOLUTION_REASON_CODES.CONCEPT_NOT_EXPLICITLY_ADDRESSED],
        relationshipPath: [],
      });
    }
  }

  return {
    resolutions: resolutions.sort(resolutionOrder),
    overrides: overrides.sort((a, b) => compareStrings(a.overridingClaimId, b.overridingClaimId)),
    conflicts: conflicts.sort((a, b) => compareStrings(a.conflictKey, b.conflictKey)),
  };
}

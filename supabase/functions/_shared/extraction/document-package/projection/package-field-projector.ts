// @ts-nocheck
/**
 * P3.6 package field projector.
 *
 * Registered concepts reuse P2 buildFieldProjection. P3-only package metadata
 * is carried on PackageFieldProjectionEntry and not exposed in the compatibility
 * payload unless the legacy contract already has a matching field shape.
 */

import { CLAIM_CONCEPTS, getClaimConcept } from "../../claims/concept-registry.ts";
import { buildFieldProjection, type FieldProjectionEntry } from "../../claims/adapters/claims-to-field-projection.ts";
import { adaptPackageEffectiveClaimsToProjectionInput, selectedSourceClaimFor } from "./package-effective-claims-to-projection-input.ts";
import type {
  PackageFieldProjectionEntry,
  PackageProjectionInput,
  PackageProjectionStatus,
  PackageProjectionSourceClaim,
} from "./package-projection-types.ts";

const conceptByKey = new Map(CLAIM_CONCEPTS.map((concept) => [concept.conceptKey, concept]));

function factSlotKey(conceptKey: string, scopeKey = "lease", instanceKey = "default"): string {
  return `${conceptKey}|${scopeKey}|${instanceKey}`;
}

function displayDynamicFieldKey(conceptKey: string, claim?: PackageProjectionSourceClaim | null): string {
  return claim?.originalFieldKey || conceptKey.replace(/^dynamic\./, "custom_");
}

function packageStatusFor(status: string, precedenceRule: string): PackageProjectionStatus {
  if (status === "needs_review") return "needs_review";
  if (status === "requires_related_document") return "requires_related_document";
  if (status === "inherited") return "inherited";
  if (/reviewer/i.test(precedenceRule)) return "reviewer_resolved";
  if (/assignment/i.test(precedenceRule)) return "party_role_changed";
  if (/commencement/i.test(precedenceRule)) return "resolved_by_certificate";
  if (/addendum|attachment|work_letter/i.test(precedenceRule)) return "addendum_override";
  if (/amendment|extension|renewal|supersession/i.test(precedenceRule)) return "overridden";
  if (status === "overridden") return "overridden";
  if (status === "effective") return "base";
  return "unavailable";
}

function outcomeForPackageStatus(status: string): string {
  if (status === "needs_review") return "needs_review";
  if (status === "not_present" || status === "not_applicable" || status === "unreadable" || status === "extraction_failed") return "explicit_status";
  if (status === "requires_related_document") return "requires_related_document";
  return "deterministic";
}

function metadataEntry(params: {
  base: FieldProjectionEntry;
  resolution: any;
  selected?: PackageProjectionSourceClaim | null;
}): PackageFieldProjectionEntry {
  const packageStatus = packageStatusFor(params.resolution.status, params.resolution.precedenceRule);
  return {
    ...params.base,
    packageEffectiveClaimId: null,
    selectedSourceClaimId: params.resolution.selectedClaimId ?? null,
    baseSourceClaimId: params.resolution.baseClaimId ?? null,
    overridingSourceClaimId: params.resolution.overridingClaimId ?? null,
    sourcePackageDocumentId: params.resolution.sourcePackageDocumentId ?? params.selected?.packageDocumentId ?? null,
    sourceRelationshipId: params.resolution.sourceRelationshipId ?? null,
    packageStatus,
    precedenceRule: params.resolution.precedenceRule,
    projectionReason: params.resolution.reasonCodes?.join(",") ?? params.resolution.status,
    relationshipPath: [...(params.resolution.relationshipPath ?? [])].sort(),
    conflict: params.resolution.conflict,
    relatedDocumentRequirementId: params.resolution.relatedDocumentRequirementId ?? null,
    originalDynamicKey: params.selected?.originalFieldKey ?? null,
    originalLabel: params.selected?.originalLabel ?? null,
  };
}

function syntheticEntry(input: PackageProjectionInput, resolution: any): PackageFieldProjectionEntry {
  const selected = selectedSourceClaimFor(input, resolution);
  const concept = getClaimConcept(resolution.conceptKey);
  const isDynamic = resolution.conceptKey.startsWith("dynamic.");
  const fieldKey = concept?.projectionFieldKey ?? displayDynamicFieldKey(resolution.conceptKey, selected);
  const base: FieldProjectionEntry = {
    fieldKey,
    conceptKey: resolution.conceptKey,
    scopeKey: resolution.scopeKey || "lease",
    instanceKey: resolution.instanceKey || "default",
    outcome: outcomeForPackageStatus(resolution.status),
    claimId: resolution.status === "needs_review" ? null : (resolution.selectedClaimId ?? null),
    value: resolution.status === "needs_review" || resolution.status === "requires_related_document" ? null : (selected?.normalizedValue ?? null),
    rawValue: selected?.rawValueText ?? selected?.normalizedValue ?? null,
    sourcePage: selected?.sourcePage ?? null,
    sourceText: resolution.status === "requires_related_document" ? null : (selected?.sourceText ?? null),
    confidence: selected?.confidence ?? null,
  };
  const row = metadataEntry({ base, resolution, selected });
  if (isDynamic) {
    row.originalDynamicKey = selected?.originalFieldKey ?? resolution.conceptKey;
    row.originalLabel = selected?.originalLabel ?? resolution.conceptKey.replace(/^dynamic\./, "");
  }
  return row;
}

export function buildPackageFieldProjection(input: PackageProjectionInput): PackageFieldProjectionEntry[] {
  const adapted = adaptPackageEffectiveClaimsToProjectionInput(input);
  const p2Projection = buildFieldProjection({
    claims: adapted.claims,
    reviewDecisionsByFactSlot: adapted.reviewDecisionsByFactSlot,
    openConflictFactSlots: adapted.openConflictFactSlots,
  });
  const p2BySlot = new Map(p2Projection.map((entry) => [factSlotKey(entry.conceptKey, entry.scopeKey, entry.instanceKey), entry]));
  const rows: PackageFieldProjectionEntry[] = [];

  for (const resolution of [...input.effectiveClaims].sort((a, b) =>
    factSlotKey(a.conceptKey, a.scopeKey, a.instanceKey).localeCompare(factSlotKey(b.conceptKey, b.scopeKey, b.instanceKey))
  )) {
    const selected = selectedSourceClaimFor(input, resolution);
    const concept = conceptByKey.get(resolution.conceptKey);
    const key = factSlotKey(resolution.conceptKey, resolution.scopeKey || "lease", resolution.instanceKey || "default");
    const p2Entry = concept ? p2BySlot.get(key) : null;
    if (p2Entry && p2Entry.outcome !== "unresolved" && resolution.status !== "requires_related_document") {
      rows.push(metadataEntry({ base: p2Entry, resolution, selected }));
    } else {
      rows.push(syntheticEntry(input, resolution));
    }
  }

  const order = new Map(CLAIM_CONCEPTS.map((concept, index) => [concept.projectionFieldKey ?? concept.conceptKey, index]));
  return rows.sort((a, b) => {
    const left = order.get(a.fieldKey) ?? Number.MAX_SAFE_INTEGER;
    const right = order.get(b.fieldKey) ?? Number.MAX_SAFE_INTEGER;
    return left - right || a.fieldKey.localeCompare(b.fieldKey) || a.instanceKey.localeCompare(b.instanceKey);
  });
}

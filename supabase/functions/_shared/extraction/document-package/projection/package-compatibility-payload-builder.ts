// @ts-nocheck
/**
 * P3.6 package-aware compatibility payload builder.
 *
 * Uses the P2 compatibility builder for the legacy fields/field_evidence
 * shape, then applies P3 status overlays for package conflict and missing
 * related-document rows.
 */

import { CLAIM_CONCEPTS } from "../../claims/concept-registry.ts";
import {
  buildCompatibilityExtractionDataSlice,
  type CompatibilityExtractionData,
} from "../../claims/adapters/compatibility-payload-builder.ts";
import type { PackageFieldProjectionEntry } from "./package-projection-types.ts";

function fieldGroupMap(): Map<string, string> {
  return new Map(CLAIM_CONCEPTS.map((concept) => [concept.conceptKey, concept.domain]));
}

function statusForPackageRow(row: PackageFieldProjectionEntry): string | null {
  if (row.packageStatus === "needs_review") return "conflict_detected";
  if (row.packageStatus === "requires_related_document") return "requires_related_document";
  if (row.outcome === "unreadable") return "unreadable";
  if (row.outcome === "extraction_failed") return "extraction_failed";
  return null;
}

export function buildPackageCompatibilityExtractionDataSlice(
  entries: PackageFieldProjectionEntry[],
): CompatibilityExtractionData {
  const slice = buildCompatibilityExtractionDataSlice(entries, fieldGroupMap());

  for (const row of entries) {
    const overrideStatus = statusForPackageRow(row);
    if (!overrideStatus) continue;
    const field = slice.fields[row.fieldKey];
    if (!field) continue;
    field.extraction_status = overrideStatus;
    slice.field_evidence[row.fieldKey] = { ...field };
  }

  return {
    fields: { ...slice.fields },
    field_evidence: { ...slice.field_evidence },
    confidence_scores: { ...slice.confidence_scores },
  };
}

export function buildPackageCompatibilityProjectionMetadata(entries: PackageFieldProjectionEntry[]) {
  return {
    projectedFieldCount: entries.filter((entry) => entry.outcome !== "unresolved").length,
    inheritedFieldCount: entries.filter((entry) => entry.packageStatus === "inherited").length,
    overriddenFieldCount: entries.filter((entry) =>
      entry.packageStatus === "overridden"
      || entry.packageStatus === "party_role_changed"
      || entry.packageStatus === "resolved_by_certificate"
      || entry.packageStatus === "addendum_override"
      || entry.packageStatus === "reviewer_resolved"
    ).length,
    needsReviewFieldCount: entries.filter((entry) => entry.packageStatus === "needs_review").length,
    requiresRelatedDocumentCount: entries.filter((entry) => entry.packageStatus === "requires_related_document").length,
    dynamicFieldCount: entries.filter((entry) => entry.conceptKey.startsWith("dynamic.")).length,
    conflictCount: entries.filter((entry) => entry.conflict).length,
  };
}

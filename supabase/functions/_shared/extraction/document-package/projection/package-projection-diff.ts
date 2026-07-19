// @ts-nocheck
/**
 * P3.6 package-aware diff.
 */

import { CLAIM_CONCEPTS } from "../../claims/concept-registry.ts";
import {
  diffCompatibilityFields,
  diffFieldOrdering,
  type FieldDiffResult,
} from "../../claims/adapters/compatibility-diff.ts";
import type { CompatibilityFieldEntry } from "../../claims/adapters/compatibility-payload-builder.ts";
import type {
  PackageFieldProjectionEntry,
  PackageProjectionDiffClassification,
  PackageProjectionDiffResult,
} from "./package-projection-types.ts";

function valueTypeByFieldKey(): Map<string, string> {
  return new Map(
    CLAIM_CONCEPTS
      .filter((concept) => concept.projectionFieldKey)
      .map((concept) => [concept.projectionFieldKey, concept.valueType]),
  );
}

function packageCategoryFor(row?: PackageFieldProjectionEntry | null): PackageProjectionDiffClassification | null {
  if (!row) return null;
  if (row.packageStatus === "needs_review") return "package_conflict";
  if (row.packageStatus === "requires_related_document") return "requires_related_document";
  if (row.packageStatus === "inherited") return "inherited_from_base";
  if (/assignment/i.test(row.precedenceRule)) return "assignment_party_change";
  if (/amendment|supersession/i.test(row.precedenceRule)) return "explicit_amendment_override";
  if (/extension|renewal/i.test(row.precedenceRule)) return "extension_or_renewal_change";
  if (/commencement/i.test(row.precedenceRule)) return "resolved_by_commencement_certificate";
  if (/guarant/i.test(row.precedenceRule)) return "guaranty_added";
  if (/rent_addendum/i.test(row.precedenceRule)) return "rent_addendum_override";
  if (/cam_addendum/i.test(row.precedenceRule)) return "cam_addendum_override";
  if (/work_letter/i.test(row.precedenceRule)) return "work_letter_override";
  return null;
}

function translateP2Classification(classification: FieldDiffResult["classification"]): PackageProjectionDiffClassification {
  switch (classification) {
    case "missing_in_claim_projection": return "missing_in_package_projection";
    case "extra_in_claim_projection": return "extra_in_package_projection";
    default: return classification;
  }
}

export function diffPackageCompatibilityFields(
  singleDocumentFields: Record<string, CompatibilityFieldEntry>,
  packageFields: Record<string, CompatibilityFieldEntry>,
  packageProjectionRows: PackageFieldProjectionEntry[],
): PackageProjectionDiffResult[] {
  const rowsByField = new Map(packageProjectionRows.map((row) => [row.fieldKey, row]));
  const baseDiffs = diffCompatibilityFields(singleDocumentFields, packageFields, {
    valueTypeByFieldKey: valueTypeByFieldKey(),
  });
  const results: PackageProjectionDiffResult[] = [];

  for (const diff of baseDiffs) {
    const row = rowsByField.get(diff.fieldKey);
    const expectedPackageCategory = packageCategoryFor(row);
    let classification = translateP2Classification(diff.classification);
    if (diff.classification !== "equal" && diff.classification !== "representation_only" && expectedPackageCategory) {
      classification = expectedPackageCategory;
    }
    if (
      (diff.classification === "equal" || diff.classification === "representation_only")
      && expectedPackageCategory === "inherited_from_base"
    ) {
      classification = "inherited_from_base";
    }
    results.push({
      fieldKey: diff.fieldKey,
      classification,
      legacyValue: diff.legacyValue,
      packageValue: diff.claimValue,
      packageStatus: row?.packageStatus,
      precedenceRule: row?.precedenceRule,
    });
  }

  if (diffFieldOrdering(singleDocumentFields, packageFields)) {
    results.push({ fieldKey: "__field_order__", classification: "ordering_mismatch" });
  }
  return results.sort((a, b) => a.fieldKey.localeCompare(b.fieldKey));
}

export function summarizePackageDiff(results: PackageProjectionDiffResult[]): Record<PackageProjectionDiffClassification, number> {
  const summary: Record<string, number> = {
    equal: 0,
    representation_only: 0,
    inherited_from_base: 0,
    explicit_amendment_override: 0,
    assignment_party_change: 0,
    extension_or_renewal_change: 0,
    resolved_by_commencement_certificate: 0,
    guaranty_added: 0,
    rent_addendum_override: 0,
    cam_addendum_override: 0,
    work_letter_override: 0,
    requires_related_document: 0,
    package_conflict: 0,
    missing_in_package_projection: 0,
    extra_in_package_projection: 0,
    value_mismatch: 0,
    evidence_mismatch: 0,
    status_mismatch: 0,
    confidence_mismatch: 0,
    ordering_mismatch: 0,
  };
  for (const result of results) summary[result.classification] += 1;
  return summary as Record<PackageProjectionDiffClassification, number>;
}

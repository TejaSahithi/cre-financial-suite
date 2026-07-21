// @ts-nocheck

import { getSchema } from "../schemas.ts";
import type { ModuleType } from "../types.ts";
import { compareFieldValues, CRITICAL_FIELD_KEYS, hasComparableValue } from "./projection-diff.ts";
import type { CanonicalReviewFieldDefinition } from "./canonical-review-field-registry.ts";
import type { CanonicalFieldProjectionReadModel } from "./canonical-projection-contract.ts";

export type CanonicalLegacyParityStatus =
  | "equal"
  | "equivalent_after_normalization"
  | "canonical_only"
  | "legacy_only"
  | "different_non_material"
  | "different_material"
  | "not_comparable"
  | "ambiguous";

export interface CanonicalLegacyFieldParity {
  canonicalFieldKey: string;
  reviewPath: string;
  canonicalValue: unknown;
  legacyValue: unknown;
  status: CanonicalLegacyParityStatus;
  material: boolean;
  normalizedCanonicalValue: unknown;
  normalizedLegacyValue: unknown;
  reasonCodes: string[];
}

export interface CanonicalAuthorityReadiness {
  ready: boolean;
  materialMismatchCount: number;
  approvalCriticalMismatchCount: number;
  canonicalMissingCount: number;
  unsupportedFieldCount: number;
  reasons: string[];
}

export interface CanonicalLegacyParitySummary {
  statusCounts: Record<CanonicalLegacyParityStatus, number>;
  readiness: CanonicalAuthorityReadiness;
  comparisons: CanonicalLegacyFieldParity[];
}

const ALL_STATUSES: CanonicalLegacyParityStatus[] = [
  "equal",
  "equivalent_after_normalization",
  "canonical_only",
  "legacy_only",
  "different_non_material",
  "different_material",
  "not_comparable",
  "ambiguous",
];

function normalizeForDisplay(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  return value;
}

function isMaterial(field: CanonicalReviewFieldDefinition, status: CanonicalLegacyParityStatus): boolean {
  if (["equal", "equivalent_after_normalization", "canonical_only"].includes(status)) return false;
  if (field.requiredForApproval || CRITICAL_FIELD_KEYS.includes(field.canonicalFieldKey)) return true;
  return field.requiredForComputation && ["legacy_only", "different_material", "ambiguous"].includes(status);
}

export function buildCanonicalLegacyParity(args: {
  registry: CanonicalReviewFieldDefinition[];
  projections: CanonicalFieldProjectionReadModel[];
  legacyPayload: unknown;
  legacyValueResolver: (field: CanonicalReviewFieldDefinition, legacyPayload: unknown) => unknown;
  moduleType?: ModuleType;
}): CanonicalLegacyParitySummary {
  const moduleType = args.moduleType ?? "lease";
  const schema = getSchema(moduleType);
  const projectionsByKey = new Map(args.projections.map((projection) => [projection.canonicalFieldKey, projection]));
  const comparisons: CanonicalLegacyFieldParity[] = args.registry.map((field) => {
    const projection = projectionsByKey.get(field.canonicalFieldKey) ?? null;
    const canonicalValue = projection?.normalizedValue ?? projection?.value ?? null;
    const legacyValue = args.legacyValueResolver(field, args.legacyPayload);
    const canonicalPresent = hasComparableValue(canonicalValue);
    const legacyPresent = hasComparableValue(legacyValue);
    const fieldDef = schema[field.canonicalFieldKey] ?? null;
    const reasonCodes: string[] = [];

    let status: CanonicalLegacyParityStatus;
    if (!projection && !legacyPresent) {
      status = "not_comparable";
      reasonCodes.push("no_canonical_projection_or_legacy_value");
    } else if (projection?.status === "conflict") {
      status = legacyPresent ? "different_material" : "not_comparable";
      reasonCodes.push("canonical_projection_conflict");
    } else if (!canonicalPresent && legacyPresent) {
      status = "legacy_only";
      reasonCodes.push("canonical_missing_legacy_populated");
    } else if (canonicalPresent && !legacyPresent) {
      status = "canonical_only";
      reasonCodes.push("canonical_populated_legacy_missing");
    } else {
      const comparison = compareFieldValues(legacyValue, canonicalValue, fieldDef, field.canonicalFieldKey);
      if (comparison.dateAmbiguous) {
        status = "ambiguous";
        reasonCodes.push("ambiguous_date_format");
      } else if (comparison.differenceType === "exact_match") {
        status = "equal";
      } else if (comparison.differenceType === "normalized_match") {
        status = "equivalent_after_normalization";
      } else {
        status = field.requiredForApproval || field.requiredForComputation ? "different_material" : "different_non_material";
        reasonCodes.push(comparison.differenceType);
      }
    }

    const material = isMaterial(field, status);
    return {
      canonicalFieldKey: field.canonicalFieldKey,
      reviewPath: field.reviewPath,
      canonicalValue,
      legacyValue,
      status,
      material,
      normalizedCanonicalValue: normalizeForDisplay(canonicalValue),
      normalizedLegacyValue: normalizeForDisplay(legacyValue),
      reasonCodes,
    };
  });

  const statusCounts = Object.fromEntries(ALL_STATUSES.map((status) => [status, comparisons.filter((c) => c.status === status).length])) as Record<CanonicalLegacyParityStatus, number>;
  const materialMismatchCount = comparisons.filter((c) => c.material).length;
  const approvalCriticalMismatchCount = comparisons.filter((c) => c.material && (CRITICAL_FIELD_KEYS.includes(c.canonicalFieldKey) || args.registry.find((f) => f.canonicalFieldKey === c.canonicalFieldKey)?.requiredForApproval)).length;
  const canonicalMissingCount = comparisons.filter((c) => c.status === "legacy_only").length;
  const unsupportedFieldCount = comparisons.filter((c) => c.status === "not_comparable").length;
  const reasons: string[] = [];
  if (materialMismatchCount > 0) reasons.push("material_mismatches_present");
  if (approvalCriticalMismatchCount > 0) reasons.push("approval_critical_mismatches_present");
  if (canonicalMissingCount > 0) reasons.push("canonical_missing_fields_present");
  if (unsupportedFieldCount > 0) reasons.push("unsupported_fields_present");

  return {
    statusCounts,
    readiness: {
      ready: materialMismatchCount === 0 && approvalCriticalMismatchCount === 0 && canonicalMissingCount === 0 && unsupportedFieldCount === 0,
      materialMismatchCount,
      approvalCriticalMismatchCount,
      canonicalMissingCount,
      unsupportedFieldCount,
      reasons,
    },
    comparisons,
  };
}
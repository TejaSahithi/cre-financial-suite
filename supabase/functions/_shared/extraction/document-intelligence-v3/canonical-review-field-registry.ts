// @ts-nocheck

import { getSchema } from "../schemas.ts";
import type { ModuleType } from "../types.ts";
import {
  CANONICAL_PROJECTION_STATUSES,
  type CanonicalProjectionStatus,
  isCanonicalProjectionStatus,
} from "./canonical-projection-contract.ts";

export type CanonicalReviewAuthority = "canonical" | "canonical_with_legacy_fallback" | "legacy" | "derived";
export type CanonicalFieldValueType = "string" | "number" | "currency" | "percentage" | "date" | "boolean" | "enum" | "object" | "array";

export interface CanonicalReviewFieldDefinition {
  canonicalFieldKey: string;
  reviewPath: string;
  legacyPaths: string[];
  domain: string;
  valueType: CanonicalFieldValueType;
  authority: CanonicalReviewAuthority;
  requiredForApproval: boolean;
  requiredForComputation: boolean;
  reviewerVisible: boolean;
  allowLegacyFallback: boolean;
  allowReviewerOverride: boolean;
  acceptedProjectionStatuses: CanonicalProjectionStatus[];
  blockingProjectionStatuses: CanonicalProjectionStatus[];
  normalizer?: string;
  formatter?: string;
  validator?: string;
  derivation?: string;
  schemaVersion: string;
}

export interface CanonicalProjectionCoverageInventory {
  canonicalFieldKey: string;
  legacyPath: string | null;
  canonicalProjectionExists: boolean;
  reviewerVisible: boolean;
  approvalRelevant: boolean;
  computeRelevant: boolean;
  migrationStatus: "ready" | "partial" | "missing_projection" | "missing_evidence" | "unsupported_shape" | "legacy_only";
}

export const CANONICAL_REVIEW_FIELD_REGISTRY_VERSION = "canonical-review-field-registry-v1";

const COMPUTE_RELEVANT_KEYS = new Set([
  "commencement_date",
  "expiration_date",
  "lease_term_months",
  "monthly_rent",
  "annual_rent",
  "rentable_square_feet",
  "admin_fee_pct",
  "renewal_notice_months",
  "option_exercise_deadline",
  "base_year",
  "cam_amount",
  "responsibility_taxes",
  "responsibility_insurance",
  "responsibility_utilities",
  "responsibility_repairs",
]);

function valueTypeFor(fieldKey: string, schemaType: string | undefined): CanonicalFieldValueType {
  if (schemaType === "date" || /_date$|deadline/.test(fieldKey)) return "date";
  if (schemaType === "boolean") return "boolean";
  if (schemaType === "enum") return "enum";
  if (schemaType === "number") {
    if (/rent|amount|cost|fee|deposit|payment|charge|expense|value|price/i.test(fieldKey) && !/_pct$|percent|percentage/i.test(fieldKey)) return "currency";
    if (/_pct$|percent|percentage/i.test(fieldKey)) return "percentage";
    return "number";
  }
  return "string";
}

function domainFor(fieldKey: string, def: any): string {
  if (def?.domain) return String(def.domain);
  if (/tenant|landlord|broker|guarantor/i.test(fieldKey)) return "parties";
  if (/date|term|renewal|expiration|commencement|deadline/i.test(fieldKey)) return "dates";
  if (/rent|deposit|fee|charge|amount/i.test(fieldKey)) return "rent";
  if (/cam|tax|insurance|utility|repair|maintenance|expense/i.test(fieldKey)) return "operating_expenses";
  if (/address|premises|property|square|suite|unit/i.test(fieldKey)) return "premises";
  return "lease";
}

function validatorFor(valueType: CanonicalFieldValueType): string {
  if (valueType === "date") return "date_present_or_null";
  if (valueType === "currency" || valueType === "number" || valueType === "percentage") return "numeric_present_or_null";
  if (valueType === "boolean") return "boolean_present_or_null";
  return "non_blank_present_or_null";
}

export function buildCanonicalReviewFieldRegistry(moduleType: ModuleType = "lease"): CanonicalReviewFieldDefinition[] {
  const schema = getSchema(moduleType);
  return Object.entries(schema)
    .filter(([, def]: [string, any]) => !def?.derived)
    .map(([fieldKey, def]: [string, any]) => {
      const valueType = valueTypeFor(fieldKey, def?.type);
      const requiredForApproval = Boolean(def?.required || def?.evidencePolicy === "enforced");
      const requiredForComputation = COMPUTE_RELEVANT_KEYS.has(fieldKey);
      return {
        canonicalFieldKey: fieldKey,
        reviewPath: `records[0].fields.${fieldKey}.value`,
        legacyPaths: [
          `records[0].fields.${fieldKey}.value`,
          `records[0].values.${fieldKey}`,
          `records[0].standard_fields[field_key=${fieldKey}].value`,
          `rows[0].fields.${fieldKey}.value`,
          `rows[0].values.${fieldKey}`,
        ],
        domain: domainFor(fieldKey, def),
        valueType,
        authority: "canonical_with_legacy_fallback",
        requiredForApproval,
        requiredForComputation,
        reviewerVisible: true,
        allowLegacyFallback: true,
        allowReviewerOverride: true,
        acceptedProjectionStatuses: ["resolved", "resolved_with_warning"],
        blockingProjectionStatuses: requiredForApproval ? ["conflict", "missing", "missing_source_evidence", "invalid"] : ["conflict", "invalid"],
        normalizer: valueType,
        formatter: valueType,
        validator: requiredForApproval ? validatorFor(valueType) : undefined,
        schemaVersion: CANONICAL_REVIEW_FIELD_REGISTRY_VERSION,
      };
    });
}

export const CANONICAL_REVIEW_FIELD_REGISTRY = buildCanonicalReviewFieldRegistry("lease");

export function validateCanonicalReviewFieldRegistry(registry: CanonicalReviewFieldDefinition[] = CANONICAL_REVIEW_FIELD_REGISTRY): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  const paths = new Set<string>();
  for (const field of registry) {
    if (!field.canonicalFieldKey) errors.push("canonicalFieldKey is required");
    if (keys.has(field.canonicalFieldKey)) errors.push(`Duplicate canonical key: ${field.canonicalFieldKey}`);
    keys.add(field.canonicalFieldKey);
    if (!field.reviewPath) errors.push(`reviewPath is required for ${field.canonicalFieldKey}`);
    if (paths.has(field.reviewPath)) errors.push(`Duplicate review path: ${field.reviewPath}`);
    paths.add(field.reviewPath);
    for (const status of [...field.acceptedProjectionStatuses, ...field.blockingProjectionStatuses]) {
      if (!isCanonicalProjectionStatus(status)) errors.push(`Invalid projection status ${status} for ${field.canonicalFieldKey}`);
    }
    if (field.requiredForApproval && !field.validator) errors.push(`Approval field ${field.canonicalFieldKey} requires a validator`);
    if (field.allowLegacyFallback && field.legacyPaths.length === 0) errors.push(`Fallback field ${field.canonicalFieldKey} requires a legacy path`);
    if (field.authority === "derived" && !field.derivation) errors.push(`Derived field ${field.canonicalFieldKey} requires a derivation definition`);
    if ((field.authority === "canonical" || field.authority === "canonical_with_legacy_fallback") && !field.acceptedProjectionStatuses.length) {
      errors.push(`Canonical field ${field.canonicalFieldKey} must define accepted projection statuses`);
    }
  }
  const validStatuses = new Set(CANONICAL_PROJECTION_STATUSES);
  if (validStatuses.size !== CANONICAL_PROJECTION_STATUSES.length) errors.push("Projection status vocabulary contains duplicates");
  return errors;
}

export function buildCoverageInventory(args: {
  registry?: CanonicalReviewFieldDefinition[];
  projectionKeys?: string[];
  evidenceByFieldKey?: Record<string, number>;
} = {}): CanonicalProjectionCoverageInventory[] {
  const registry = args.registry ?? CANONICAL_REVIEW_FIELD_REGISTRY;
  const projectionKeys = new Set(args.projectionKeys ?? []);
  const evidenceByFieldKey = args.evidenceByFieldKey ?? {};
  return registry.map((field) => {
    const projectionExists = projectionKeys.has(field.canonicalFieldKey);
    const evidenceCount = evidenceByFieldKey[field.canonicalFieldKey] ?? 0;
    let migrationStatus: CanonicalProjectionCoverageInventory["migrationStatus"] = "ready";
    if (field.authority === "legacy") migrationStatus = "legacy_only";
    else if (!projectionExists) migrationStatus = "missing_projection";
    else if (field.requiredForApproval && evidenceCount === 0) migrationStatus = "missing_evidence";
    else if (!field.reviewerVisible) migrationStatus = "partial";
    return {
      canonicalFieldKey: field.canonicalFieldKey,
      legacyPath: field.legacyPaths[0] ?? null,
      canonicalProjectionExists: projectionExists,
      reviewerVisible: field.reviewerVisible,
      approvalRelevant: field.requiredForApproval,
      computeRelevant: field.requiredForComputation,
      migrationStatus,
    };
  });
}
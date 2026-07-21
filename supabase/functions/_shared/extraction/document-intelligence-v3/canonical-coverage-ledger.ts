// @ts-nocheck

import type { CanonicalReviewAuthority, CanonicalReviewFieldDefinition } from "./canonical-review-field-registry.ts";
import type { CanonicalProjectionStatus, CanonicalFieldProjectionReadModel } from "./canonical-projection-contract.ts";

export type CanonicalCoverageStatus =
  | "resolved"
  | "resolved_with_warning"
  | "needs_review"
  | "conflict"
  | "not_found"
  | "missing"
  | "missing_source_evidence"
  | "invalid"
  | "legacy_fallback"
  | "not_applicable"
  | "unconfigured";

export interface CanonicalCoverageLedgerEntry {
  canonicalFieldKey: string;
  reviewPath: string;
  domain: string;
  authority: CanonicalReviewAuthority;
  requiredForApproval: boolean;
  requiredForComputation: boolean;
  projectionStatus: CanonicalProjectionStatus | null;
  coverageStatus: CanonicalCoverageStatus;
  canonicalValuePresent: boolean;
  evidencePresent: boolean;
  derivationPresent: boolean;
  conflictPresent: boolean;
  legacyValuePresent: boolean;
  legacyFallbackUsed: boolean;
  blocking: boolean;
  blockingReasons: string[];
  warningReasons: string[];
  sourceClaimCount: number;
  evidenceCount: number;
  projectionId: string | null;
}

export interface CanonicalCoverageLedger {
  version: string;
  totals: {
    configured: number;
    resolved: number;
    needsReview: number;
    conflicts: number;
    missing: number;
    missingSourceEvidence: number;
    invalid: number;
    legacyFallbacks: number;
    blocking: number;
  };
  approvalReady: boolean;
  computationReady: boolean;
  entries: CanonicalCoverageLedgerEntry[];
}

export const CANONICAL_COVERAGE_LEDGER_VERSION = "canonical-coverage-ledger-v1";

function hasValue(value: unknown): boolean {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

function evaluateCoverageStatus(args: {
  field: CanonicalReviewFieldDefinition;
  projection: CanonicalFieldProjectionReadModel | null;
  canonicalValuePresent: boolean;
  evidencePresent: boolean;
  legacyValuePresent: boolean;
  strict: boolean;
}): CanonicalCoverageStatus {
  const { field, projection, canonicalValuePresent, evidencePresent, legacyValuePresent, strict } = args;
  if (field.authority === "legacy") return legacyValuePresent ? "legacy_fallback" : "missing";
  if (field.authority === "derived" && !projection) return "not_applicable";
  if (!projection) {
    return field.allowLegacyFallback && legacyValuePresent && !strict ? "legacy_fallback" : "missing";
  }
  if (projection.status === "suppressed") return "not_applicable";
  if (projection.status === "conflict") return "conflict";
  if (projection.status === "invalid") return "invalid";
  if (projection.status === "not_found") return "not_found";
  if (projection.status === "missing") {
    return field.allowLegacyFallback && legacyValuePresent && !strict ? "legacy_fallback" : "missing";
  }
  if (projection.status === "needs_review") return "needs_review";
  if (projection.status === "missing_source_evidence") return "missing_source_evidence";
  if ((projection.status === "resolved" || projection.status === "resolved_with_warning") && !evidencePresent && field.requiredForApproval) {
    return "missing_source_evidence";
  }
  if (projection.status === "resolved" && !canonicalValuePresent) return "missing";
  return projection.status;
}

function blockingReasonsFor(field: CanonicalReviewFieldDefinition, status: CanonicalCoverageStatus, strict: boolean): string[] {
  const reasons: string[] = [];
  if (!field.requiredForApproval && !field.requiredForComputation) return reasons;
  if (["conflict", "missing", "missing_source_evidence", "invalid"].includes(status)) reasons.push(status);
  if (strict && status === "legacy_fallback") reasons.push("strict_mode_disallows_legacy_fallback");
  return reasons;
}

export function buildCanonicalCoverageLedger(args: {
  registry: CanonicalReviewFieldDefinition[];
  projections: CanonicalFieldProjectionReadModel[];
  legacyPayload?: unknown;
  legacyValueResolver?: (field: CanonicalReviewFieldDefinition, legacyPayload: unknown) => unknown;
  strict?: boolean;
}): CanonicalCoverageLedger {
  const projectionsByKey = new Map(args.projections.map((projection) => [projection.canonicalFieldKey, projection]));
  const strict = args.strict === true;
  const entries = args.registry.map((field) => {
    const projection = projectionsByKey.get(field.canonicalFieldKey) ?? null;
    const legacyValue = args.legacyValueResolver ? args.legacyValueResolver(field, args.legacyPayload) : null;
    const canonicalValuePresent = hasValue(projection?.normalizedValue ?? projection?.value ?? null);
    const legacyValuePresent = hasValue(legacyValue);
    const sourceClaimCount = projection?.sourceClaimIds?.length ?? 0;
    const evidenceCount = projection?.evidenceIds?.length ?? 0;
    const evidencePresent = evidenceCount > 0 || sourceClaimCount > 0;
    const coverageStatus = evaluateCoverageStatus({ field, projection, canonicalValuePresent, evidencePresent, legacyValuePresent, strict });
    const blockingReasons = blockingReasonsFor(field, coverageStatus, strict);
    const warningReasons: string[] = [];
    if (coverageStatus === "legacy_fallback") warningReasons.push("legacy_fallback_used");
    if (coverageStatus === "resolved_with_warning") warningReasons.push("projection_resolved_with_warning");
    if (projection?.confidence != null && projection.confidence < 0.75) warningReasons.push("low_confidence_projection");
    return {
      canonicalFieldKey: field.canonicalFieldKey,
      reviewPath: field.reviewPath,
      domain: field.domain,
      authority: field.authority,
      requiredForApproval: field.requiredForApproval,
      requiredForComputation: field.requiredForComputation,
      projectionStatus: projection?.status ?? null,
      coverageStatus,
      canonicalValuePresent,
      evidencePresent,
      derivationPresent: projection?.derivation != null,
      conflictPresent: projection?.conflict != null || projection?.status === "conflict",
      legacyValuePresent,
      legacyFallbackUsed: coverageStatus === "legacy_fallback",
      blocking: blockingReasons.length > 0,
      blockingReasons,
      warningReasons,
      sourceClaimCount,
      evidenceCount,
      projectionId: projection?.projectionId ?? null,
    };
  });

  const totals = {
    configured: entries.length,
    resolved: entries.filter((entry) => entry.coverageStatus === "resolved" || entry.coverageStatus === "resolved_with_warning").length,
    needsReview: entries.filter((entry) => entry.coverageStatus === "needs_review").length,
    conflicts: entries.filter((entry) => entry.coverageStatus === "conflict").length,
    missing: entries.filter((entry) => entry.coverageStatus === "missing" || entry.coverageStatus === "not_found").length,
    missingSourceEvidence: entries.filter((entry) => entry.coverageStatus === "missing_source_evidence").length,
    invalid: entries.filter((entry) => entry.coverageStatus === "invalid").length,
    legacyFallbacks: entries.filter((entry) => entry.legacyFallbackUsed).length,
    blocking: entries.filter((entry) => entry.blocking).length,
  };

  return {
    version: CANONICAL_COVERAGE_LEDGER_VERSION,
    totals,
    approvalReady: entries.filter((entry) => entry.requiredForApproval).every((entry) => !entry.blocking),
    computationReady: entries.filter((entry) => entry.requiredForComputation).every((entry) => !entry.blocking),
    entries,
  };
}
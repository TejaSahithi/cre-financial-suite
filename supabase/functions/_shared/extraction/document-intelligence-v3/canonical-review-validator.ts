// @ts-nocheck

import type { CanonicalReviewFieldDefinition } from "./canonical-review-field-registry.ts";
import type { EnterpriseReviewPayload } from "./enterprise-review-payload.ts";

export interface CanonicalReviewValidationIssue {
  code: string;
  severity: "warning" | "blocking";
  canonicalFieldKey: string | null;
  message: string;
}

export interface CanonicalReviewValidationInput {
  payload: EnterpriseReviewPayload;
  fieldRegistry: CanonicalReviewFieldDefinition[];
  parseQuality: any | null;
  evidenceFindings: any[];
}

export interface CanonicalReviewValidationResult {
  valid: boolean;
  approvalEligible: boolean;
  blockingIssues: CanonicalReviewValidationIssue[];
  warnings: CanonicalReviewValidationIssue[];
  coverageReady: boolean;
  evidenceReady: boolean;
  parseQualityReady: boolean;
  conflictsResolved: boolean;
}

export function validateCanonicalReviewPayload(input: CanonicalReviewValidationInput): CanonicalReviewValidationResult {
  const blockingIssues: CanonicalReviewValidationIssue[] = [];
  const warnings: CanonicalReviewValidationIssue[] = [];
  const registryKeys = new Set(input.fieldRegistry.map((field) => field.canonicalFieldKey));

  for (const field of input.fieldRegistry) {
    const payloadField = input.payload.fields[field.canonicalFieldKey];
    if (!payloadField) {
      blockingIssues.push({ code: "configured_field_missing_from_payload", severity: "blocking", canonicalFieldKey: field.canonicalFieldKey, message: `${field.canonicalFieldKey} is configured but missing from the enterprise payload.` });
      continue;
    }
    if (payloadField.review.blocking) {
      blockingIssues.push({ code: "field_blocking", severity: "blocking", canonicalFieldKey: field.canonicalFieldKey, message: `${field.canonicalFieldKey} blocks review: ${payloadField.review.reasonCodes.join(", ")}` });
    }
    if (payloadField.authoritativeSource === "legacy_fallback" && input.payload.sourceMode === "canonical_strict") {
      blockingIssues.push({ code: "strict_legacy_fallback", severity: "blocking", canonicalFieldKey: field.canonicalFieldKey, message: `${field.canonicalFieldKey} used legacy fallback in strict mode.` });
    }
  }

  for (const key of Object.keys(input.payload.fields)) {
    if (!registryKeys.has(key)) warnings.push({ code: "unconfigured_payload_field", severity: "warning", canonicalFieldKey: key, message: `${key} is present in payload but absent from registry.` });
  }

  for (const finding of input.evidenceFindings ?? []) {
    const issue = { code: finding?.code ?? "evidence_integrity_warning", severity: "warning" as const, canonicalFieldKey: finding?.fieldKey ?? null, message: finding?.message ?? finding?.code ?? "Evidence integrity warning." };
    warnings.push(issue);
  }

  const pageQuality = Array.isArray(input.parseQuality?.pageQuality) ? input.parseQuality.pageQuality : Array.isArray(input.parseQuality) ? input.parseQuality : [];
  for (const page of pageQuality) {
    if (["unreadable", "possibly_missing"].includes(page?.status)) {
      warnings.push({ code: "parse_quality_warning", severity: "warning", canonicalFieldKey: null, message: `Page ${page?.pageNumber ?? "unknown"} status is ${page.status}.` });
    }
  }

  const coverageReady = input.payload.coverage.approvalReady;
  const evidenceReady = input.payload.coverage.entries.every((entry) => entry.coverageStatus !== "missing_source_evidence" || !entry.requiredForApproval);
  const parseQualityReady = !warnings.some((warning) => warning.code === "parse_quality_warning" && input.payload.sourceMode === "canonical_strict");
  const conflictsResolved = input.payload.unresolvedConflicts.length === 0;

  return {
    valid: blockingIssues.length === 0,
    approvalEligible: input.payload.sourceMode === "legacy" ? true : blockingIssues.length === 0 && coverageReady && evidenceReady && conflictsResolved,
    blockingIssues,
    warnings,
    coverageReady,
    evidenceReady,
    parseQualityReady,
    conflictsResolved,
  };
}
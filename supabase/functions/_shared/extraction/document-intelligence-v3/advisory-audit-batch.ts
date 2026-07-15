// @ts-nocheck
/**
 * Document Intelligence v3 - Batch Advisory Audit Report (Phase 15)
 *
 * Diagnostic-only aggregation over Phase 14 advisory audits. This module is
 * pure: it does not fetch, write, call approval RPCs, or make the v3 advisory
 * a gate. Edge functions and local utilities own input resolution.
 */

const AGREEMENT_LEVELS = [
  "agrees",
  "mostly_agrees",
  "differs_v3_stricter",
  "differs_v3_more_permissive",
  "not_comparable",
  "insufficient_data",
];

const DISCREPANCY_TYPES = [
  "current_path_may_be_too_permissive",
  "current_path_may_be_too_strict",
  "profile_policy_mismatch",
  "assignment_false_full_lease_blocker",
  "evidence_requirement_mismatch",
  "related_document_policy_mismatch",
  "temporal_policy_mismatch",
  "coverage_mismatch",
];

const RISK_TYPES = [
  "likely_false_positive_current_approval",
  "likely_false_negative_current_block",
  "high_priority_review_needed",
  "not_enough_data",
];

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function emptyCounts(keys: string[]) {
  return Object.fromEntries(keys.map((key) => [key, 0]));
}

function increment(counts: Record<string, number>, key: string | null | undefined) {
  const resolved = key && Object.prototype.hasOwnProperty.call(counts, key) ? key : String(key || "unknown");
  counts[resolved] = (counts[resolved] ?? 0) + 1;
}

function uniqueStrings(values: any[]) {
  return [...new Set(values.filter((value) => value != null && String(value).trim()).map(String))];
}

function profileKeyForAudit(audit: any) {
  return audit?.v3_advisory?.profile_key
    ?? audit?.v3_advisory?.policy_key
    ?? audit?.current_review_snapshot?.profile_key
    ?? null;
}

function resultFromAudit(audit: any) {
  const comparison = audit?.comparison ?? {};
  const discrepancies = asArray(audit?.discrepancies);
  return {
    uploaded_file_id: audit?.uploaded_file_id ?? audit?.current_review_snapshot?.uploaded_file_id ?? null,
    run_id: audit?.run_id ?? audit?.v3_advisory?.run_id ?? null,
    lease_id: audit?.lease_id ?? audit?.current_review_snapshot?.lease_id ?? null,
    profile_key: profileKeyForAudit(audit),
    v3_advisory_status: comparison.v3_status ?? audit?.v3_advisory?.advisory_status ?? "advisory_not_available",
    current_status: comparison.current_status ?? audit?.current_review_snapshot?.current_status ?? "insufficient_data",
    agreement_level: comparison.agreement_level ?? "insufficient_data",
    discrepancy_count: discrepancies.length,
    discrepancies,
    false_positive_risks: asArray(comparison.false_positive_risks),
    false_negative_risks: asArray(comparison.false_negative_risks),
    recommendations: asArray(audit?.recommendations),
  };
}

function accumulateRiskSummary(summary: Record<string, number>, result: any) {
  const discrepancyTypes = new Set(asArray(result.discrepancies).map((item) => item?.type));
  const hasCurrentAllowsRisk = result.agreement_level === "differs_v3_stricter"
    || discrepancyTypes.has("current_path_may_be_too_permissive")
    || discrepancyTypes.has("evidence_requirement_mismatch")
    || discrepancyTypes.has("temporal_policy_mismatch")
    || discrepancyTypes.has("coverage_mismatch");
  const hasCurrentBlocksRisk = result.agreement_level === "differs_v3_more_permissive"
    || discrepancyTypes.has("current_path_may_be_too_strict")
    || discrepancyTypes.has("assignment_false_full_lease_blocker");
  const highPriority = asArray(result.discrepancies).some((item) => item?.severity === "high")
    || hasCurrentAllowsRisk;
  const notEnoughData = ["insufficient_data", "not_comparable"].includes(result.agreement_level)
    || result.v3_advisory_status === "advisory_not_available"
    || result.current_status === "insufficient_data";

  if (hasCurrentAllowsRisk) summary.likely_false_positive_current_approval += 1;
  if (hasCurrentBlocksRisk) summary.likely_false_negative_current_block += 1;
  if (highPriority) summary.high_priority_review_needed += 1;
  if (notEnoughData) summary.not_enough_data += 1;
}

export function normalizeBatchAdvisoryAuditInput(input: any = {}) {
  return {
    uploaded_file_ids: uniqueStrings(asArray(input.uploaded_file_ids)),
    run_ids: uniqueStrings(asArray(input.run_ids)),
    lease_ids: uniqueStrings(asArray(input.lease_ids)),
    limit: Number.isFinite(Number(input.limit)) ? Math.max(0, Math.floor(Number(input.limit))) : null,
  };
}

export function buildBatchAdvisoryAuditReport({
  audits = [],
  input = {},
  generatedAt = null,
}: {
  audits?: any[];
  input?: any;
  generatedAt?: string | null;
} = {}) {
  const normalizedInput = normalizeBatchAdvisoryAuditInput(input);
  const limit = normalizedInput.limit ?? asArray(audits).length;
  const results = asArray(audits).slice(0, limit).map(resultFromAudit);
  const agreementCounts = emptyCounts(AGREEMENT_LEVELS);
  const discrepancyCounts = emptyCounts(DISCREPANCY_TYPES);
  const advisoryStatusCounts: Record<string, number> = {};
  const currentStatusCounts: Record<string, number> = {};
  const riskSummary = emptyCounts(RISK_TYPES);

  for (const result of results) {
    increment(agreementCounts, result.agreement_level);
    increment(advisoryStatusCounts, result.v3_advisory_status);
    increment(currentStatusCounts, result.current_status);
    for (const discrepancy of result.discrepancies) {
      increment(discrepancyCounts, discrepancy?.type);
    }
    accumulateRiskSummary(riskSummary, result);
  }

  return {
    diagnostic_only: true,
    total: results.length,
    generated_at: generatedAt ?? new Date().toISOString(),
    agreement_counts: agreementCounts,
    discrepancy_counts: discrepancyCounts,
    advisory_status_counts: advisoryStatusCounts,
    current_status_counts: currentStatusCounts,
    risk_summary: riskSummary,
    input: normalizedInput,
    results,
  };
}

export function buildEmptyBatchAdvisoryAuditReport(input: any = {}) {
  return buildBatchAdvisoryAuditReport({ audits: [], input });
}

export const BATCH_ADVISORY_AUDIT_AGREEMENT_LEVELS = AGREEMENT_LEVELS;
export const BATCH_ADVISORY_AUDIT_DISCREPANCY_TYPES = DISCREPANCY_TYPES;
export const BATCH_ADVISORY_AUDIT_RISK_TYPES = RISK_TYPES;
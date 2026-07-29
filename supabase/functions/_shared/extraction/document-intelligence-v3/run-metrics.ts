// @ts-nocheck
/**
 * Document Intelligence v3 — Run Operational Metrics (Release 2, Workstream D)
 *
 * Diagnostic-only, like every other module in this directory. Reuses
 * readiness.ts's already-computed claim_counts/evidence_counts/
 * validation_drop_counts/source_backed_counts rather than re-querying them
 * -- this module's job is to add the pieces readiness.ts doesn't compute:
 * stage timing, page/layout counts, legacy-vs-canonical field population,
 * and the provider-aware "which tables should have rows" matrix (review
 * correction 7).
 *
 * readiness/importance are recomputed fresh on every call (both
 * document_intelligence_runs.readiness and document_claims.importance are
 * dead columns -- see the Release 2 plan's finding #5) -- every value this
 * module returns for them is tagged with an explicit *_source/*_version
 * pair so no consumer mistakes a live recomputation for a persisted
 * historical snapshot (review correction 5).
 */

import { LEASE_SCHEMA_VERSION } from "../schemas.ts";
import { CANDIDATE_DECISION_VERSION } from "../candidate-decision.ts";
import { isDocumentIntelligenceV3Enabled } from "./feature-flag.ts";
import { isExtractionProvenanceEnabled } from "../provenance/feature-flag.ts";

export type BusinessExtractionProvider = "legacy_hybrid" | "openai_fact_ledger" | "openai_primary_legacy_fallback" | string;

export type ExpectedRowRule = "required" | "expected" | "expected_when_claims_exist" | "may_be_zero" | "optional";

/**
 * Review correction 7: table-write expectations are NOT one universal rule
 * -- a healthy legacy_hybrid run legitimately has zero claims/evidence/
 * projections (see the Two Test Modes section of the Release 2 plan). This
 * matrix is what lets the UI health panel say "expected" instead of
 * "broken" for that case.
 */
export const TABLE_EXPECTATIONS: Record<string, { legacy_hybrid: ExpectedRowRule; openai_fact_ledger: ExpectedRowRule }> = {
  document_intelligence_runs: { legacy_hybrid: "required", openai_fact_ledger: "required" },
  document_claims: { legacy_hybrid: "may_be_zero", openai_fact_ledger: "expected" },
  document_claim_evidence: { legacy_hybrid: "may_be_zero", openai_fact_ledger: "expected_when_claims_exist" },
  document_validation_drops: { legacy_hybrid: "optional", openai_fact_ledger: "optional" },
  document_canonical_field_projections: { legacy_hybrid: "may_be_zero", openai_fact_ledger: "expected" },
  extraction_runs: { legacy_hybrid: "required", openai_fact_ledger: "required" }, // only when ENABLE_EXTRACTION_PROVENANCE is on
  extraction_stage_runs: { legacy_hybrid: "required", openai_fact_ledger: "required" }, // same
};

function normalizeProviderKey(provider: BusinessExtractionProvider): "legacy_hybrid" | "openai_fact_ledger" {
  // openai_primary_legacy_fallback and any future provider alias are
  // evaluated against the fact-ledger expectation -- it's the mode that
  // ATTEMPTS fact-ledger extraction, which is the thing these expectations
  // are actually gating on.
  return provider === "legacy_hybrid" ? "legacy_hybrid" : "openai_fact_ledger";
}

export function evaluateTableExpectations(
  provider: BusinessExtractionProvider,
  actualCounts: Record<string, number>,
  provenanceEnabled: boolean,
): Array<{ table: string; rule: ExpectedRowRule; actualCount: number; unexpected: boolean }> {
  const providerKey = normalizeProviderKey(provider);
  return Object.entries(TABLE_EXPECTATIONS).map(([table, rules]) => {
    const rule = rules[providerKey];
    const actualCount = actualCounts[table] ?? 0;
    const isProvenanceTable = table === "extraction_runs" || table === "extraction_stage_runs";
    const effectiveRule: ExpectedRowRule = isProvenanceTable && !provenanceEnabled ? "may_be_zero" : rule;
    const unexpected = (effectiveRule === "required" || effectiveRule === "expected") && actualCount === 0;
    return { table, rule: effectiveRule, actualCount, unexpected };
  });
}

export function buildDiagnosticsContext(args: {
  run: Record<string, unknown> | null;
  businessExtractionProvider: BusinessExtractionProvider;
}) {
  const { run, businessExtractionProvider } = args;
  return {
    pipeline_version: run?.contract_version ?? null,
    schema_version: LEASE_SCHEMA_VERSION,
    candidate_decision_version: CANDIDATE_DECISION_VERSION,
    business_extraction_provider: businessExtractionProvider,
    feature_flags: {
      document_intelligence_v3: isDocumentIntelligenceV3Enabled(),
      extraction_provenance: isExtractionProvenanceEnabled(),
    },
    canonical_layout_fidelity: (run?.layout_summary as any)?.fidelity ?? "unknown",
    // Honest gaps, not fabricated precision (review correction 6) --
    // provider_invocations is empty today (see transport-readiness.ts), so
    // there is no per-run record of which model actually served a given
    // call. Reporting the currently-configured env var would misleadingly
    // imply it reflects this specific historical run.
    openai_model: "not_recorded_per_run — provider_invocations is empty; no per-run model record exists today",
    azure_model: "not_recorded_per_run — same limitation",
    prompt_version: "not_tracked — no prompt-versioning constant exists in llm-extractor.ts/fact-ledger-extractor.ts today",
  };
}

export function buildRunOperationalMetrics(args: {
  run: Record<string, unknown> | null;
  claims: Array<Record<string, unknown>>;
  evidence: Array<Record<string, unknown>>;
  validationDrops: Array<Record<string, unknown>>;
  projections: Array<Record<string, unknown>>;
  stageRuns: Array<Record<string, unknown>>;
  legacyFieldCount: number;
  readiness: Record<string, unknown> | null;
}) {
  const { run, claims, evidence, validationDrops, projections, stageRuns, legacyFieldCount, readiness } = args;

  const layoutSummary = (run?.layout_summary ?? {}) as Record<string, unknown>;
  const stageDurations = stageRuns
    .filter((s) => s.started_at && s.finished_at)
    .map((s) => ({
      stage: s.stage,
      attempt: s.attempt,
      status: s.status,
      duration_ms: new Date(s.finished_at as string).getTime() - new Date(s.started_at as string).getTime(),
    }));
  const stageFailures = stageRuns
    .filter((s) => s.status === "failed")
    .map((s) => ({ stage: s.stage, attempt: s.attempt, error_code: s.error_code, error_message: s.error_message }));

  const canonicalFieldsPopulated = projections.filter((p) => p.value !== null && p.value !== undefined).length;

  return {
    pages_received: layoutSummary.page_count ?? null,
    pages_parsed: layoutSummary.pages_with_content ?? layoutSummary.page_count ?? null,
    canonical_blocks: layoutSummary.block_count ?? null,
    canonical_tables: layoutSummary.table_count ?? null,
    claims_extracted: claims.length,
    claims_with_evidence: new Set(evidence.map((e) => e.claim_id)).size,
    claims_rejected: validationDrops.length,
    canonical_projections_created: projections.length,
    legacy_fields_populated: legacyFieldCount,
    canonical_fields_populated: canonicalFieldsPopulated,
    stage_durations: stageDurations,
    stage_failures: stageFailures,
    // See this file's header comment -- both columns are dead/never
    // persisted; these are live recomputations, tagged as such.
    readiness_source: "computed",
    readiness_version: (run?.contract_version as string) ?? "unknown",
    readiness: readiness ?? null,
    importance_source: "computed",
    importance_version: (run?.contract_version as string) ?? "unknown",
  };
}

export interface RunMetricsSnapshot {
  fieldCount: number;
  pipelineCompleted: boolean;
  claimsWithEvidenceRate: number | null;
}

/**
 * Corpus-level rollup across multiple single-run metrics snapshots. Kept
 * intentionally simple: no persistence and no new table.
 */
export function aggregateRunMetrics(runs: Array<{
  pipelineCompleted: boolean;
  claimsExtracted: number;
  claimsWithEvidence: number;
  validationDropsCount: number;
  stageDurationsMs: number[];
  comparisonStatus: "available" | "unavailable_no_fact_ledger" | "unavailable_no_projections";
  normalizedMatchRate: number | null;
  criticalFieldAgreementRate: number | null;
}>) {
  const total = runs.length;
  const completed = runs.filter((r) => r.pipelineCompleted).length;
  const totalClaims = runs.reduce((sum, r) => sum + r.claimsExtracted, 0);
  const totalClaimsWithEvidence = runs.reduce((sum, r) => sum + r.claimsWithEvidence, 0);
  const totalValidationDrops = runs.reduce((sum, r) => sum + r.validationDropsCount, 0);
  const allDurations = runs.flatMap((r) => r.stageDurationsMs).sort((a, b) => a - b);

  const percentile = (arr: number[], p: number): number | null => {
    if (arr.length === 0) return null;
    const idx = Math.min(arr.length - 1, Math.floor((p / 100) * arr.length));
    return arr[idx];
  };

  const comparableRuns = runs.filter((r) => r.comparisonStatus === "available");
  const avgOf = (values: Array<number | null>): number | null => {
    const nums = values.filter((v): v is number => v !== null);
    if (nums.length === 0) return null;
    return nums.reduce((a, b) => a + b, 0) / nums.length;
  };

  return {
    total_runs: total,
    pipeline_completion_rate: total > 0 ? completed / total : null,
    evidence_attachment_rate: totalClaims > 0 ? totalClaimsWithEvidence / totalClaims : null,
    validation_drop_rate: totalClaims > 0 ? totalValidationDrops / totalClaims : null,
    p50_stage_duration_ms: percentile(allDurations, 50),
    p95_stage_duration_ms: percentile(allDurations, 95),
    comparable_runs: comparableRuns.length,
    legacy_canonical_agreement_rate: avgOf(comparableRuns.map((r) => r.normalizedMatchRate)),
    critical_field_agreement_rate: avgOf(comparableRuns.map((r) => r.criticalFieldAgreementRate)),
  };
}

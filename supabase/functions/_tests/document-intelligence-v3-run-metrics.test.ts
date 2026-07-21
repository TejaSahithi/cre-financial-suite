// @ts-nocheck
// Release 2, Workstream D — unit tests for the operational-metrics module.
// Pure logic, no DB.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  evaluateTableExpectations,
  buildDiagnosticsContext,
  aggregateRunMetrics,
} from "../_shared/extraction/document-intelligence-v3/run-metrics.ts";

// ── evaluateTableExpectations() (review correction 7) ────────────────────

Deno.test("evaluateTableExpectations: legacy_hybrid with zero claims is NOT flagged unexpected (a healthy run, not a broken one)", () => {
  const results = evaluateTableExpectations(
    "legacy_hybrid",
    { document_intelligence_runs: 1, document_claims: 0, document_claim_evidence: 0, document_canonical_field_projections: 0 },
    true,
  );
  const claims = results.find((r) => r.table === "document_claims");
  assertEquals(claims.rule, "may_be_zero");
  assertEquals(claims.unexpected, false);
});

Deno.test("evaluateTableExpectations: openai_fact_ledger with zero claims IS flagged unexpected (a real gap)", () => {
  const results = evaluateTableExpectations(
    "openai_fact_ledger",
    { document_intelligence_runs: 1, document_claims: 0, document_claim_evidence: 0, document_canonical_field_projections: 0 },
    true,
  );
  const claims = results.find((r) => r.table === "document_claims");
  assertEquals(claims.rule, "expected");
  assertEquals(claims.unexpected, true);
});

Deno.test("evaluateTableExpectations: document_intelligence_runs missing is always unexpected, both providers", () => {
  for (const provider of ["legacy_hybrid", "openai_fact_ledger"]) {
    const results = evaluateTableExpectations(provider, { document_intelligence_runs: 0 }, true);
    const runs = results.find((r) => r.table === "document_intelligence_runs");
    assertEquals(runs.unexpected, true, `provider=${provider}`);
  }
});

Deno.test("evaluateTableExpectations: extraction_runs/extraction_stage_runs downgrade to may_be_zero when the provenance flag is off", () => {
  const results = evaluateTableExpectations("legacy_hybrid", { extraction_runs: 0, extraction_stage_runs: 0 }, false);
  const runs = results.find((r) => r.table === "extraction_runs");
  assertEquals(runs.rule, "may_be_zero");
  assertEquals(runs.unexpected, false);
});

Deno.test("evaluateTableExpectations: extraction_runs missing IS unexpected when the provenance flag is on", () => {
  const results = evaluateTableExpectations("legacy_hybrid", { extraction_runs: 0 }, true);
  const runs = results.find((r) => r.table === "extraction_runs");
  assertEquals(runs.rule, "required");
  assertEquals(runs.unexpected, true);
});

Deno.test("evaluateTableExpectations: document_validation_drops is always optional, never flagged unexpected regardless of count", () => {
  const results = evaluateTableExpectations("openai_fact_ledger", { document_validation_drops: 0 }, true);
  const drops = results.find((r) => r.table === "document_validation_drops");
  assertEquals(drops.rule, "optional");
  assertEquals(drops.unexpected, false);
});

// ── buildDiagnosticsContext() (review correction 6) ───────────────────────

Deno.test("buildDiagnosticsContext: reports honest gaps for openai_model/prompt_version rather than fabricating precision", () => {
  const ctx = buildDiagnosticsContext({ run: { contract_version: "document_intelligence_v3.phase1" }, businessExtractionProvider: "legacy_hybrid" });
  assertEquals(ctx.pipeline_version, "document_intelligence_v3.phase1");
  assertEquals(ctx.business_extraction_provider, "legacy_hybrid");
  assert(ctx.openai_model.includes("not_recorded_per_run"));
  assert(ctx.prompt_version.includes("not_tracked"));
  assertEquals(typeof ctx.feature_flags.document_intelligence_v3, "boolean");
  assertEquals(typeof ctx.feature_flags.extraction_provenance, "boolean");
});

Deno.test("buildDiagnosticsContext: canonical_layout_fidelity falls back to 'unknown' when layout_summary is absent", () => {
  const ctx = buildDiagnosticsContext({ run: null, businessExtractionProvider: "openai_fact_ledger" });
  assertEquals(ctx.canonical_layout_fidelity, "unknown");
});

// ── aggregateRunMetrics(): corpus-level rollup ────────────────────────────

Deno.test("aggregateRunMetrics: pipeline completion and evidence-attachment rates computed correctly across a small corpus", () => {
  const summary = aggregateRunMetrics([
    { pipelineCompleted: true, claimsExtracted: 10, claimsWithEvidence: 9, validationDropsCount: 1, stageDurationsMs: [100, 200], comparisonStatus: "available", normalizedMatchRate: 0.9, criticalFieldAgreementRate: 1.0 },
    { pipelineCompleted: true, claimsExtracted: 5, claimsWithEvidence: 5, validationDropsCount: 0, stageDurationsMs: [150], comparisonStatus: "unavailable_no_fact_ledger", normalizedMatchRate: null, criticalFieldAgreementRate: null },
    { pipelineCompleted: false, claimsExtracted: 0, claimsWithEvidence: 0, validationDropsCount: 0, stageDurationsMs: [], comparisonStatus: "unavailable_no_fact_ledger", normalizedMatchRate: null, criticalFieldAgreementRate: null },
  ]);
  assertEquals(summary.total_runs, 3);
  assertEquals(summary.pipeline_completion_rate, 2 / 3);
  assertEquals(summary.evidence_attachment_rate, 14 / 15);
  // Only the one "available" run contributes to agreement rates -- the
  // other two (Mode A, nothing to compare) must not drag it toward 0.
  assertEquals(summary.comparable_runs, 1);
  assertEquals(summary.legacy_canonical_agreement_rate, 0.9);
  assertEquals(summary.critical_field_agreement_rate, 1.0);
});

Deno.test("aggregateRunMetrics: an empty corpus returns null rates, not NaN or 0", () => {
  const summary = aggregateRunMetrics([]);
  assertEquals(summary.total_runs, 0);
  assertEquals(summary.pipeline_completion_rate, null);
  assertEquals(summary.legacy_canonical_agreement_rate, null);
});

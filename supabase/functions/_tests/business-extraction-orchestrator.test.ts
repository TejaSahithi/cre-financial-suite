// @ts-nocheck
// Azure + Vertex Phase 4E (local implementation): unit tests for
// runBusinessExtraction(), using dependency-injected vertexRunner/legacyRunner
// fixtures — zero HTTP/network involvement, no live provider calls.
// Run: deno test --allow-env --allow-read --no-lock business-extraction-orchestrator.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runBusinessExtraction } from "../_shared/extraction/business-extraction-orchestrator.ts";

function baseOpts(overrides: Record<string, unknown> = {}) {
  return {
    requestedProvider: "legacy_hybrid" as const,
    moduleType: "lease",
    fileName: "lease.pdf",
    docling: { full_text: "sample lease text", text_blocks: [], tables: [], fields: [] },
    documentSubtype: null,
    correlationId: "file-1",
    ...overrides,
  };
}

function acceptedResult(rows: Record<string, unknown>[] = [{ tenant_name: "Acme Corp" }]) {
  return {
    rows,
    method: "llm_only",
    warnings: [],
    validationErrors: [],
    metadata: {
      ruleFieldsExtracted: 0, tableFieldsExtracted: 0, llmFieldsExtracted: 1, totalRecords: rows.length,
      avgConfidence: 90, chunksProcessed: 1, processingTimeMs: 10,
      extractionDebug: { vertex_fact_ledger: { evidence_anchors: [{ category: "tenant_name", source_text: "Acme Corp", source_page: 1 }] } },
    },
  };
}

function emptyResult(classification?: string) {
  return {
    rows: [],
    method: "fallback",
    warnings: ["mock failure"],
    validationErrors: [],
    metadata: {
      ruleFieldsExtracted: 0, tableFieldsExtracted: 0, llmFieldsExtracted: 0, totalRecords: 0,
      avgConfidence: 0, chunksProcessed: 0, processingTimeMs: 0,
      extractionDebug: classification ? { vertex_fact_ledger: { failure_classification: classification } } : {},
    },
  };
}

Deno.test("runBusinessExtraction: legacy_hybrid calls legacy only", async () => {
  let vertexCalls = 0, legacyCalls = 0;
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "legacy_hybrid",
    vertexRunner: async () => { vertexCalls++; return acceptedResult(); },
    legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
  }));
  assertEquals(vertexCalls, 0);
  assertEquals(legacyCalls, 1);
  assertEquals(result.metadata.provenance.effective_provider, "legacy_hybrid");
  assertEquals(result.metadata.provenance.fallback_used, false);
});

Deno.test("runBusinessExtraction: existing direct vertex_fact_ledger mode preserves its behavior — never invokes legacy even on total failure", async () => {
  let legacyCalls = 0;
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_fact_ledger",
    vertexRunner: async () => emptyResult("authentication"),
    legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
  }));
  assertEquals(legacyCalls, 0, "direct vertex_fact_ledger mode must never trigger legacy fallback");
  assertEquals(result.metadata.provenance.effective_provider, "openai_fact_ledger");
  assertEquals(result.metadata.provenance.fallback_used, false);
});

Deno.test("runBusinessExtraction: vertex_primary_legacy_fallback — accepted Vertex result prevents legacy invocation", async () => {
  let legacyCalls = 0;
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => acceptedResult(),
    legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
  }));
  assertEquals(legacyCalls, 0);
  assertEquals(result.metadata.provenance.effective_provider, "openai_fact_ledger");
  assertEquals(result.metadata.provenance.acceptance_state, "accepted");
});

Deno.test("runBusinessExtraction: vertex_primary_legacy_fallback — accepted_needs_review Vertex result also prevents fallback", async () => {
  let legacyCalls = 0;
  const needsReview = acceptedResult();
  needsReview.metadata.extractionDebug = { vertex_fact_ledger: { evidence_anchors: [] } }; // triggers needs_review
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => needsReview,
    legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
  }));
  assertEquals(legacyCalls, 0);
  assertEquals(result.metadata.provenance.acceptance_state, "accepted_needs_review");
  assertEquals(result.metadata.provenance.fallback_used, false);
});

Deno.test("runBusinessExtraction: vertex_primary_legacy_fallback — timeout triggers eligible fallback, legacy runs exactly once", async () => {
  let vertexCalls = 0, legacyCalls = 0;
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => { vertexCalls++; return emptyResult("timeout"); },
    legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
  }));
  assertEquals(vertexCalls, 1, "no outer retry loop — exactly one Vertex invocation");
  assertEquals(legacyCalls, 1);
  assertEquals(result.metadata.provenance.effective_provider, "legacy_hybrid");
  assertEquals(result.metadata.provenance.fallback_used, true);
  assertEquals(result.metadata.provenance.fallback_reason, "timeout");
});

for (const classification of ["rate_limit", "provider_server_error", "transport", "malformed_response", "empty_extraction", "model_unavailable", "budget_exhausted"]) {
  Deno.test(`runBusinessExtraction: vertex_primary_legacy_fallback — ${classification} triggers eligible fallback`, async () => {
    let legacyCalls = 0;
    const result = await runBusinessExtraction(baseOpts({
      requestedProvider: "vertex_primary_legacy_fallback",
      vertexRunner: async () => emptyResult(classification),
      legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
    }));
    assertEquals(legacyCalls, 1);
    assertEquals(result.metadata.provenance.fallback_used, true);
  });
}

Deno.test("runBusinessExtraction: vertex_primary_legacy_fallback — authentication failure does NOT trigger fallback, explicit failure instead", async () => {
  let legacyCalls = 0;
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => emptyResult("authentication"),
    legacyRunner: async () => { legacyCalls++; return acceptedResult(); },
  }));
  assertEquals(legacyCalls, 0, "auth/config failures must never trigger legacy fallback");
  assertEquals(result.metadata.provenance.acceptance_state, "extraction_failed_manual_review");
  assertEquals(result.metadata.provenance.fallback_used, false);
});

Deno.test("runBusinessExtraction: vertex_primary_legacy_fallback — no recursive fallback: legacy also failing does not re-attempt Vertex", async () => {
  let vertexCalls = 0, legacyCalls = 0;
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => { vertexCalls++; return emptyResult("timeout"); },
    legacyRunner: async () => { legacyCalls++; return emptyResult(); },
  }));
  assertEquals(vertexCalls, 1, "vertex is never re-attempted after legacy also fails");
  assertEquals(legacyCalls, 1, "legacy runs at most once");
  assertEquals(result.metadata.provenance.acceptance_state, "extraction_failed_manual_review");
});

Deno.test("runBusinessExtraction: both Vertex and legacy rejected produces an explicit extraction_failed_manual_review result, never a review-ready payload from empty rows", async () => {
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => emptyResult("timeout"),
    legacyRunner: async () => emptyResult(),
  }));
  assertEquals(result.rows.length, 0);
  assertEquals(result.metadata.provenance.acceptance_state, "extraction_failed_manual_review");
});

Deno.test("runBusinessExtraction: legacy result is ALSO evaluated for acceptance, not assumed valid — an accepted_needs_review legacy fallback is reported as such", async () => {
  const legacyNeedsReview = acceptedResult();
  legacyNeedsReview.metadata.extractionDebug = { vertex_fact_ledger: { evidence_anchors: [] } };
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => emptyResult("timeout"),
    legacyRunner: async () => legacyNeedsReview,
  }));
  assertEquals(result.metadata.provenance.effective_provider, "legacy_hybrid");
  assertEquals(result.metadata.provenance.acceptance_state, "accepted_needs_review");
});

Deno.test("runBusinessExtraction: provider fields are never blended — the returned result is always one provider's rows wholesale, never a merge", async () => {
  const vertexRows = [{ tenant_name: "Vertex Tenant", monthly_rent: 1000 }];
  const legacyRows = [{ tenant_name: "Legacy Tenant", square_footage: 5000 }];
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => emptyResult("timeout"),
    legacyRunner: async () => acceptedResult(legacyRows),
  }));
  assertEquals(result.rows, legacyRows, "must be exactly legacy's rows, never vertexRows merged in");
});

Deno.test("runBusinessExtraction: requested/effective provider and fallback reason are accurate in provenance", async () => {
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_primary_legacy_fallback",
    vertexRunner: async () => emptyResult("rate_limit"),
    legacyRunner: async () => acceptedResult(),
  }));
  assertEquals(result.metadata.provenance.requested_provider, "openai_primary_legacy_fallback");
  assertEquals(result.metadata.provenance.effective_provider, "legacy_hybrid");
  assertEquals(result.metadata.provenance.fallback_reason, "rate_limit");
  assertEquals(result.metadata.provenance.openai_attempt_count, 1);
});

Deno.test("runBusinessExtraction: provenance is attached for every mode, including plain legacy_hybrid", async () => {
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "legacy_hybrid",
    legacyRunner: async () => acceptedResult(),
  }));
  assert(result.metadata.provenance, "provenance must always be present");
  assertEquals(result.metadata.provenance.provider_mocked, false);
});

Deno.test("runBusinessExtraction: mockVertexScenario produces provenance marking provider_mocked=true with the scenario name, never mistaken for real-provider validation", async () => {
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "vertex_fact_ledger",
    mockVertexScenario: "success",
  }));
  assertEquals(result.metadata.provenance.provider_mocked, true);
  assertEquals(result.metadata.provenance.mock_scenario, "success");
});

Deno.test("runBusinessExtraction: legacy_hybrid wraps a throwing legacyRunner in a try/catch (runExtractionPipeline has no blanket guard of its own)", async () => {
  const result = await runBusinessExtraction(baseOpts({
    requestedProvider: "legacy_hybrid",
    legacyRunner: async () => { throw new Error("boom — simulated uncaught pipeline.ts failure"); },
  }));
  assertEquals(result.method, "fallback");
  assertEquals(result.rows.length, 0);
});

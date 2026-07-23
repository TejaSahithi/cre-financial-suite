// @ts-nocheck
// Azure + Vertex Phase 4E (local implementation): unit tests for the
// deterministic acceptance evaluator. Pure-function tests only — no DB, no
// network, no live provider calls.
// Run: deno test --allow-env --allow-read --no-lock business-extraction-acceptance.test.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateExtractionAcceptance } from "../_shared/extraction/business-extraction-acceptance.ts";

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    rows: [],
    method: "fallback",
    warnings: [],
    validationErrors: [],
    metadata: {
      ruleFieldsExtracted: 0,
      tableFieldsExtracted: 0,
      llmFieldsExtracted: 0,
      totalRecords: 0,
      avgConfidence: 0,
      chunksProcessed: 0,
      processingTimeMs: 0,
      extractionDebug: {},
    },
    ...overrides,
  };
}

Deno.test("evaluateExtractionAcceptance: a real result with evidence-backed fields is accepted", () => {
  const result = baseResult({
    rows: [{ tenant_name: "Acme Corp", monthly_rent: 5000 }],
    method: "llm_only",
    metadata: {
      ...baseResult().metadata,
      extractionDebug: { vertex_fact_ledger: { evidence_anchors: [{ category: "tenant_name", source_text: "Acme Corp", source_page: 1 }] } },
    },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
  assertEquals(acceptance.state, "accepted");
  assertEquals(acceptance.meaningfulFieldCount, 2);
});

Deno.test("evaluateExtractionAcceptance: meaningful fields but zero evidence anchors resolves to accepted_needs_review, not fallback", () => {
  const result = baseResult({
    rows: [{ tenant_name: "Acme Corp" }],
    method: "llm_only",
    metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { evidence_anchors: [] } } },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
  assertEquals(acceptance.state, "accepted_needs_review");
  assertEquals(acceptance.reason, "low_evidence_coverage");
});

Deno.test("evaluateExtractionAcceptance: validation errors present resolves to accepted_needs_review (conflicting facts), never automatic fallback", () => {
  const result = baseResult({
    rows: [{ tenant_name: "Acme Corp" }],
    method: "llm_only",
    validationErrors: [{ field: "monthly_rent", message: "conflicting values" }],
    metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { evidence_anchors: [{ category: "tenant_name", source_text: "x", source_page: 1 }] } } },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
  assertEquals(acceptance.state, "accepted_needs_review");
  assertEquals(acceptance.reason, "validation_errors_present");
});

Deno.test("evaluateExtractionAcceptance: reduced-coverage profile (assignment) with sparse fields is not penalized for low evidence the same way", () => {
  const result = baseResult({
    rows: [{ assignor_name: "Acme Corp" }],
    method: "llm_only",
    metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { evidence_anchors: [] } } },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger", documentProfile: "assignment" });
  // Reduced-coverage profiles skip the low-evidence-coverage needs_review
  // trigger entirely -- a sparse but real extraction is simply accepted.
  assertEquals(acceptance.state, "accepted");
});

Deno.test("evaluateExtractionAcceptance: a fallback-eligible structured classification (timeout) on an empty result is fallback_eligible", () => {
  const result = baseResult({
    rows: [],
    method: "fallback",
    warnings: ["Vertex fact ledger pipeline failed: timeout"],
    metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { failure_classification: "timeout", failure_http_status: null } } },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
  assertEquals(acceptance.state, "fallback_eligible");
  assertEquals(acceptance.reason, "timeout");
});

Deno.test("evaluateExtractionAcceptance: 429/5xx/transport/budget_exhausted/model_unavailable/malformed_response/empty_extraction are all fallback_eligible", () => {
  for (const classification of ["rate_limit", "provider_server_error", "transport", "budget_exhausted", "model_unavailable", "malformed_response", "empty_extraction"]) {
    const result = baseResult({
      rows: [],
      method: "fallback",
      metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { failure_classification: classification } } },
    });
    const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
    assertEquals(acceptance.state, "fallback_eligible", `expected fallback_eligible for ${classification}`);
  }
});

Deno.test("evaluateExtractionAcceptance: authentication failure is rejected, never fallback_eligible — a bad credential must not be masked", () => {
  const result = baseResult({
    rows: [],
    method: "fallback",
    metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { failure_classification: "authentication" } } },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
  assertEquals(acceptance.state, "rejected");
  assertEquals(acceptance.reason, "authentication");
});

Deno.test("evaluateExtractionAcceptance: missing optional fields alone never triggers fallback — only tested implicitly by the accepted case above having fewer than all schema fields", () => {
  // A result with just one real field and evidence is still accepted, never
  // downgraded merely for not populating every possible schema field.
  const result = baseResult({
    rows: [{ tenant_name: "Acme Corp" }],
    method: "llm_only",
    metadata: { ...baseResult().metadata, extractionDebug: { vertex_fact_ledger: { evidence_anchors: [{ category: "tenant_name", source_text: "Acme Corp", source_page: 1 }] } } },
  });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "vertex_fact_ledger" });
  assertEquals(acceptance.state, "accepted");
});

Deno.test("evaluateExtractionAcceptance: legacy_hybrid is evaluated by the SAME evaluator, not assumed valid by default (empty legacy result is fallback_eligible-shaped, i.e. rejected since there is no further fallback for legacy itself)", () => {
  const result = baseResult({ rows: [], method: "fallback" });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "legacy_hybrid" });
  assertEquals(acceptance.state, "rejected");
});

Deno.test("evaluateExtractionAcceptance: a genuinely empty legacy_hybrid result with no structured classification at all is still rejected (never silently accepted)", () => {
  const result = baseResult({ rows: [{}], method: "fallback" });
  const acceptance = evaluateExtractionAcceptance(result, { provider: "legacy_hybrid" });
  assertEquals(acceptance.state, "rejected");
});

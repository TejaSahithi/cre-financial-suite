// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { computeProfileApprovalBlockers } from "../_shared/extraction/openai-fact-ledger/approval-blockers.ts";
import { runOpenAIFactLedgerPipeline } from "../_shared/extraction/openai-fact-ledger/orchestrator.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    category: "clause:default",
    value: "test value",
    sourceText: "Some source text",
    sourcePage: 1,
    confidence: 0.8,
    ...overrides,
  };
}

function sampleDocling() {
  return {
    markdown: "Sample CRE Lease document. Base Rent: $5,000 per month. Page 2. Governed by Delaware law. Page 5.",
    pages: [
      { number: 1, dimensions: { width: 612, height: 792 } },
      { number: 2, dimensions: { width: 612, height: 792 } },
      { number: 5, dimensions: { width: 612, height: 792 } },
    ],
  };
}

function assertIsExtractionPipelineResultShape(result: any) {
  assert(result);
  assert(Array.isArray(result.rows));
  assert(typeof result.method === "string");
  assert(Array.isArray(result.warnings));
  assert(Array.isArray(result.validationErrors));
  assert(result.metadata);
  assert(typeof result.metadata.avgConfidence === "number");
  assert(typeof result.metadata.chunksProcessed === "number");
  assert(typeof result.metadata.processingTimeMs === "number");
}

Deno.test("runOpenAIFactLedgerPipeline: no OpenAI credentials configured — degrades cleanly, never throws/hangs", async () => {
  Deno.env.delete("OPENAI_API_KEY");

  const result = await runOpenAIFactLedgerPipeline({
    moduleType: "lease",
    fileName: "no-credentials.txt",
    docling: sampleDocling(),
    documentSubtype: null,
  });

  assertIsExtractionPipelineResultShape(result);
  assertEquals(result.method, "fallback");
  assert(result.warnings.length > 0);
});

Deno.test("runOpenAIFactLedgerPipeline: ENABLE_DOCUMENT_INTELLIGENCE_V3 unset uses legacy_evidence_index by default", async () => {
  Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
  Deno.env.delete("OPENAI_API_KEY");

  try {
    const result = await runOpenAIFactLedgerPipeline({
      moduleType: "lease",
      fileName: "flag-off.txt",
      docling: sampleDocling(),
      documentSubtype: null,
    });

    // vertex_fact_ledger is the intentional legacy-named debug-key mirror of
    // openai_fact_ledger, retained for back-compat with stored/consumed
    // debug payloads (see business-extraction-orchestrator.ts). Not stale.
    const vfl = (result.metadata as any)?.extractionDebug?.vertex_fact_ledger;
    assert(vfl);
    assertEquals(vfl.document_index_source, "legacy_evidence_index");
    assertEquals(vfl.document_index_fallback_reason, null);
    assertEquals(vfl.evidence_anchors, []);
  } finally {
    Deno.env.set("ENABLE_DOCUMENT_INTELLIGENCE_V3", "true");
  }
});

Deno.test("runOpenAIFactLedgerPipeline: mocked successful OpenAI call — return-shape contract and field mapping", async () => {
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");

  const realFetch = globalThis.fetch;
  let generateContentCallCount = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("api.openai.com/v1/chat/completions")) {
      generateContentCallCount++;
      const isProfileCall = generateContentCallCount === 1;
      const responseText = isProfileCall
        ? JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" })
        : JSON.stringify([
          { category: "clause:rent_escalation", value: 5000, source_text: "Base Rent: $5,000 per month.", source_page: 2, confidence: 0.9 },
          { category: "clause:governing_law", value: "Delaware", source_text: "Governed by the laws of the State of Delaware.", source_page: 5, confidence: 0.8 },
        ]);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: responseText }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const result = await runOpenAIFactLedgerPipeline({
      moduleType: "lease",
      fileName: "mocked-success.txt",
      docling: sampleDocling(),
      documentSubtype: null,
    });

    assertIsExtractionPipelineResultShape(result);
    assertEquals(result.method, "llm_only");

    const debug = (result.metadata as any).extractionDebug;
    assert(debug);

    const monthlyRent = debug.merged_field_sources?.monthly_rent;
    assert(monthlyRent);
    assertEquals(monthlyRent.value, 5000);
    assertEquals(monthlyRent.source, "llm");
    assertEquals(monthlyRent.source_page, 2);

    const vfl = debug.vertex_fact_ledger;
    assert(vfl);
    assertEquals(vfl.document_profile, "full_lease");
    assertEquals(vfl.document_profile_method, "openai");
  } finally {
    globalThis.fetch = realFetch;
    Deno.env.delete("OPENAI_API_KEY");
  }
});

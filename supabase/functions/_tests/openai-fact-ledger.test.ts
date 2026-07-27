// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { surfaceDynamicFacts } from "../_shared/extraction/openai-fact-ledger/dynamic-fact-surfacer.ts";
import { cleanEvidenceSnippet } from "../_shared/extraction/evidence-index.ts";
import { computeProfileApprovalBlockers } from "../_shared/extraction/openai-fact-ledger/approval-blockers.ts";
import { runOpenAIFactLedgerPipeline } from "../_shared/extraction/openai-fact-ledger/orchestrator.ts";
import { __test__ as factLedgerExtractorTest } from "../_shared/extraction/openai-fact-ledger/fact-ledger-extractor.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";
import { chunkDocument } from "../_shared/extraction/chunker.ts";
import { parseDate } from "../_shared/extraction/rule-extractor.ts";

const realServeForNormalizeImport = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: normalizeTest } = await import("../normalize-pdf-output/index.ts");
(Deno as any).serve = realServeForNormalizeImport;

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

Deno.test("fact ledger dedupe preserves same-source lease term dates as distinct facts", () => {
  const sourceText = "5. Term. The lease term shall be from an initial five-year period from March 1, 2019 through December 31, 2023.";
  const facts = factLedgerExtractorTest.parseFactsResponse({
    facts: [
      { category: "clause:lease_term", value: "March 1, 2019", source_text: sourceText, source_page: 1, confidence: 0.91 },
      { category: "clause:lease_term", value: "December 31, 2023", source_text: sourceText, source_page: 1, confidence: 0.92 },
      { category: "clause:lease_term", value: "March 1, 2019", source_text: sourceText, source_page: 1, confidence: 0.91 },
    ],
  });

  assertEquals(facts.length, 3);
  const deduped = factLedgerExtractorTest.dedupeFacts(facts);
  assertEquals(deduped.map((fact: Fact) => fact.value), ["March 1, 2019", "December 31, 2023"]);

  const mapped = mapFactsToStandardFields({ facts: deduped, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.start_date?.value, "2019-03-01");
  assertEquals(mapped.records[0]?.fields?.end_date?.value, "2023-12-31");
  assertEquals(mapped.records[0]?.fields?.commencement_date?.value, "2019-03-01");
  assertEquals(mapped.records[0]?.fields?.expiration_date?.value, "2023-12-31");
});

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
    // Bug fix: this test explicitly deletes the flag above (line 89) to test
    // the unset/default behavior -- the teardown must restore that same
    // "unset" state, not flip it to "true". Setting it true here previously
    // leaked ENABLE_DOCUMENT_INTELLIGENCE_V3=true for the remainder of any
    // `deno test` invocation that ran this file before others, silently
    // changing document-index-v3 resolution (canonical_layout vs
    // legacy_evidence_index) for every subsequent test in the same process.
    Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
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
Deno.test("runOpenAIFactLedgerPipeline: mocked same-source lease term facts become canonical dates", async () => {
  const sourceText = "5. Term. The lease term shall be from an initial five-year period from March 1, 2019 through December 31, 2023.";
  const docling = {
    full_text: `LEASE AGREEMENT\n\n${sourceText}`,
    page_count: 1,
    pages: [{ number: 1, text: sourceText, dimensions: { width: 612, height: 792 } }],
    text_blocks: [{ block_index: 0, type: "paragraph", page: 1, text: sourceText }],
    tables: [],
    fields: [],
  };

  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");

  const realFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("api.openai.com/v1/chat/completions")) {
      callCount++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const systemPrompt = String((body.messages || []).find((m: any) => m.role === "system")?.content ?? "");
      // LLM_PRIMARY_MAPPING_MODE defaults to "active" -- adaptive-extractor.ts's
      // schema-aware domain call (buildDomainFieldAssignmentPrompt) asks for a
      // direct {fields: {...}} assignment instead of the legacy {facts: [...]}
      // shape. Responding correctly to whichever prompt was actually sent
      // keeps this test meaningful regardless of the flag's default.
      const isFieldAssignmentCall = systemPrompt.includes("SCHEMA FIELDS FOR THIS CALL");
      let responseText: string;
      if (callCount === 1) {
        responseText = JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" });
      } else if (isFieldAssignmentCall) {
        // Only the primary pair -- fact-field-mapper.ts's mirrorDateAlias
        // fills start_date/end_date from these, exactly as it would for a
        // real schema-aware response, keeping facts_extracted_count at 2
        // (matching this test's original, still-accurate intent).
        responseText = JSON.stringify({
          fields: {
            commencement_date: { value: "2019-03-01", source_text: sourceText, source_page: 1, confidence: 0.91 },
            expiration_date: { value: "2023-12-31", source_text: sourceText, source_page: 1, confidence: 0.92 },
          },
        });
      } else {
        responseText = JSON.stringify({
          facts: [
            { category: "clause:lease_term", value: "March 1, 2019", source_text: sourceText, source_page: 1, confidence: 0.91 },
            { category: "clause:lease_term", value: "December 31, 2023", source_text: sourceText, source_page: 1, confidence: 0.92 },
          ],
        });
      }
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
      fileName: "macon-term.txt",
      docling,
      documentSubtype: null,
    });

    assertIsExtractionPipelineResultShape(result);
    assertEquals(result.method, "llm_only");

    const debug = (result.metadata as any).extractionDebug;
    const fields = debug.merged_field_sources;
    assertEquals(debug.openai_fact_ledger.facts_extracted_count, 2);
    assertEquals(fields.start_date?.value, "2019-03-01");
    assertEquals(fields.end_date?.value, "2023-12-31");
    assertEquals(fields.commencement_date?.value, "2019-03-01");
    assertEquals(fields.expiration_date?.value, "2023-12-31");
    assertEquals(fields.commencement_date?.source_text, sourceText);
    assertEquals(fields.expiration_date?.source_text, sourceText);
  } finally {
    globalThis.fetch = realFetch;
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT");
    else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
  }
});

Deno.test("runOpenAIFactLedgerPipeline: processes every generated text chunk when adaptive extraction is disabled", async () => {
  // This test exercises the whole-document chunking path specifically
  // (extractFactLedger), not the Section-Aware Candidate Router that is now
  // the default (adaptive-extractor.ts). The fixture below is generic filler
  // text with no real section headings, so under adaptive routing every
  // domain would correctly resolve to "not applicable" or need at most one
  // call each -- a real, intended cost reduction, not a regression. Setting
  // DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION=true here preserves this test's
  // original intent: proving the legacy chunk-per-chunk path itself still
  // works correctly, since it remains the fallback/kill-switch path.
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousMaxChunks = Deno.env.get("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  const previousAdaptiveDisabled = Deno.env.get("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.delete("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", "true");

  const textBlocks = Array.from({ length: 9 }, (_, index) => {
    const n = index + 1;
    return {
      block_index: index,
      type: "paragraph",
      page: n,
      text: `Section ${n}. Permitted Use chunk ${n}: Tenant may use the premises for office services. ${"Lease text. ".repeat(250)}`,
    };
  });
  const docling = {
    full_text: textBlocks.map((block) => block.text).join("\n\n"),
    page_count: textBlocks.length,
    pages: textBlocks.map((block) => ({ number: block.page, text: block.text, dimensions: { width: 612, height: 792 } })),
    text_blocks: textBlocks,
    tables: [],
    fields: [],
  };
  const expectedChunks = chunkDocument(docling).length;
  if (expectedChunks <= 4) throw new Error(`fixture must produce more than 4 chunks; got ${expectedChunks}`);

  const realFetch = globalThis.fetch;
  let profileCalls = 0;
  let factCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (url.includes("api.openai.com/v1/chat/completions")) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const userPrompt = String((body.messages || []).find((m: any) => m.role === "user")?.content ?? "");
      if (/document_profile/i.test(userPrompt) || profileCalls === 0) {
        profileCalls++;
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      factCalls++;
      const sourceText = userPrompt.match(/Section\s+\d+\.\s+Permitted Use[^\n]+/)?.[0] ?? userPrompt.slice(0, 120);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ category: "clause:permitted_use", value: `office services chunk ${factCalls}`, source_text: sourceText, source_page: factCalls, confidence: 0.9 }] }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return realFetch(input, init);
  }) as typeof fetch;

  try {
    const result = await runOpenAIFactLedgerPipeline({
      moduleType: "lease",
      fileName: "long-full-lease.txt",
      docling,
      documentSubtype: "full_lease",
    });

    assertIsExtractionPipelineResultShape(result);
    assertEquals(factCalls, expectedChunks);
    assertEquals((result.metadata as any).chunksProcessed, expectedChunks);
    assertEquals((result.metadata as any).chunksTotal, expectedChunks);
    assertEquals((result.metadata as any).extractionDebug.openai_fact_ledger.chunks_truncated, false);
    assertEquals((result.metadata as any).extractionDebug.openai_fact_ledger.facts_extracted_count, expectedChunks);
  } finally {
    globalThis.fetch = realFetch;
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY");
    else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT");
    else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
    if (previousMaxChunks == null) Deno.env.delete("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
    else Deno.env.set("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS", previousMaxChunks);
    if (previousAdaptiveDisabled == null) Deno.env.delete("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION");
    else Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", previousAdaptiveDisabled);
  }
});
Deno.test("runOpenAIFactLedgerPipeline: final chunk fact maps through canonical fields into ui_review_payload (adaptive extraction disabled)", async () => {
  // Same rationale as the test above -- exercises the legacy whole-document
  // chunking path explicitly.
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousMaxChunks = Deno.env.get("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  const previousAdaptiveDisabled = Deno.env.get("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.delete("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "2");
  Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", "true");

  const finalSourceText = "Final economic terms. Base Rent: $2,100 per month for the Premises.";
  const textBlocks = Array.from({ length: 10 }, (_, index) => ({
    block_index: index,
    type: "paragraph",
    page: index + 1,
    text: index === 9
      ? finalSourceText
      : `Background section ${index + 1}. ${"Lease recital text. ".repeat(260)}`,
  }));
  const docling = {
    full_text: textBlocks.map((block) => block.text).join("\n\n"),
    page_count: textBlocks.length,
    pages: textBlocks.map((block) => ({ number: block.page, text: block.text, dimensions: { width: 612, height: 792 } })),
    text_blocks: textBlocks,
    tables: [],
    fields: [],
  };
  const expectedChunks = chunkDocument(docling).length;
  assert(expectedChunks > 1, `fixture must produce multiple chunks; got ${expectedChunks}`);

  const realFetch = globalThis.fetch;
  let profileCalls = 0;
  let factCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (!url.includes("api.openai.com/v1/chat/completions")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const userPrompt = String((body.messages || []).find((m: any) => m.role === "user")?.content ?? "");
    if (profileCalls === 0) {
      profileCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    factCalls++;
    const facts = userPrompt.includes(finalSourceText)
      ? [{ category: "clause:rent_escalation", value: 2100, source_text: finalSourceText, source_page: 10, confidence: 0.96 }]
      : [];
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await runOpenAIFactLedgerPipeline({
      moduleType: "lease",
      fileName: "final-chunk-rent.txt",
      docling,
      documentSubtype: "full_lease",
    });

    assertEquals(factCalls, expectedChunks);
    const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
    assertEquals(debug.facts_extracted_count, 1);
    assertEquals(debug.facts_mapped_count >= 1, true);
    assertEquals(debug.chunks_processed_count, expectedChunks);
    assertEquals(debug.chunks_succeeded_count, expectedChunks);

    const fields = (result.metadata as any).extractionDebug.merged_field_sources;
    assertEquals(fields.monthly_rent?.value, 2100);
    assertEquals(fields.monthly_rent?.source_page, 10);
    assertEquals(result.rows[0]?.monthly_rent, 2100);

    const payload = normalizeTest.buildMinimalReviewPayload({
      fileId: "file-final-chunk",
      fileName: "final-chunk-rent.txt",
      moduleType: "leases",
      documentSubtype: "full_lease",
      extractionMethod: "openai_fact_ledger",
      reviewRequired: true,
      result,
    });
    const standardFields = payload.records?.[0]?.standard_fields ?? [];
    const monthlyRent = standardFields.find((field: any) => field.field_key === "monthly_rent");
    assertEquals(monthlyRent?.value, 2100);
    assertEquals(monthlyRent?.evidence?.source_page, 10);
    assertEquals(monthlyRent?.evidence?.source_text, finalSourceText);
  } finally {
    globalThis.fetch = realFetch;
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY"); else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT"); else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
    if (previousMaxChunks == null) Deno.env.delete("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS"); else Deno.env.set("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS", previousMaxChunks);
    if (previousConcurrency == null) Deno.env.delete("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY"); else Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", previousConcurrency);
    if (previousAdaptiveDisabled == null) Deno.env.delete("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION"); else Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", previousAdaptiveDisabled);
  }
});

Deno.test("runOpenAIFactLedgerPipeline: concurrent chunk extraction is deterministic across repeated runs", async () => {
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "2");

  const sources = [
    "Tenant Name: Alpha Retail LLC.",
    "Landlord Name: Beta Owner LLC.",
    "Premises contain 1,875 rentable square feet.",
    "Base Rent shall be $2,100 per month.",
  ];
  const textBlocks = sources.map((source, index) => ({
    block_index: index,
    type: "paragraph",
    page: index + 1,
    text: `${source} ${"Supporting lease text. ".repeat(260)}`,
  }));
  const docling = {
    full_text: textBlocks.map((block) => block.text).join("\n\n"),
    page_count: textBlocks.length,
    pages: textBlocks.map((block) => ({ number: block.page, text: block.text, dimensions: { width: 612, height: 792 } })),
    text_blocks: textBlocks,
    tables: [],
    fields: [],
  };

  async function runOnce() {
    const realFetch = globalThis.fetch;
    let profileCalls = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = input.toString();
      if (!url.includes("api.openai.com/v1/chat/completions")) return realFetch(input, init);
      const body = JSON.parse(String(init?.body ?? "{}"));
      const userPrompt = String((body.messages || []).find((m: any) => m.role === "user")?.content ?? "");
      if (profileCalls === 0) {
        profileCalls++;
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      const slowEarlyChunk = userPrompt.includes("Tenant Name") ? 5 : 0;
      if (slowEarlyChunk) await new Promise((resolve) => setTimeout(resolve, slowEarlyChunk));
      const facts = [];
      if (userPrompt.includes("Tenant Name")) facts.push({ category: "clause:party_identification", value: "Alpha Retail LLC", source_text: sources[0], source_page: 1, confidence: 0.97 });
      if (userPrompt.includes("Landlord Name")) facts.push({ category: "clause:party_identification", value: "Beta Owner LLC", source_text: sources[1], source_page: 2, confidence: 0.97 });
      if (userPrompt.includes("1,875 rentable square feet")) facts.push({ category: "clause:premises_description", value: 1875, source_text: sources[2], source_page: 3, confidence: 0.98 });
      if (userPrompt.includes("$2,100 per month")) facts.push({ category: "clause:rent_escalation", value: 2100, source_text: sources[3], source_page: 4, confidence: 0.98 });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    try {
      const result = await runOpenAIFactLedgerPipeline({ moduleType: "lease", fileName: "deterministic.txt", docling, documentSubtype: "full_lease" });
      return JSON.stringify((result.metadata as any).extractionDebug.merged_field_sources);
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  try {
    const outputs = [];
    for (let i = 0; i < 5; i++) outputs.push(await runOnce());
    assertEquals(new Set(outputs).size, 1);
  } finally {
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY"); else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT"); else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
    if (previousConcurrency == null) Deno.env.delete("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY"); else Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", previousConcurrency);
  }
});

Deno.test("runOpenAIFactLedgerPipeline: one failed chunk preserves successful facts and reports partial diagnostics (adaptive extraction disabled)", async () => {
  // Chunk-level partial-failure diagnostics are specific to the legacy
  // whole-document chunking path; exercised explicitly via the kill switch.
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  const previousAdaptiveDisabled = Deno.env.get("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "2");
  Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", "true");

  const rentSourceText = "Base Rent shall be $2,100 per month.";
  const textBlocks = [
    { block_index: 0, type: "paragraph", page: 1, text: `Problem chunk. ${"Lease text. ".repeat(700)}` },
    { block_index: 1, type: "paragraph", page: 2, text: `${rentSourceText} ${"Lease text. ".repeat(700)}` },
  ];
  const docling = {
    full_text: textBlocks.map((block) => block.text).join("\n\n"),
    page_count: textBlocks.length,
    pages: textBlocks.map((block) => ({ number: block.page, text: block.text, dimensions: { width: 612, height: 792 } })),
    text_blocks: textBlocks,
    tables: [],
    fields: [],
  };

  const realFetch = globalThis.fetch;
  let profileCalls = 0;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (!url.includes("api.openai.com/v1/chat/completions")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const userPrompt = String((body.messages || []).find((m: any) => m.role === "user")?.content ?? "");
    if (profileCalls === 0) {
      profileCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (userPrompt.includes("Problem chunk")) {
      return new Response(JSON.stringify({ error: { message: "synthetic chunk failure", code: "test_failure" } }), { status: 500, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts: [{ category: "clause:rent_escalation", value: 2100, source_text: rentSourceText, source_page: 2, confidence: 0.97 }] }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await runOpenAIFactLedgerPipeline({ moduleType: "lease", fileName: "partial-success.txt", docling, documentSubtype: "full_lease" });
    const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
    assertEquals(result.rows[0]?.monthly_rent, 2100);
    assertEquals(debug.chunks_failed_count, 1);
    assertEquals(debug.failed_chunk_indexes, [0]);
    assertEquals(debug.partial_result, true);
    assertEquals(debug.facts_extracted_count, 1);
    assertEquals(debug.failure_classification, undefined);
  } finally {
    globalThis.fetch = realFetch;
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY"); else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT"); else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
    if (previousConcurrency == null) Deno.env.delete("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY"); else Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", previousConcurrency);
    if (previousAdaptiveDisabled == null) Deno.env.delete("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION"); else Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", previousAdaptiveDisabled);
  }
});
Deno.test("runOpenAIFactLedgerPipeline: execution budget guard pauses with continuation diagnostics after a completed batch (adaptive extraction disabled)", async () => {
  // Chunk-batch execution-budget pausing/continuation is specific to the
  // legacy whole-document chunking path; exercised explicitly via the kill
  // switch.
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  const previousReserve = Deno.env.get("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS");
  const previousAdaptiveDisabled = Deno.env.get("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "1");
  Deno.env.set("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS", "60000");
  Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", "true");

  const firstSourceText = "Base Rent: $2,100 per month.";
  const textBlocks = [
    { block_index: 0, type: "paragraph", page: 1, text: `${firstSourceText} ${"Lease text. ".repeat(700)}` },
    { block_index: 1, type: "paragraph", page: 2, text: `Later chunk. ${"Lease text. ".repeat(700)}` },
  ];
  const docling = {
    full_text: textBlocks.map((block) => block.text).join("\n\n"),
    page_count: textBlocks.length,
    pages: textBlocks.map((block) => ({ number: block.page, text: block.text, dimensions: { width: 612, height: 792 } })),
    text_blocks: textBlocks,
    tables: [],
    fields: [],
  };

  const realFetch = globalThis.fetch;
  let profileCalls = 0;
  let progressEvents: any[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (!url.includes("api.openai.com/v1/chat/completions")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const userPrompt = String((body.messages || []).find((m: any) => m.role === "user")?.content ?? "");
    if (profileCalls === 0) {
      profileCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const facts = userPrompt.includes(firstSourceText)
      ? [{ category: "clause:rent_escalation", value: 2100, source_text: firstSourceText, source_page: 1, confidence: 0.96 }]
      : [];
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const result = await runOpenAIFactLedgerPipeline(
      { moduleType: "lease", fileName: "deadline-guard.txt", docling, documentSubtype: "full_lease" },
      { deadlineAt: Date.now() + 1, onProgress: (progress) => progressEvents.push(progress) },
    );
    const debug = (result.metadata as any).extractionDebug.openai_fact_ledger;
    assertEquals(result.rows[0]?.monthly_rent, 2100);
    assertEquals(debug.chunks_processed_count, 1);
    assertEquals(debug.continuation_required, true);
    assertEquals(debug.continuation_reason, "execution_budget");
    assertEquals(debug.next_chunk_index, 1);
    assertEquals(debug.partial_result, true);
    assert(progressEvents.some((event) => event.continuationRequired === true && event.nextChunkIndex === 1));
  } finally {
    globalThis.fetch = realFetch;
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY"); else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT"); else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
    if (previousConcurrency == null) Deno.env.delete("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY"); else Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", previousConcurrency);
    if (previousReserve == null) Deno.env.delete("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS"); else Deno.env.set("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS", previousReserve);
    if (previousAdaptiveDisabled == null) Deno.env.delete("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION"); else Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", previousAdaptiveDisabled);
  }
});
Deno.test("runOpenAIFactLedgerPipeline: large document resumes from checkpoint and maps prior plus later chunk facts (adaptive extraction disabled)", async () => {
  // Checkpoint/resume support is specific to the legacy whole-document
  // chunking path (extractFactLedger); adaptive mode falls back to it
  // automatically whenever a resume state is provided (see
  // adaptive-extractor.ts's fallback conditions), but this test exercises
  // the resume mechanics directly via the kill switch for clarity.
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  const previousReserve = Deno.env.get("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS");
  const previousAdaptiveDisabled = Deno.env.get("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "1");
  Deno.env.set("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS", "60000");
  Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", "true");

  const rentSourceText = "Base Rent: $2,100 per month.";
  const expirationSourceText = "Expiration Date: December 31, 2023.";
  const textBlocks = [
    { block_index: 0, type: "paragraph", page: 1, text: `${rentSourceText} ${"Lease text. ".repeat(700)}` },
    { block_index: 1, type: "paragraph", page: 2, text: `${expirationSourceText} ${"Lease text. ".repeat(700)}` },
  ];
  const docling = {
    full_text: textBlocks.map((block) => block.text).join("\n\n"),
    page_count: textBlocks.length,
    pages: textBlocks.map((block) => ({ number: block.page, text: block.text, dimensions: { width: 612, height: 792 } })),
    text_blocks: textBlocks,
    tables: [],
    fields: [],
  };

  const realFetch = globalThis.fetch;
  let profileCalls = 0;
  const progressEvents: any[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = input.toString();
    if (!url.includes("api.openai.com/v1/chat/completions")) return realFetch(input, init);
    const body = JSON.parse(String(init?.body ?? "{}"));
    const userPrompt = String((body.messages || []).find((m: any) => m.role === "user")?.content ?? "");
    if (profileCalls === 0 || userPrompt.includes("document_profile")) {
      profileCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    const facts = userPrompt.includes(expirationSourceText)
      ? [{ category: "clause:lease_term", value: "2023-12-31", source_text: expirationSourceText, source_page: 2, confidence: 0.96 }]
      : userPrompt.includes(rentSourceText)
        ? [{ category: "clause:rent_escalation", value: 2100, source_text: rentSourceText, source_page: 1, confidence: 0.96 }]
        : [];
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: JSON.stringify({ facts }) }, finish_reason: "stop" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  try {
    const first = await runOpenAIFactLedgerPipeline(
      { moduleType: "lease", fileName: "resume-first.txt", docling, documentSubtype: "full_lease" },
      { deadlineAt: Date.now() + 1, onProgress: (progress) => progressEvents.push(progress) },
    );
    const firstDebug = (first.metadata as any).extractionDebug.openai_fact_ledger;
    const checkpoint = progressEvents.at(-1);
    assertEquals(firstDebug.continuation_required, true);
    assertEquals(firstDebug.next_chunk_index, 1);
    assertEquals(Array.isArray(checkpoint.partialFacts), true);
    assertEquals(checkpoint.partialFacts.length, 1);

    const resumed = await runOpenAIFactLedgerPipeline(
      { moduleType: "lease", fileName: "resume-second.txt", docling, documentSubtype: "full_lease" },
      {
        resume: {
          startChunkIndex: checkpoint.nextChunkIndex,
          priorFacts: checkpoint.partialFacts,
          chunksProcessed: checkpoint.chunksProcessed,
          chunksSucceeded: checkpoint.chunksSucceeded,
          chunksFailed: checkpoint.chunksFailed,
          failedChunkIndexes: checkpoint.failedChunkIndexes,
        },
      },
    );
    const resumedDebug = (resumed.metadata as any).extractionDebug.openai_fact_ledger;
    assertEquals(resumedDebug.resumed_from_chunk_index, 1);
    assertEquals(resumedDebug.continuation_required, false);
    assertEquals(resumed.rows[0]?.monthly_rent, 2100);
    assertEquals(resumed.rows[0]?.expiration_date, "2023-12-31");
  } finally {
    globalThis.fetch = realFetch;
    if (previousOpenAIKey == null) Deno.env.delete("OPENAI_API_KEY"); else Deno.env.set("OPENAI_API_KEY", previousOpenAIKey);
    if (previousAzureEndpoint == null) Deno.env.delete("AZURE_OPENAI_ENDPOINT"); else Deno.env.set("AZURE_OPENAI_ENDPOINT", previousAzureEndpoint);
    if (previousConcurrency == null) Deno.env.delete("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY"); else Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", previousConcurrency);
    if (previousReserve == null) Deno.env.delete("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS"); else Deno.env.set("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS", previousReserve);
    if (previousAdaptiveDisabled == null) Deno.env.delete("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION"); else Deno.env.set("DISABLE_ADAPTIVE_FACT_LEDGER_EXTRACTION", previousAdaptiveDisabled);
  }
});

Deno.test("fact mapper rejects incompatible value/source pairs from Mindful-style extraction", () => {
  const facts = [
    makeFact({ category: "clause:premises_description", value: "as is, where is", sourceText: "Tenant acknowledges that Tenant is leasing the Premises on an \"as is, where is\" basis.", sourcePage: 1, confidence: 0.99 }),
    makeFact({ category: "clause:premises_description", value: "224 S Peters Road, Suite 212 Knoxville, TN 37923", sourceText: "3. Address of Landlord: 224 S Peters Road, Suite 212 Knoxville, TN 37923", sourcePage: 1, confidence: 0.99 }),
    makeFact({ category: "clause:rent_escalation", value: 13875, sourceText: "In either event, the monthly installments of Base Rent shall be increased to one hundred fifty percent (150%) of the monthly installments of Base Rent in effect at the expiration of the Term.", sourcePage: 12, confidence: 0.98 }),
    makeFact({ category: "clause:default", value: 51, sourceText: "\"Control\" shall mean the ownership, directly or indirectly, of at least fifty-one percent (51%) of the voting securities.", sourcePage: 2, confidence: 0.98 }),
    makeFact({ category: "clause:use_clause", value: "Permitted Use", sourceText: "6 Tenant shall use the Premises solely for the Permitted Use, and for no other purpose without Landlord's consent.", sourcePage: 5, confidence: 0.96 }),
    makeFact({ category: "clause:indemnification", value: "all risk of damage", sourceText: "Tenant hereby assumes all risk of damage or injury to any person or property in, on, or about the Premises.", sourcePage: 8, confidence: 0.97 }),
  ];

  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const fields = mapped.records[0]?.fields ?? {};
  assertEquals(fields.property_address, undefined);
  assertEquals(fields.unit_number, undefined);
  assertEquals(fields.monthly_rent, undefined);
  assertEquals(fields.annual_rent, undefined);
  assertEquals(fields.escalation_rate, undefined);
  assertEquals(fields.landlord_consent_for_transfer, undefined);
  assertEquals(fields.assumption_scope, undefined);
});

Deno.test("fact mapper keeps compatible source-backed rent and premises facts", () => {
  const facts = [
    makeFact({ category: "clause:premises_description", value: "224 S Peters Road Knoxville, TN 37923", sourceText: "Premises containing approximately 1,110 rentable square feet, in the Building located at 224 S Peters Road Knoxville, TN 37923.", sourcePage: 1, confidence: 0.98 }),
    makeFact({ category: "clause:premises_description", value: "Suite 212", sourceText: "Premises: Suite 212 in the Building located at 224 S Peters Road Knoxville, TN 37923.", sourcePage: 1, confidence: 0.98 }),
    makeFact({ category: "clause:rent_escalation", value: 1400, sourceText: "Rent: $1,400 per month.", sourcePage: 1, confidence: 0.98 }),
    makeFact({ category: "clause:rent_escalation", value: 5, sourceText: "The Rent will increase 5% each year of renewal.", sourcePage: 1, confidence: 0.98 }),
    makeFact({ category: "clause:assignment_subletting", value: "Landlord consent required", sourceText: "Tenant shall not assign this Lease or sublet the Premises without Landlord's prior written consent.", sourcePage: 6, confidence: 0.98 }),
  ];

  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const fields = mapped.records[0]?.fields ?? {};
  assertEquals(fields.property_address?.value, "224 S Peters Road Knoxville, TN 37923");
  assertEquals(fields.unit_number?.value, "212");
  assertEquals(fields.monthly_rent?.value, 1400);
  assertEquals(fields.escalation_rate?.value, 5);
  assertEquals(fields.landlord_consent_for_transfer?.value, "Landlord consent required");
});

Deno.test("dynamic fact surfacer suppresses canonical near-misses and definition/default noise while routing expense facts", () => {
  const items = surfaceDynamicFacts({
    documentProfile: "full_lease",
    docIndex: {} as any,
    unmappedFacts: [
      makeFact({ category: "clause:default", value: "Control", sourceText: "\"Control\" shall mean ownership of at least fifty-one percent (51%).", sourcePage: 2, confidence: 0.96 }),
      makeFact({ category: "clause:party_identification", value: "Tenant: Example LLC", sourceText: "Tenant: Example LLC", sourcePage: 1, confidence: 0.96 }),
      makeFact({ category: "clause:operating_expense_recovery", value: "Tenant pays operating expenses", sourceText: "Tenant shall pay all operating expenses as Additional Rent.", sourcePage: 5, confidence: 0.92 }),
      makeFact({ category: "clause:cam_recoveries", value: "CAM included in gross rent", sourceText: "Monthly Rent includes all CAM charges.", sourcePage: 5, confidence: 0.91 }),
    ],
  });

  assertEquals(items.length, 2);
  assertEquals(items.map((item) => item.business_area), ["expenses_recoveries", "cam_rules"]);
  assertEquals(items.map((item) => item.display_tab), ["expenses_recoveries", "cam_rules"]);
});

Deno.test("evidence cleaner strips Azure table markup without losing lease text", () => {
  const cleaned = cleanEvidenceSnippet('</td> <td>Date:</td> <td>January 9, 2024</td> </tr> <tr> <td colspan="2">Premises containing approximately 1,110 rentable square feet.</td>');
  assertEquals(cleaned, "Date: January 9, 2024 Premises containing approximately 1,110 rentable square feet.");
});

Deno.test("rule extractor parses opening-recital ordinal lease dates", () => {
  assertEquals(parseDate("8 day of September 2020"), "2020-09-08");
  assertEquals(parseDate("8th day of September, 2020"), "2020-09-08");
});

Deno.test("fact mapper rejects Craven-style unrelated business field values", () => {
  const facts = [
    makeFact({ category: "clause:default", value: "costs of reletting", sourceText: "In addition to all other damages, Tenant will also pay to Landlord its costs of reletting which include reasonable costs and expenses.", sourcePage: 7, confidence: 0.97 }),
    makeFact({ category: "clause:delivery_possession", value: "AS IS", sourceText: "Tenant accepts the Premises AS IS and acknowledges no representations regarding condition.", sourcePage: 1, confidence: 0.93 }),
    makeFact({ category: "clause:repairs_maintenance", value: "good order, condition and repair", sourceText: "Tenant shall keep and maintain the Premises in good order, condition and repair.", sourcePage: 4, confidence: 0.99 }),
    makeFact({ category: "clause:signage", value: "landlord", sourceText: "Landlord may remove signage at Tenant's sole cost and expense.", sourcePage: 5, confidence: 0.95 }),
  ];

  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const fields = mapped.records[0]?.fields ?? {};
  assertEquals(fields.broker_name, undefined);
  assertEquals(fields.permitted_use, undefined);
  assertEquals(fields.responsibility_utilities, undefined);
  assertEquals(fields.responsibility_repairs, undefined);
});

Deno.test("fact mapper keeps Craven-style compatible source-backed use and expense facts", () => {
  const facts = [
    makeFact({ category: "clause:use_clause", value: "restaurant", sourceText: "6. Tenant's Use and Operation: The Demised Premises shall be used and occupied by Tenant solely for the operation of a restaurant and for no other use without Landlord's prior written consent.", sourcePage: 2, confidence: 0.98 }),
    makeFact({ category: "clause:taxes", value: "tenant", sourceText: "In addition to Tenant's proportionate share of real estate taxes, Tenant shall pay any and all sales, excise, gross receipts and other taxes levied during Tenant's occupancy.", sourcePage: 1, confidence: 0.95 }),
    makeFact({ category: "clause:insurance", value: true, sourceText: "Tenant shall keep in force throughout the Term a Commercial General Liability Insurance policy covering the Premises.", sourcePage: 5, confidence: 0.99 }),
  ];

  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const fields = mapped.records[0]?.fields ?? {};
  assertEquals(fields.permitted_use?.value, "restaurant");
  assertEquals(fields.responsibility_taxes?.value, "tenant");
  assertEquals(fields.tenant_insurance_required?.value, true);
});

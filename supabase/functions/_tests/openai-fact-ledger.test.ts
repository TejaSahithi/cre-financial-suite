// @ts-nocheck
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { computeProfileApprovalBlockers } from "../_shared/extraction/openai-fact-ledger/approval-blockers.ts";
import { runOpenAIFactLedgerPipeline } from "../_shared/extraction/openai-fact-ledger/orchestrator.ts";
import { __test__ as factLedgerExtractorTest } from "../_shared/extraction/openai-fact-ledger/fact-ledger-extractor.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";
import { chunkDocument } from "../_shared/extraction/chunker.ts";

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
      const responseText = callCount === 1
        ? JSON.stringify({ document_profile: "full_lease", confidence: 0.9, reasoning: "test fixture" })
        : JSON.stringify({
          facts: [
            { category: "clause:lease_term", value: "March 1, 2019", source_text: sourceText, source_page: 1, confidence: 0.91 },
            { category: "clause:lease_term", value: "December 31, 2023", source_text: sourceText, source_page: 1, confidence: 0.92 },
          ],
        });
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

Deno.test("runOpenAIFactLedgerPipeline: processes every generated text chunk by default", async () => {
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousMaxChunks = Deno.env.get("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.delete("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");

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
  }
});
Deno.test("runOpenAIFactLedgerPipeline: final chunk fact maps through canonical fields into ui_review_payload", async () => {
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousMaxChunks = Deno.env.get("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.delete("OPENAI_FACT_LEDGER_EMERGENCY_MAX_CHUNKS");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "2");

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

Deno.test("runOpenAIFactLedgerPipeline: one failed chunk preserves successful facts and reports partial diagnostics", async () => {
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "2");

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
  }
});
Deno.test("runOpenAIFactLedgerPipeline: execution budget guard pauses with continuation diagnostics after a completed batch", async () => {
  const previousOpenAIKey = Deno.env.get("OPENAI_API_KEY");
  const previousAzureEndpoint = Deno.env.get("AZURE_OPENAI_ENDPOINT");
  const previousConcurrency = Deno.env.get("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY");
  const previousReserve = Deno.env.get("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS");
  Deno.env.set("OPENAI_API_KEY", "sk-fake-openai-key-for-testing");
  Deno.env.delete("AZURE_OPENAI_ENDPOINT");
  Deno.env.set("OPENAI_FACT_LEDGER_CHUNK_CONCURRENCY", "1");
  Deno.env.set("OPENAI_FACT_LEDGER_DEADLINE_RESERVE_MS", "60000");

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
  }
});
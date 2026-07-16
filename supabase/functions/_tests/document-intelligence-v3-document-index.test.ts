// @ts-nocheck
// Phase 6 unit tests for the canonical-layout-backed vertex_fact_ledger
// document index (supabase/functions/_shared/extraction/vertex-fact-ledger/
// document-index-v3.ts). Pure-function tests only -- no DB, no network.
// Run: deno test --allow-env --allow-read --no-lock document-intelligence-v3-document-index.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  resolveDocumentIndex,
  buildCanonicalDocumentIndexFromLayout,
  enrichFactWithBlockEvidence,
} from "../_shared/extraction/vertex-fact-ledger/document-index-v3.ts";
import { buildCanonicalLayoutFromAzureLikeOutput } from "../_shared/extraction/document-intelligence-v3/canonical-layout.ts";

function azureLikeDoclingRaw() {
  return {
    extraction_method: "azure_layout",
    full_text: "[[PAGE 1]]\nLEASE AGREEMENT\n\n[[PAGE 2]]\nBase Rent is $5,000 per month.",
    page_count: 2,
    pages: [
      { page: 1, text: "LEASE AGREEMENT" },
      { page: 2, text: "Base Rent is $5,000 per month." },
    ],
    text_blocks: [
      { block_index: 0, type: "title", text: "LEASE AGREEMENT", page: 1 },
      { block_index: 1, type: "paragraph", text: "Base Rent is $5,000 per month.", page: 2 },
    ],
    tables: [],
    fields: [],
    warnings: [],
    raw_response: null,
    _metadata: {
      provider: "azure_document_intelligence",
      extraction_method: "azure_layout",
      api_version: "2024-11-30",
      page_markers_present: true,
      page_mapping_coverage: 1,
      raw_response_stored: false,
    },
  };
}

// ── Task H.1: canonical layout builds a document index with page-marked text ─

Deno.test("resolveDocumentIndex: strategy=canonical_layout builds an index with page-marked full text (Task H.1)", async () => {
  const result = await resolveDocumentIndex(azureLikeDoclingRaw(), { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "canonical_layout");
  assertEquals(result.fallbackReason, null);
  assert(result.index.fullText.includes("[[PAGE 1]]"));
  assert(result.index.fullText.includes("[[PAGE 2]]"));
  assertEquals(result.index.pageCount, 2);
});

// ── Task H.2: blocks preserved with block IDs and page numbers ──────────────

Deno.test("buildCanonicalDocumentIndexFromLayout: blocks are preserved with block_ids and page numbers (Task H.2)", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLikeDoclingRaw(), { uploadedFileId: "uf-1" });
  const index = buildCanonicalDocumentIndexFromLayout(layout);

  assertEquals(index.blockIds.length, 2);
  assert(index.blockIds.every((id) => typeof id === "string" && id.length > 0));
  assertEquals(index.canonicalLayout.pages[1].blocks[0].page_number, 2);
  assertEquals(index.canonicalLayout.pages[1].blocks[0].text, "Base Rent is $5,000 per month.");

  // doclingRaw projection must still work with the existing evidence-index
  // machinery -- text_blocks carry real page numbers.
  assert(Array.isArray(index.doclingRaw.text_blocks));
  assertEquals(index.doclingRaw.text_blocks.length, 2);
});

Deno.test("buildCanonicalDocumentIndexFromLayout: table/figure/signature placeholders are present (empty when the source has none) (Task H.6)", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLikeDoclingRaw(), { uploadedFileId: "uf-1" });
  const index = buildCanonicalDocumentIndexFromLayout(layout);
  assertEquals(index.tablePlaceholders, []);
  assertEquals(index.figurePlaceholders, []);
  assertEquals(index.signaturePlaceholders, []);
});

// ── Task H.3: evidence anchors include page/source_text ──────────────────────

Deno.test("enrichFactWithBlockEvidence: a fact matching a real block gets page/source_text/block_ids (Task H.3)", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLikeDoclingRaw(), { uploadedFileId: "uf-1" });
  const fact = { category: "clause:rent_escalation", value: 5000, sourceText: "Base Rent is $5,000 per month.", sourcePage: 2, confidence: 0.9 };
  const enriched = enrichFactWithBlockEvidence(fact, layout);

  assertEquals(enriched.sourcePage, 2);
  assertEquals(enriched.sourceText, "Base Rent is $5,000 per month.");
  assertEquals(enriched.blockIds.length, 1);
  assertEquals(enriched.supportType, "direct_quote");
  assertEquals(enriched.polygon, []); // honest empty -- docling_raw carries no polygon data
});

Deno.test("enrichFactWithBlockEvidence: never fabricates -- a non-matching fact gets empty blockIds/polygon and null supportType", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLikeDoclingRaw(), { uploadedFileId: "uf-1" });
  const fact = { category: "clause:default", value: "x", sourceText: "This text does not appear anywhere in the document.", sourcePage: 1, confidence: 0.5 };
  const enriched = enrichFactWithBlockEvidence(fact, layout);
  assertEquals(enriched.blockIds, []);
  assertEquals(enriched.polygon, []);
  assertEquals(enriched.supportType, null);
});

Deno.test("enrichFactWithBlockEvidence: no layout / no sourcePage / no sourceText all degrade to empty, never throw", () => {
  const fact = { category: "clause:default", value: "x", sourceText: "hello", sourcePage: 1, confidence: 0.5 };
  assertEquals(enrichFactWithBlockEvidence(fact, null).blockIds, []);
  assertEquals(enrichFactWithBlockEvidence({ ...fact, sourcePage: null }, { pages: [] } as any).blockIds, []);
  assertEquals(enrichFactWithBlockEvidence({ ...fact, sourceText: null }, { pages: [] } as any).blockIds, []);
});

// ── Task H.4: missing canonical layout falls back to legacy path ────────────

Deno.test("resolveDocumentIndex: a docling_raw with no pages/text still synthesizes a minimal canonical layout (the adapter never loses text, by design)", async () => {
  const degenerate = { full_text: "", pages: [], text_blocks: [], tables: [] };
  const result = await resolveDocumentIndex(degenerate, { strategy: "canonical_layout" });
  // Phase 5's adapter deliberately always synthesizes at least one page
  // rather than returning zero pages -- so this is NOT the fallback case;
  // canonical_layout still resolves successfully with an empty index.
  assertEquals(result.indexSource, "canonical_layout");
  assertEquals(result.fallbackReason, null);
  assertEquals(result.index.fullText, "");
});

Deno.test("resolveDocumentIndex: strategy=canonical_layout falls back to legacy_evidence_index when the layout build genuinely throws (Task H.4)", async () => {
  // Fails only the canonical path's content_hash computation (Phase 5's
  // sha256Hex, via crypto.subtle.digest) -- the legacy buildCanonicalDocumentIndex/
  // buildEvidenceIndex path never calls crypto.subtle at all, so this
  // isolates a genuine "canonical-specific failure, legacy still succeeds"
  // scenario rather than breaking both paths identically.
  const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
  crypto.subtle.digest = () => {
    throw new Error("simulated content-hash failure");
  };
  try {
    const result = await resolveDocumentIndex(azureLikeDoclingRaw(), { strategy: "canonical_layout" });
    assertEquals(result.indexSource, "legacy_evidence_index");
    assert(result.fallbackReason?.startsWith("canonical_layout_failed:"));
    // Never throws -- resolves to a real, usable index via the legacy path.
    assert(result.index.fullText.includes("Base Rent is $5,000 per month."));
  } finally {
    crypto.subtle.digest = originalDigest;
  }
});

Deno.test("resolveDocumentIndex: strategy=legacy_evidence_index always uses the legacy path regardless of the flag", async () => {
  const result = await resolveDocumentIndex(azureLikeDoclingRaw(), { strategy: "legacy_evidence_index" });
  assertEquals(result.indexSource, "legacy_evidence_index");
  assertEquals(result.fallbackReason, null);
});

Deno.test("resolveDocumentIndex: no explicit strategy and the flag unset uses legacy_evidence_index by default (Task H.7 groundwork)", async () => {
  Deno.env.delete("ENABLE_DOCUMENT_INTELLIGENCE_V3");
  const result = await resolveDocumentIndex(azureLikeDoclingRaw());
  assertEquals(result.indexSource, "legacy_evidence_index");
  assertEquals(result.fallbackReason, null);
});

// ── Task H.5: no raw Azure response required ──────────────────────────────────

Deno.test("resolveDocumentIndex: works identically with raw_response=null / raw_response_stored=false (Task H.5)", async () => {
  const raw = azureLikeDoclingRaw();
  raw.raw_response = null;
  raw._metadata.raw_response_stored = false;
  const result = await resolveDocumentIndex(raw, { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "canonical_layout");
  assert(result.index.fullText.includes("Base Rent"));
});

// ── Task H.6: empty figures/signatures/tables do not crash ──────────────────

Deno.test("resolveDocumentIndex: a docling_raw with tables but no headers/rows does not crash", async () => {
  const raw = azureLikeDoclingRaw();
  raw.tables = [{ table_index: 0, headers: [], rows: [], markdown: "" }];
  const result = await resolveDocumentIndex(raw, { strategy: "canonical_layout" });
  assertEquals(result.indexSource, "canonical_layout");
  const layoutIndex = result.index as any;
  assertEquals(layoutIndex.tablePlaceholders.length, 1);
});

// ── Phase 1 compatibility regression ─────────────────────────────────────────
// document-index-v3.ts imports buildCanonicalLayoutFromAzureLikeOutput
// unchanged (Phase 1, Task B: this file was NOT edited -- it still resolves
// via the deprecated alias). This test proves that keeps working exactly as
// before the canonical-layout.ts rename/contract-extension.

Deno.test("Phase 1 compatibility: buildCanonicalDocumentIndexFromLayout behavior is unchanged after canonical-layout.ts's Phase 1 evolution", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLikeDoclingRaw(), { uploadedFileId: "uf-1" });
  // New Phase 1 fields exist on the layout but must not change this index's shape.
  assert(typeof layout.schema_version === "number");
  const index = buildCanonicalDocumentIndexFromLayout(layout);
  assertEquals(index.blockIds.length, 2);
  assertEquals(index.pageCount, 2);
  assert(index.fullText.includes("Base Rent is $5,000 per month."));
});

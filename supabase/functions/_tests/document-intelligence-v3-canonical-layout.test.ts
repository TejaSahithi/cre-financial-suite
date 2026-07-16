// @ts-nocheck
// Phase 5 unit tests for the Document Intelligence v3 canonical layout model
// (supabase/functions/_shared/extraction/document-intelligence-v3/canonical-layout.ts).
// Pure-function tests only -- no DB, no network. Fixtures match the real,
// confirmed docling_raw shape azure-layout-adapter.ts persists (per
// docs/document-intelligence-v3-baseline.md).
// Run: deno test --allow-env --allow-read --no-lock document-intelligence-v3-canonical-layout.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  buildCanonicalLayoutFromAzureLikeOutput,
  summarizeCanonicalLayout,
  buildEvidenceAnchor,
} from "../_shared/extraction/document-intelligence-v3/canonical-layout.ts";

function azureLike3PageDoclingRaw(overrides: Record<string, unknown> = {}) {
  return {
    extraction_method: "azure_layout",
    full_text:
      "[[PAGE 1]]\nLEASE AGREEMENT\n\nThis Lease is between Landlord and Tenant.\n\n" +
      "[[PAGE 2]]\nSection 2. Rent.\n\nBase Rent is $5,000 per month.\n\n" +
      "[[PAGE 3]]\nSignatures.\n\nLandlord: ___  Tenant: ___",
    markdown: "LEASE AGREEMENT...",
    page_count: 3,
    pages: [
      { page: 1, text: "LEASE AGREEMENT\n\nThis Lease is between Landlord and Tenant.", width: 612, height: 792, unit: "pixel" },
      { page: 2, text: "Section 2. Rent.\n\nBase Rent is $5,000 per month.", width: 612, height: 792, unit: "pixel" },
      { page: 3, text: "Signatures.\n\nLandlord: ___  Tenant: ___", width: 612, height: 792, unit: "pixel" },
    ],
    text_blocks: [
      { block_index: 0, type: "title", text: "LEASE AGREEMENT", page: 1, span: { offset: 0, length: 16 } },
      { block_index: 1, type: "paragraph", text: "This Lease is between Landlord and Tenant.", page: 1 },
      { block_index: 2, type: "paragraph", text: "Section 2. Rent.", page: 2 },
      { block_index: 3, type: "paragraph", text: "Base Rent is $5,000 per month.", page: 2 },
      { block_index: 4, type: "paragraph", text: "Signatures.", page: 3 },
    ],
    tables: [
      { table_index: 0, headers: ["Item", "Amount"], rows: [["Base Rent", "$5,000"]], markdown: "Item\tAmount\nBase Rent\t$5,000" },
    ],
    fields: [],
    warnings: [],
    raw_response: null,
    raw_response_summary: {
      provider: "azure_document_intelligence",
      extraction_method: "azure_layout",
      api_version: "2024-11-30",
      page_count: 3,
      table_count: 1,
      text_block_count: 5,
      raw_response_stored: false,
    },
    _metadata: {
      provider: "azure_document_intelligence",
      extraction_method: "azure_layout",
      model_id: null,
      api_version: "2024-11-30",
      output_format: "markdown",
      content_format: "markdown",
      raw_response_stored: false,
      layout_contract_version: "document_layout_v1",
      canonical_layout_present: true,
      page_markers_present: true,
      page_marker_strategy: "content_spans",
      page_mapping_coverage: 1,
    },
    ...overrides,
  };
}

// ── Task G.1: builds a CanonicalDocumentLayout from an Azure-like 3-page parse ──

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: Azure-like 3-page parse creates a CanonicalDocumentLayout (Task G.1)", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLike3PageDoclingRaw(), {
    uploadedFileId: "uf-1",
    orgId: "org-1",
  });

  assertEquals(layout.uploaded_file_id, "uf-1");
  assertEquals(layout.org_id, "org-1");
  assertEquals(layout.document_id, "uf-1");
  assertEquals(layout.layout_provider, "azure_document_intelligence");
  assertEquals(layout.layout_api_version, "2024-11-30");
  assertEquals(layout.pages.length, 3);
  assertEquals(layout.pages.map((p) => p.page_number), [1, 2, 3]);
  assert(layout.content_hash?.startsWith("sha256:"), "content_hash should be a real sha256 digest, not null");
});

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: reuses an existingCanonicalLayout when supplied, without recomputation", async () => {
  const cached = await buildCanonicalLayoutFromAzureLikeOutput(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  const reused = await buildCanonicalLayoutFromAzureLikeOutput(
    { full_text: "should be ignored" },
    { uploadedFileId: "uf-2", existingCanonicalLayout: cached },
  );
  assertEquals(reused, cached);
});

// ── Task G.2: page-marked text ────────────────────────────────────────────────

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: text_projection contains [[PAGE 1]], [[PAGE 2]], [[PAGE 3]] (Task G.2)", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  assert(layout.text_projection.includes("[[PAGE 1]]"));
  assert(layout.text_projection.includes("[[PAGE 2]]"));
  assert(layout.text_projection.includes("[[PAGE 3]]"));
  assert(layout.text_projection.includes("Base Rent is $5,000 per month."), "must preserve real page 2 text, not just markers");
});

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: synthesizes [[PAGE n]] markers from per-page text when full_text has none (unmapped legacy parser output)", async () => {
  const doclingRaw = {
    extraction_method: "docling",
    full_text: "Page one text. Page two text.",
    page_count: 2,
    pages: [
      { page: 1, text: "Page one text." },
      { page: 2, text: "Page two text." },
    ],
    text_blocks: [],
    tables: [],
    _metadata: { page_markers_present: false },
  };
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(doclingRaw, { uploadedFileId: "uf-3" });
  assert(layout.text_projection.includes("[[PAGE 1]]\nPage one text."));
  assert(layout.text_projection.includes("[[PAGE 2]]\nPage two text."));
});

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: never loses text -- a single unmapped blob still becomes [[PAGE 1]]-wrapped text_projection", async () => {
  const doclingRaw = { extraction_method: "docling", full_text: "Only unstructured text here.", pages: [], text_blocks: [], tables: [] };
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(doclingRaw, { uploadedFileId: "uf-4" });
  assertEquals(layout.text_projection, "[[PAGE 1]]\nOnly unstructured text here.");
  assertEquals(layout.pages.length, 1);
  assertEquals(layout.pages[0].plain_text, "");
});

// ── Task G.3: page count and full text chars preserved ──────────────────────

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: page_count and full_text_chars are preserved (Task G.3)", async () => {
  const raw = azureLike3PageDoclingRaw();
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(raw, { uploadedFileId: "uf-1" });
  assertEquals(layout.page_count, 3);
  assert(layout.full_text_chars > 0);
  assertEquals(layout.full_text_chars, String(raw.full_text).replace(/\s+/g, " ").trim().length);
});

// ── Task G.4: missing raw Azure response still works ─────────────────────────

Deno.test("buildCanonicalLayoutFromAzureLikeOutput: works with raw_response=null / raw_response_stored=false (Task G.4)", async () => {
  const raw = azureLike3PageDoclingRaw({ raw_response: null });
  raw._metadata.raw_response_stored = false;
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(raw, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages.length, 3);
  assert(layout.text_projection.includes("[[PAGE 2]]"));
  // Never reads raw_response at all -- deleting it entirely must not change the result.
  const { raw_response, ...rawWithoutResponse } = raw;
  const layoutWithoutField = await buildCanonicalLayoutFromAzureLikeOutput(rawWithoutResponse, { uploadedFileId: "uf-1" });
  assertEquals(layoutWithoutField.pages.length, layout.pages.length);
  assertEquals(layoutWithoutField.text_projection, layout.text_projection);
});

// ── Task G.5: empty page text creates a warning, not a crash ────────────────

Deno.test("summarizeCanonicalLayout: an empty page's text produces a warning, never throws (Task G.5)", async () => {
  const raw = azureLike3PageDoclingRaw();
  raw.pages[1].text = ""; // page 2 has no text
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(raw, { uploadedFileId: "uf-1" });
  const summary = summarizeCanonicalLayout(layout);
  assertEquals(summary.pages_with_text, 2);
  assert(summary.warnings.some((w) => w === "empty_page_text:page_2"));
});

Deno.test("summarizeCanonicalLayout: null layout degrades to a zeroed summary with a warning, never throws", () => {
  const summary = summarizeCanonicalLayout(null);
  assertEquals(summary.page_count, null);
  assertEquals(summary.warnings, ["no_canonical_layout"]);
});

// ── Task G.6: layout summary reports counts ──────────────────────────────────

Deno.test("summarizeCanonicalLayout: reports page/block/table/figure/signature counts (Task G.6)", async () => {
  const layout = await buildCanonicalLayoutFromAzureLikeOutput(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  const summary = summarizeCanonicalLayout(layout);

  assertEquals(summary.layout_provider, "azure_document_intelligence");
  assertEquals(summary.api_version, "2024-11-30");
  assertEquals(summary.page_count, 3);
  assertEquals(summary.pages_with_text, 3);
  assertEquals(summary.text_block_count, 5);
  assertEquals(summary.table_count, 1);
  assertEquals(summary.figure_count, 0);
  assertEquals(summary.signature_region_count, 0);
  assert(summary.page_markers_present);
  assertEquals(summary.page_mapping_coverage, 1);
  assertEquals(summary.warnings, []);
});

// ── Task G.7: evidence anchors preserve page/source_text ─────────────────────

Deno.test("buildEvidenceAnchor: preserves page, source_text, and support_type (Task G.7)", () => {
  const anchor = buildEvidenceAnchor({
    page: 2,
    sourceText: "Base Rent is $5,000 per month.",
    blockIds: ["block-3"],
    supportType: "direct_quote",
  });
  assertEquals(anchor.page, 2);
  assertEquals(anchor.source_text, "Base Rent is $5,000 per month.");
  assertEquals(anchor.block_ids, ["block-3"]);
  assertEquals(anchor.support_type, "direct_quote");
  assertEquals(anchor.table_id, null);
  assertEquals(anchor.cell_ids, []);
});

Deno.test("buildEvidenceAnchor: table_cell support_type carries table_id and cell_ids", () => {
  const anchor = buildEvidenceAnchor({
    page: 2,
    sourceText: "$5,000",
    tableId: "table-0",
    cellIds: ["table-0-r1-c1"],
    supportType: "table_cell",
  });
  assertEquals(anchor.table_id, "table-0");
  assertEquals(anchor.cell_ids, ["table-0-r1-c1"]);
  assertEquals(anchor.support_type, "table_cell");
});

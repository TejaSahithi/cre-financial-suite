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
  legacyDoclingToCanonicalLayout,
  summarizeCanonicalLayout,
  buildEvidenceAnchor,
  validateCanonicalLayout,
  CANONICAL_LAYOUT_SCHEMA_VERSION,
  MINIMUM_SUPPORTED_SCHEMA_VERSION,
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

// ── Phase 1, Task E: legacy compatibility regression ─────────────────────────
// Proves the Phase 1 rename (buildCanonicalLayoutFromAzureLikeOutput ->
// legacyDoclingToCanonicalLayout) changed nothing an existing consumer reads.

Deno.test("Phase 1 compatibility: buildCanonicalLayoutFromAzureLikeOutput is the exact same function reference as legacyDoclingToCanonicalLayout", () => {
  assertEquals(buildCanonicalLayoutFromAzureLikeOutput, legacyDoclingToCanonicalLayout);
});

Deno.test("Phase 1 compatibility: alias and renamed function produce deep-equal output for the same legacy fixture", async () => {
  const raw = azureLike3PageDoclingRaw();
  const viaAlias = await buildCanonicalLayoutFromAzureLikeOutput(raw, { uploadedFileId: "uf-1", orgId: "org-1", contentHash: "sha256:fixed" });
  const viaRenamed = await legacyDoclingToCanonicalLayout(raw, { uploadedFileId: "uf-1", orgId: "org-1", contentHash: "sha256:fixed" });
  assertEquals(viaAlias, viaRenamed);
});

Deno.test("Phase 1 compatibility: content_hash is exactly unchanged for a fixed contentHash context (document-index/side-write idempotency input)", async () => {
  const raw = azureLike3PageDoclingRaw();
  const layout = await legacyDoclingToCanonicalLayout(raw, { uploadedFileId: "uf-1", contentHash: "sha256:deterministic-fixture-hash" });
  assertEquals(layout.content_hash, "sha256:deterministic-fixture-hash");
});

Deno.test("Phase 1 compatibility: summarizeCanonicalLayout output is unchanged by the new optional fields (schema_version/provider present but unread)", async () => {
  const raw = azureLike3PageDoclingRaw();
  const layout = await legacyDoclingToCanonicalLayout(raw, { uploadedFileId: "uf-1" });
  assert(typeof layout.schema_version === "number", "schema_version must be set on every newly-built layout");
  assertEquals(layout.provider, "legacy_docling_compatibility");

  const summary = summarizeCanonicalLayout(layout);
  // Same assertions as the original Task G.6 test -- summarizeCanonicalLayout
  // must not have started reading (or being affected by) the new fields.
  assertEquals(summary.layout_provider, "azure_document_intelligence");
  assertEquals(summary.page_count, 3);
  assertEquals(summary.table_count, 1);
  assertEquals(summary.warnings, []);
});

Deno.test("Phase 1 compatibility: new optional fields are never set to an explicit undefined value on the legacy path (would corrupt any JSON.stringify-based hashing/equality)", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  for (const key of ["provider_model_id", "provider_api_version", "warnings"]) {
    assertFalse(Object.prototype.hasOwnProperty.call(layout, key), `legacy layout should omit ${key} entirely rather than set it to undefined`);
  }
});

// ── Phase 1, Task A: schema version, compatibility policy, invariants ────────

Deno.test("Phase 1 contract: CANONICAL_LAYOUT_SCHEMA_VERSION and MINIMUM_SUPPORTED_SCHEMA_VERSION are stable, positive integers with version >= minimum", () => {
  assert(Number.isInteger(CANONICAL_LAYOUT_SCHEMA_VERSION) && CANONICAL_LAYOUT_SCHEMA_VERSION >= 1);
  assert(Number.isInteger(MINIMUM_SUPPORTED_SCHEMA_VERSION) && MINIMUM_SUPPORTED_SCHEMA_VERSION >= 1);
  assert(CANONICAL_LAYOUT_SCHEMA_VERSION >= MINIMUM_SUPPORTED_SCHEMA_VERSION);
});

Deno.test("validateCanonicalLayout: a well-formed legacy-built layout is valid with no fatal errors", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  const result = validateCanonicalLayout(layout);
  assertEquals(result.errors, []);
  assert(result.valid);
});

Deno.test("validateCanonicalLayout: null layout is fatal-invalid, never throws", () => {
  const result = validateCanonicalLayout(null);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "missing_layout" && e.severity === "fatal"));
});

Deno.test("validateCanonicalLayout: duplicate page_number is a fatal invariant violation", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[1] = { ...layout.pages[1], page_number: layout.pages[0].page_number };
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "duplicate_page_number"));
});

Deno.test("validateCanonicalLayout: duplicate block_id across pages is a fatal invariant violation", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[1].blocks = [{ ...layout.pages[1].blocks[0], block_id: layout.pages[0].blocks[0].block_id }];
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "duplicate_block_id"));
});

Deno.test("validateCanonicalLayout: duplicate reading_order_index within one page is a fatal invariant violation", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[0].blocks = [
    { ...layout.pages[0].blocks[0], block_id: "b-a", reading_order_index: 0 },
    { ...layout.pages[0].blocks[0], block_id: "b-b", reading_order_index: 0 },
  ];
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "duplicate_reading_order_index"));
});

Deno.test("validateCanonicalLayout: bounding_regions referencing a nonexistent page is a fatal invariant violation", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[0].blocks[0].bounding_regions = [{ page_number: 999, polygon: [] }];
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "bounding_region_unknown_page"));
});

Deno.test("validateCanonicalLayout: overlapping spans within one block is a fatal invariant violation", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[0].blocks[0].spans = [{ offset: 0, length: 10 }, { offset: 5, length: 10 }];
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "overlapping_spans"));
});

Deno.test("validateCanonicalLayout: a malformed (odd-length) polygon is a recoverable warning, not fatal", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[0].blocks[0].polygon = [1, 2, 3];
  const result = validateCanonicalLayout(layout);
  assert(result.valid, "a malformed polygon must not invalidate the layout");
  assert(result.warnings.some((w) => w.code === "malformed_polygon" && w.severity === "recoverable"));
});

Deno.test("validateCanonicalLayout: a non-finite polygon coordinate is a recoverable warning, not fatal", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.pages[0].blocks[0].polygon = [1, 2, Infinity, 4];
  const result = validateCanonicalLayout(layout);
  assert(result.valid);
  assert(result.warnings.some((w) => w.code === "malformed_polygon"));
});

Deno.test("validateCanonicalLayout: inconsistent table dimensions (row_count smaller than a cell's row_index) is fatal", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  const table = layout.pages.flatMap((p) => p.tables)[0];
  table.row_count = 0;
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "table_dimensions_conflict"));
});

Deno.test("validateCanonicalLayout: page_count mismatch between declared and actual pages is fatal", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  layout.page_count = 999;
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "page_count_mismatch"));
});

Deno.test("validateCanonicalLayout: missing schema_version is a fatal invariant violation", async () => {
  const layout = await legacyDoclingToCanonicalLayout(azureLike3PageDoclingRaw(), { uploadedFileId: "uf-1" });
  delete layout.schema_version;
  const result = validateCanonicalLayout(layout);
  assertFalse(result.valid);
  assert(result.errors.some((e) => e.code === "missing_schema_version"));
});

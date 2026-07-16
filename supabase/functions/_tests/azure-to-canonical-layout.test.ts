// @ts-nocheck
// Phase 1 unit tests for the Azure-native canonical layout adapter
// (supabase/functions/_shared/extraction/azure/azure-to-canonical-layout.ts).
// Pure-function tests only -- no DB, no network, no live Azure call. The
// richer fixture is a hand-built, synthetic document mirroring Azure's
// published Layout API response schema (not real customer content) at
// fixtures/azure-layout-sanitized.json.
// Run: deno test --allow-env --allow-read --no-lock azure-to-canonical-layout.test.ts

import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { azureAnalyzeResultToCanonicalLayout } from "../_shared/extraction/azure/azure-to-canonical-layout.ts";
import { validateCanonicalLayout } from "../_shared/extraction/document-intelligence-v3/canonical-layout.ts";

const fixtureText = await Deno.readTextFile(new URL("./fixtures/azure-layout-sanitized.json", import.meta.url));
const sanitizedFixture = JSON.parse(fixtureText);

function synthetic2PageAnalyzeResult(overrides: Record<string, unknown> = {}) {
  const content = "Hello world.\nSecond page text.\n";
  return {
    apiVersion: "2024-11-30",
    modelId: "prebuilt-layout",
    content,
    pages: [
      { pageNumber: 1, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 0, length: 13 }] },
      { pageNumber: 2, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 13, length: 19 }] },
    ],
    paragraphs: [
      { content: "Hello world.", boundingRegions: [{ pageNumber: 1, polygon: [1, 1, 2, 1, 2, 2, 1, 2] }], spans: [{ offset: 0, length: 12 }] },
      { content: "Second page text.", boundingRegions: [{ pageNumber: 2, polygon: [1, 1, 2, 1, 2, 2, 1, 2] }], spans: [{ offset: 13, length: 18 }] },
    ],
    tables: [],
    ...overrides,
  };
}

// ── Positive coverage against the richer sanitized fixture ──────────────────

Deno.test("azureAnalyzeResultToCanonicalLayout: page count matches the fixture", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(layout.page_count, 2);
  assertEquals(layout.pages.map((p) => p.page_number), [1, 2]);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: text_projection is the authoritative top-level content, verbatim (no synthesized markers)", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(layout.text_projection, sanitizedFixture.content);
  assert(layout.text_projection.includes("Café Properties"), "must preserve Unicode content verbatim");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: page plain_text is reconstructed from real page spans, matching each page's slice of content", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  const page1Span = sanitizedFixture.pages[0].spans[0];
  const expectedPage1Text = sanitizedFixture.content.slice(page1Span.offset, page1Span.offset + page1Span.length);
  assertEquals(layout.pages[0].plain_text, expectedPage1Text);
  assert(layout.pages[0].plain_text.includes("LEASE AGREEMENT"));
  assert(layout.pages[1].plain_text.includes("Base Rent is $5,000.00"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: paragraph precedence -- blocks come from paragraphs, not lines, when paragraphs are present (no duplication)", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  // The fixture has 2 paragraphs per page AND 2 lines per page -- if both
  // were unioned this would be 4 blocks per page instead of 2.
  assertEquals(layout.pages[0].blocks.length, 2);
  assertEquals(layout.pages[1].blocks.length, 2);
  assertEquals(layout.pages[0].blocks[0].kind, "title");
  assertEquals(layout.pages[0].blocks[0].text, "LEASE AGREEMENT");
  assertEquals(layout.pages[0].blocks[0].role, "title");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: reading order is stable, deterministic, and per-page unique via reading_order_index and block_id", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].blocks.map((b) => b.reading_order_index), [0, 1]);
  assertEquals(layout.pages[0].blocks.map((b) => b.block_id), ["page-1-block-0", "page-1-block-1"]);
  assertEquals(layout.pages[1].blocks.map((b) => b.block_id), ["page-2-block-0", "page-2-block-1"]);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: table dimensions, merged cells, and cell polygons are preserved", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  const table = layout.pages.flatMap((p) => p.tables)[0];
  assertEquals(table.row_count, 4);
  assertEquals(table.column_count, 2);
  assertEquals(table.rows, 4);

  const headerCell = table.cells.find((c) => c.row_index === 0 && c.column_index === 0);
  assertEquals(headerCell.text, "Rent Schedule");
  assertEquals(headerCell.column_span, 2);
  assert(Array.isArray(headerCell.polygon) && headerCell.polygon.length === 8);
  assert(headerCell.polygon.every((n) => Number.isFinite(n)));

  const rentCell = table.cells.find((c) => c.text === "$5,000.00");
  assertEquals(rentCell.row_index, 2);
  assertEquals(rentCell.column_index, 1);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: all bounding regions are preserved on the table, not just the first", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  const table = layout.pages.flatMap((p) => p.tables)[0];
  assertEquals(table.bounding_regions.length, sanitizedFixture.tables[0].boundingRegions.length);
  assertEquals(table.polygon, sanitizedFixture.tables[0].boundingRegions[0].polygon);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: spans are preserved on blocks", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  const titleBlock = layout.pages[0].blocks[0];
  assertEquals(titleBlock.spans, sanitizedFixture.paragraphs[0].spans);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: page_unit is preserved", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].page_unit, "inch");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: schema_version, provider, provider_model_id, provider_api_version, metadata are populated", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, {
    uploadedFileId: "uf-1",
    orgId: "org-1",
    modelId: "prebuilt-layout",
    apiVersion: "2024-11-30",
  });
  assert(typeof layout.schema_version === "number");
  assertEquals(layout.provider, "azure_document_intelligence");
  assertEquals(layout.provider_model_id, "prebuilt-layout");
  assertEquals(layout.provider_api_version, "2024-11-30");
  assertEquals(layout.layout_provider, "azure_document_intelligence");
  assertEquals(layout.metadata.paragraph_count, 4);
  assertEquals(layout.metadata.table_count, 1);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: falls back to analyzeResult.modelId/apiVersion when context omits them", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(layout.provider_model_id, "prebuilt-layout");
  assertEquals(layout.provider_api_version, "2024-11-30");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: the sanitized fixture produces no warnings and passes validateCanonicalLayout with zero errors", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(layout.warnings, []);
  const result = validateCanonicalLayout(layout);
  assertEquals(result.errors, []);
  assertEquals(result.warnings, []);
  assert(result.valid);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: deterministic -- calling twice on the same input produces deep-equal output", () => {
  const first = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  const second = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  assertEquals(first, second);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: no Azure-specific raw field names leak into the canonical output", () => {
  const layout = azureAnalyzeResultToCanonicalLayout(sanitizedFixture, { uploadedFileId: "uf-1" });
  const serialized = JSON.stringify(layout);
  for (const azureKey of ['"boundingRegions"', '"pageNumber"', '"rowIndex"', '"columnIndex"', '"rowSpan"', '"columnSpan"']) {
    assertFalse(serialized.includes(azureKey), `canonical output must not contain the raw Azure key ${azureKey}`);
  }
});

// ── Edge cases (Task G) ───────────────────────────────────────────────────────

Deno.test("azureAnalyzeResultToCanonicalLayout: null/undefined analyzeResult is fatal-warned, never throws", () => {
  for (const input of [null, undefined]) {
    const layout = azureAnalyzeResultToCanonicalLayout(input as any, { uploadedFileId: "uf-1" });
    assertEquals(layout.page_count, 0);
    assertEquals(layout.pages, []);
    assert(layout.warnings.some((w) => w.code === "missing_analyze_result" && w.severity === "fatal"));
    assert(typeof layout.schema_version === "number");
  }
});

Deno.test("azureAnalyzeResultToCanonicalLayout: empty result (no content, no pages, no paragraphs, no tables) degrades cleanly", () => {
  const layout = azureAnalyzeResultToCanonicalLayout({ content: "", pages: [], paragraphs: [], tables: [] }, { uploadedFileId: "uf-1" });
  assertEquals(layout.page_count, 0);
  assertEquals(layout.pages, []);
  assertEquals(layout.text_projection, "");
  assert(layout.warnings.some((w) => w.code === "empty_content"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: zero-page response is not the same as null -- schema_version/provider still populated", () => {
  const layout = azureAnalyzeResultToCanonicalLayout({ content: "" }, { uploadedFileId: "uf-1" });
  assertEquals(layout.page_count, 0);
  assertEquals(layout.provider, "azure_document_intelligence");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: missing pages[] entirely -- a paragraph referencing a real page is synthesized into a page, not dropped", () => {
  const result = {
    content: "Hello world.",
    paragraphs: [{ content: "Hello world.", boundingRegions: [{ pageNumber: 1, polygon: [] }], spans: [{ offset: 0, length: 12 }] }],
    tables: [],
  };
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages.length, 1);
  assertEquals(layout.pages[0].page_number, 1);
  assertEquals(layout.pages[0].blocks[0].text, "Hello world.");
  assert(layout.warnings.some((w) => w.code === "page_synthesized_from_content"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: missing top-level content -- plain_text/text_projection stay honestly empty, never fabricated", () => {
  const result = { content: undefined, pages: [{ pageNumber: 1 }], paragraphs: [], tables: [] };
  const layout = azureAnalyzeResultToCanonicalLayout(result as any, { uploadedFileId: "uf-1" });
  assertEquals(layout.text_projection, "");
  assertEquals(layout.pages[0].plain_text, "");
  assert(layout.warnings.some((w) => w.code === "empty_content"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: page without spans falls back to joined line text for plain_text, with a recoverable warning", () => {
  const result = {
    content: "irrelevant authoritative text unrelated to the line content",
    pages: [{ pageNumber: 1, lines: [{ content: "Line one." }, { content: "Line two." }] }],
    paragraphs: [],
    tables: [],
  };
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].plain_text, "Line one.\nLine two.");
  assert(layout.warnings.some((w) => w.code === "page_text_from_lines_fallback"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: paragraphs absent, lines present -- blocks are built from lines (kind='line')", () => {
  const result = {
    content: "Line one. Line two.",
    pages: [{
      pageNumber: 1,
      spans: [{ offset: 0, length: 20 }],
      lines: [
        { content: "Line one.", polygon: [1, 1, 2, 1, 2, 2, 1, 2], spans: [{ offset: 0, length: 9 }] },
        { content: "Line two.", polygon: [1, 3, 2, 3, 2, 4, 1, 4], spans: [{ offset: 10, length: 9 }] },
      ],
    }],
    paragraphs: [],
    tables: [],
  };
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].blocks.length, 2);
  assertEquals(layout.pages[0].blocks[0].kind, "line");
  assertEquals(layout.pages[0].blocks[0].text, "Line one.");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: paragraphs and lines both present -- lines are never unioned in (no duplication)", () => {
  const result = synthetic2PageAnalyzeResult({
    pages: [
      { pageNumber: 1, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 0, length: 13 }], lines: [{ content: "Hello world." }, { content: "extra line not in paragraphs" }] },
      { pageNumber: 2, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 13, length: 19 }] },
    ],
  });
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  // 1 paragraph on page 1, 2 lines on page 1 -- must stay at 1 block, not 3.
  assertEquals(layout.pages[0].blocks.length, 1);
  assertEquals(layout.pages[0].blocks[0].kind, "paragraph");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: malformed (odd-length) polygon and non-finite coordinates pass through honestly and are flagged recoverable by validateCanonicalLayout, not by the adapter", () => {
  const result = synthetic2PageAnalyzeResult();
  result.paragraphs[0].boundingRegions[0].polygon = [1, 2, 3]; // odd length
  result.paragraphs[1].boundingRegions[0].polygon = [1, 2, Infinity, 4]; // non-finite
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  // The adapter itself never validates geometry -- that's a separate stage.
  assertEquals(layout.pages[0].blocks[0].polygon, [1, 2, 3]);

  const validation = validateCanonicalLayout(layout);
  assert(validation.valid, "malformed polygons must not invalidate the layout");
  // Each malformed paragraph is flagged twice: once via the first-region
  // `polygon` compatibility field and once via the full `bounding_regions`
  // list -- both are real, independently-typed fields the validator checks.
  assertEquals(validation.warnings.filter((w) => w.code === "malformed_polygon").length, 4);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: invalid (non-positive) page number is preserved as given, not coerced or dropped", () => {
  const result = {
    content: "Text on a weird page.",
    pages: [{ pageNumber: 0, spans: [{ offset: 0, length: 22 }] }],
    paragraphs: [{ content: "Text on a weird page.", boundingRegions: [{ pageNumber: 0, polygon: [] }], spans: [{ offset: 0, length: 22 }] }],
    tables: [],
  };
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].page_number, 0);
  assertEquals(layout.pages[0].blocks[0].page_number, 0);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: out-of-range span (offset+length exceeds content length) passes through honestly and is fatal-flagged by validateCanonicalLayout", () => {
  const result = synthetic2PageAnalyzeResult();
  result.paragraphs[0].spans = [{ offset: 0, length: 9999 }];
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].blocks[0].spans, [{ offset: 0, length: 9999 }]);

  const validation = validateCanonicalLayout(layout);
  assertFalse(validation.valid);
  assert(validation.errors.some((e) => e.code === "invalid_span"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: unrecognized paragraph role is preserved verbatim, not treated as an error or warning", () => {
  const result = synthetic2PageAnalyzeResult();
  result.paragraphs[0].role = "someFutureAzureRoleThisAdapterHasNeverSeen";
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.pages[0].blocks[0].role, "someFutureAzureRoleThisAdapterHasNeverSeen");
  assertEquals(layout.pages[0].blocks[0].kind, "someFutureAzureRoleThisAdapterHasNeverSeen");
  assertFalse(layout.warnings.some((w) => w.message?.toLowerCase().includes("role")));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: missing table dimensions (no rowCount/columnCount) does not fabricate them or fail validation", () => {
  const result = synthetic2PageAnalyzeResult({
    tables: [{
      cells: [
        { rowIndex: 0, columnIndex: 0, content: "A", boundingRegions: [{ pageNumber: 1, polygon: [] }] },
        { rowIndex: 0, columnIndex: 1, content: "B", boundingRegions: [{ pageNumber: 1, polygon: [] }] },
      ],
      boundingRegions: [{ pageNumber: 1, polygon: [] }],
    }],
  });
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  const table = layout.pages.flatMap((p) => p.tables)[0];
  assertEquals(table.row_count, undefined);
  assertEquals(table.column_count, undefined);
  assertEquals(table.rows, 1); // derived from the highest cell row_index + 1

  const validation = validateCanonicalLayout(layout);
  assert(validation.valid, "missing (not conflicting) table dimensions must not fail validation");
});

Deno.test("azureAnalyzeResultToCanonicalLayout: a table's bounding regions spanning multiple pages are all preserved, with a recoverable warning", () => {
  const result = synthetic2PageAnalyzeResult({
    tables: [{
      rowCount: 1,
      columnCount: 1,
      cells: [{ rowIndex: 0, columnIndex: 0, content: "spans pages", boundingRegions: [{ pageNumber: 1, polygon: [] }, { pageNumber: 2, polygon: [] }] }],
      boundingRegions: [{ pageNumber: 1, polygon: [] }, { pageNumber: 2, polygon: [] }],
    }],
  });
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  const table = layout.pages.flatMap((p) => p.tables)[0];
  assertEquals(table.bounding_regions.length, 2);
  assert(layout.warnings.some((w) => w.code === "table_spans_multiple_pages"));
});

Deno.test("azureAnalyzeResultToCanonicalLayout: Unicode content round-trips exactly", () => {
  const unicodeText = "Café Properties — 日本語のテスト — emoji: 🏢";
  const result = { content: unicodeText, pages: [{ pageNumber: 1, spans: [{ offset: 0, length: unicodeText.length }] }], paragraphs: [], tables: [] };
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  assertEquals(layout.text_projection, unicodeText);
  assertEquals(layout.pages[0].plain_text, unicodeText);
});

Deno.test("azureAnalyzeResultToCanonicalLayout: large-but-bounded input (200 pages x 5 paragraphs) completes quickly with correct counts (no quadratic blow-up)", () => {
  const pageCount = 200;
  const paragraphsPerPage = 5;
  let content = "";
  const pages: any[] = [];
  const paragraphs: any[] = [];
  for (let p = 1; p <= pageCount; p++) {
    const pageStart = content.length;
    for (let i = 0; i < paragraphsPerPage; i++) {
      const text = `Page ${p} paragraph ${i}.`;
      const offset = content.length;
      content += text + "\n";
      paragraphs.push({ content: text, boundingRegions: [{ pageNumber: p, polygon: [] }], spans: [{ offset, length: text.length }] });
    }
    pages.push({ pageNumber: p, spans: [{ offset: pageStart, length: content.length - pageStart }] });
  }
  const result = { content, pages, paragraphs, tables: [] };

  const start = performance.now();
  const layout = azureAnalyzeResultToCanonicalLayout(result, { uploadedFileId: "uf-1" });
  const elapsedMs = performance.now() - start;

  assertEquals(layout.page_count, pageCount);
  assertEquals(layout.pages[0].blocks.length, paragraphsPerPage);
  assertEquals(layout.pages[pageCount - 1].blocks.length, paragraphsPerPage);
  assert(elapsedMs < 2000, `expected well under 2s for ${pageCount * paragraphsPerPage} paragraphs, took ${elapsedMs}ms`);

  const validation = validateCanonicalLayout(layout);
  assert(validation.valid);
});

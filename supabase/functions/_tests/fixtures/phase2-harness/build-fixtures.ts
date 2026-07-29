// @ts-nocheck
/**
 * Phase 2 diagnostic fixture generator (Azure + Vertex canonical pipeline
 * migration). Not a throwaway script: content is always constructed first,
 * every span/boundingRegion offset is derived programmatically from
 * `content.indexOf(...)` via ContentAccumulator below, and every fixture is
 * self-verified (every span's substring must match the text it claims to
 * cover) before being written -- so offsets can never silently drift out of
 * sync with hand-edited content. All fixtures are synthetic: no real Azure
 * export or customer document content is used anywhere in this file.
 *
 * Run: deno run --allow-write=supabase/functions/_tests/fixtures/phase2-harness supabase/functions/_tests/fixtures/phase2-harness/build-fixtures.ts
 */

interface SpanLike {
  offset: number;
  length: number;
}

/** Accumulates a document's authoritative `content` string, handing back a
 *  verified span for every piece of text appended -- the only way any
 *  fixture in this file is allowed to produce an offset. */
class ContentAccumulator {
  private text = "";

  get content(): string {
    return this.text;
  }

  /** Appends `text` (no trailing newline) and returns its exact span. */
  append(text: string): SpanLike {
    const offset = this.text.length;
    this.text += text;
    return { offset, length: text.length };
  }

  /** Appends `text` followed by a newline; returns the span of `text` only
   *  (the newline is a separator, not part of any paragraph/line's span). */
  appendLine(text: string): SpanLike {
    const span = this.append(text);
    this.text += "\n";
    return span;
  }
}

function assertSpanMatches(content: string, span: SpanLike, expected: string, where: string): void {
  const actual = content.slice(span.offset, span.offset + span.length);
  if (actual !== expected) {
    throw new Error(
      `Fixture self-check failed at ${where}: span [${span.offset}, ${span.offset + span.length}) ` +
        `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

function polygon(x0: number, y0: number, x1: number, y1: number): number[] {
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

// ── Fixture 1: assignment-scale ──────────────────────────────────────────────

function buildAssignmentScaleFixture() {
  const acc = new ContentAccumulator();
  const paragraphs: any[] = [];

  const title = acc.appendLine("ASSIGNMENT AND ASSUMPTION OF LEASE");
  paragraphs.push({ role: "title", content: "ASSIGNMENT AND ASSUMPTION OF LEASE", boundingRegions: [{ pageNumber: 1, polygon: polygon(1, 1, 7.5, 1.3) }], spans: [title] });

  const intro = acc.appendLine("Assignor hereby assigns all right, title, and interest in the lease to Assignee, effective as of the Effective Date.");
  paragraphs.push({ content: "Assignor hereby assigns all right, title, and interest in the lease to Assignee, effective as of the Effective Date.", boundingRegions: [{ pageNumber: 1, polygon: polygon(1, 1.5, 7.5, 1.8) }], spans: [intro] });

  acc.append("\n");

  const heading2 = acc.appendLine("Assignee accepts the assignment and assumes all obligations of the Assignor under the original lease.");
  paragraphs.push({ role: "sectionHeading", content: "Assignee accepts the assignment and assumes all obligations of the Assignor under the original lease.", boundingRegions: [{ pageNumber: 2, polygon: polygon(1, 1, 7.5, 1.3) }], spans: [heading2] });

  const content = acc.content;
  for (const p of paragraphs) assertSpanMatches(content, p.spans[0], p.content, `assignment paragraph "${p.content.slice(0, 20)}..."`);

  return {
    apiVersion: "2024-11-30",
    modelId: "prebuilt-layout",
    content,
    pages: [
      { pageNumber: 1, width: 8.5, height: 11, unit: "inch", spans: [{ offset: 0, length: intro.offset + intro.length + 1 }] },
      { pageNumber: 2, width: 8.5, height: 11, unit: "inch", spans: [{ offset: heading2.offset, length: heading2.length }] },
    ],
    paragraphs,
    tables: [],
  };
}

// ── Fixture 2: base-lease-scale ──────────────────────────────────────────────

function buildBaseLeaseScaleFixture() {
  const acc = new ContentAccumulator();
  const paragraphs: any[] = [];
  const pageSpecs: Array<{ pageNumber: number; start: number }> = [];
  const PAGE_COUNT = 18;
  const PARAGRAPHS_PER_PAGE = 4;

  for (let page = 1; page <= PAGE_COUNT; page++) {
    pageSpecs.push({ pageNumber: page, start: acc.content.length });
    for (let i = 0; i < PARAGRAPHS_PER_PAGE; i++) {
      const text = `Section ${page}.${i + 1}. This lease clause establishes the terms applicable to page ${page}, paragraph ${i + 1} of the base lease agreement.`;
      const span = acc.appendLine(text);
      paragraphs.push({
        role: i === 0 ? "sectionHeading" : undefined,
        content: text,
        boundingRegions: [{ pageNumber: page, polygon: polygon(1, 1 + i * 0.5, 7.5, 1.3 + i * 0.5) }],
        spans: [span],
      });
    }
    acc.append("\n");
  }

  const tables = [
    buildSimpleTable(acc, 1, ["Item", "Amount"], [["Base Rent", "$8,500.00"], ["CAM", "$1,200.00"]]),
    buildSimpleTable(acc, PAGE_COUNT, ["Milestone", "Date"], [["Commencement", "2026-01-01"], ["Expiration", "2035-12-31"]]),
  ];

  const content = acc.content;
  for (const p of paragraphs) assertSpanMatches(content, p.spans[0], p.content, `base-lease paragraph on page ${p.boundingRegions[0].pageNumber}`);

  const pages = pageSpecs.map((spec, index) => {
    const end = index + 1 < pageSpecs.length ? pageSpecs[index + 1].start : content.length;
    return { pageNumber: spec.pageNumber, width: 8.5, height: 11, unit: "inch", spans: [{ offset: spec.start, length: end - spec.start }] };
  });

  return { apiVersion: "2024-11-30", modelId: "prebuilt-layout", content, pages, paragraphs, tables: tables.map((t) => t.table) };
}

// ── Fixture 3: cam-table-scale ────────────────────────────────────────────────

function buildSimpleTable(acc: ContentAccumulator, pageNumber: number, headers: string[], rows: string[][]) {
  const cells: any[] = [];
  headers.forEach((h, columnIndex) => {
    cells.push({ kind: "columnHeader", rowIndex: 0, columnIndex, content: h, boundingRegions: [{ pageNumber, polygon: polygon(1 + columnIndex * 2, 5, 3 + columnIndex * 2, 5.3) }] });
  });
  rows.forEach((row, rowIndex) => {
    row.forEach((cellText, columnIndex) => {
      cells.push({ rowIndex: rowIndex + 1, columnIndex, content: cellText, boundingRegions: [{ pageNumber, polygon: polygon(1 + columnIndex * 2, 5.3 + rowIndex * 0.3, 3 + columnIndex * 2, 5.6 + rowIndex * 0.3) }] });
    });
  });
  const table = {
    rowCount: rows.length + 1,
    columnCount: headers.length,
    cells,
    boundingRegions: [{ pageNumber, polygon: polygon(1, 5, 1 + headers.length * 2, 5.6 + rows.length * 0.3) }],
  };
  return { table };
}

function buildCamTableScaleFixture() {
  const acc = new ContentAccumulator();
  const paragraphs: any[] = [];
  const PAGE_COUNT = 10;
  const pageSpecs: Array<{ pageNumber: number; start: number }> = [];

  for (let page = 1; page <= PAGE_COUNT; page++) {
    pageSpecs.push({ pageNumber: page, start: acc.content.length });
    const text = `CAM Reconciliation Schedule ${page}. Common area maintenance charges are allocated pro-rata across the property.`;
    const span = acc.appendLine(text);
    paragraphs.push({ role: page === 1 ? "title" : undefined, content: text, boundingRegions: [{ pageNumber: page, polygon: polygon(1, 1, 7.5, 1.3) }], spans: [span] });
    acc.append("\n");
  }

  const tables: any[] = [];
  const camCategories = ["Landscaping", "Snow Removal", "Common Area Utilities", "Security", "Insurance", "Property Management", "Repairs", "Janitorial"];
  for (let t = 0; t < 4; t++) {
    const pageNumber = 2 + t * 2;
    const rows = camCategories.slice(0, 8).map((category, i) => [category, `$${(1000 + i * 137 + t * 50).toFixed(2)}`]);
    tables.push(buildSimpleTable(acc, pageNumber, ["CAM Category", "Annual Amount"], rows).table);
  }

  const content = acc.content;
  for (const p of paragraphs) assertSpanMatches(content, p.spans[0], p.content, `cam-table paragraph on page ${p.boundingRegions[0].pageNumber}`);

  const pages = pageSpecs.map((spec, index) => {
    const end = index + 1 < pageSpecs.length ? pageSpecs[index + 1].start : content.length;
    return { pageNumber: spec.pageNumber, width: 8.5, height: 11, unit: "inch", spans: [{ offset: spec.start, length: end - spec.start }] };
  });

  return { apiVersion: "2024-11-30", modelId: "prebuilt-layout", content, pages, paragraphs, tables };
}

// ── Fixture 4: large-lease-scale (stress) ────────────────────────────────────

function buildLargeLeaseScaleFixture() {
  const acc = new ContentAccumulator();
  const paragraphs: any[] = [];
  const pageSpecs: Array<{ pageNumber: number; start: number; width: number; height: number; unit: string; noText: boolean }> = [];
  const tables: any[] = [];

  const PAGE_COUNT = 80;
  // Every 15th page has no extractable text at all -- covers both "empty
  // page" and "scanned-image-only page" cases, which are structurally
  // identical in Azure's analyzeResult shape (a page with zero paragraphs).
  const isNoTextPage = (page: number) => page % 15 === 0;
  // Every 20th page is landscape.
  const isLandscape = (page: number) => page % 20 === 0;
  // Amendment section headers on a handful of pages; appendix/exhibit
  // headers on a few more, near the end.
  const amendmentPages = new Set([25, 40, 55]);
  const appendixPages = new Set([70, 75]);

  for (let page = 1; page <= PAGE_COUNT; page++) {
    const start = acc.content.length;
    const landscape = isLandscape(page);
    pageSpecs.push({ pageNumber: page, start, width: landscape ? 11 : 8.5, height: landscape ? 8.5 : 11, unit: "inch", noText: isNoTextPage(page) });

    if (isNoTextPage(page)) {
      // Deliberately no paragraphs/lines reference this page.
      continue;
    }

    const headerText = "LEASE AGREEMENT — CONTINUED";
    const headerSpan = acc.appendLine(headerText);
    paragraphs.push({ role: "pageHeader", content: headerText, boundingRegions: [{ pageNumber: page, polygon: polygon(1, 0.3, 7.5, 0.5) }], spans: [headerSpan] });

    if (amendmentPages.has(page)) {
      const text = `Amendment No. ${[...amendmentPages].indexOf(page) + 1}. The parties agree to modify the terms of the original lease as set forth herein.`;
      const span = acc.appendLine(text);
      paragraphs.push({ role: "sectionHeading", content: text, boundingRegions: [{ pageNumber: page, polygon: polygon(1, 1, 7.5, 1.3) }], spans: [span] });
    } else if (appendixPages.has(page)) {
      const text = `Appendix ${page === 70 ? "A" : "B"}: Exhibit materials referenced elsewhere in this lease are attached following this page.`;
      const span = acc.appendLine(text);
      paragraphs.push({ role: "sectionHeading", content: text, boundingRegions: [{ pageNumber: page, polygon: polygon(1, 1, 7.5, 1.3) }], spans: [span] });
    } else {
      for (let i = 0; i < 3; i++) {
        const text = `Page ${page} paragraph ${i + 1}: dense clause text covering obligations, notices, and remedies applicable to this section of the lease.`;
        const span = acc.appendLine(text);
        paragraphs.push({ content: text, boundingRegions: [{ pageNumber: page, polygon: polygon(1, 1 + i * 0.5, 7.5, 1.3 + i * 0.5) }], spans: [span] });
      }
    }

    const footerText = `Page ${page} of ${PAGE_COUNT}`;
    const footerSpan = acc.appendLine(footerText);
    paragraphs.push({ role: "pageFooter", content: footerText, boundingRegions: [{ pageNumber: page, polygon: polygon(1, 10.5, 7.5, 10.7) }], spans: [footerSpan] });

    acc.append("\n");
  }

  // Several large tables (10 rows x 6 columns) on ordinary (text-bearing)
  // pages -- deliberately not multiples of 15, so they never collide with
  // the no-text pages above.
  for (const pageNumber of [10, 43, 58]) {
    if (isNoTextPage(pageNumber)) throw new Error(`stress-table page ${pageNumber} unexpectedly collides with a no-text page`);
    const headers = ["Line Item", "Category", "Q1", "Q2", "Q3", "Q4"];
    const rows = Array.from({ length: 10 }, (_, i) => [`Item ${i + 1}`, i % 2 === 0 ? "Operating" : "Capital", `$${(100 + i * 10).toFixed(2)}`, `$${(110 + i * 10).toFixed(2)}`, `$${(120 + i * 10).toFixed(2)}`, `$${(130 + i * 10).toFixed(2)}`]);
    tables.push(buildSimpleTable(acc, pageNumber, headers, rows).table);
  }

  // One table whose bounding regions genuinely span two consecutive
  // text-bearing pages (also not multiples of 15).
  {
    const pageA = 33;
    const pageB = 34;
    const headers = ["Expense Category", "Amount"];
    const rows = [["Landscaping", "$4,200.00"], ["Security", "$9,800.00"]];
    const built = buildSimpleTable(acc, pageA, headers, rows).table;
    built.boundingRegions = [
      { pageNumber: pageA, polygon: polygon(1, 9, 5, 10.8) },
      { pageNumber: pageB, polygon: polygon(1, 0.5, 5, 1.2) },
    ];
    tables.push(built);
  }

  const content = acc.content;
  for (const p of paragraphs) assertSpanMatches(content, p.spans[0], p.content, `large-lease paragraph on page ${p.boundingRegions[0].pageNumber}`);

  const pages = pageSpecs.map((spec, index) => {
    const end = index + 1 < pageSpecs.length ? pageSpecs[index + 1].start : content.length;
    return { pageNumber: spec.pageNumber, width: spec.width, height: spec.height, unit: spec.unit, spans: [{ offset: spec.start, length: Math.max(0, end - spec.start) }] };
  });

  return { apiVersion: "2024-11-30", modelId: "prebuilt-layout", content, pages, paragraphs, tables };
}

// ── Fixture 5: current-persisted-docling-raw-azure-shape ────────────────────
// Mirrors the REAL, confirmed docling_raw shape azure-layout-adapter.ts
// actually persists today (per docs/lease-extraction-architecture-audit-2026-07-29.md
// and Phase 1's azureLike3PageDoclingRaw() test helper) -- NOT an Azure
// analyzeResult. STORE_FULL_AZURE_RAW_RESPONSE is off by default, so
// raw_response is null here, matching the common-case durable row.

function buildCurrentPersistedDoclingRawFixture() {
  const PAGE_COUNT = 10;
  const pages: any[] = [];
  const textBlocks: any[] = [];
  let fullText = "";
  let blockIndex = 0;

  for (let page = 1; page <= PAGE_COUNT; page++) {
    const pageText = `Section ${page}. Lease clause text for page ${page}, covering rent, use, and maintenance obligations.`;
    pages.push({ page, text: pageText, width: 612, height: 792, unit: "pixel" });
    fullText += `[[PAGE ${page}]]\n${pageText}\n\n`;
    textBlocks.push({ block_index: blockIndex++, type: page === 1 ? "title" : "paragraph", text: pageText, page });
  }

  const tables = [
    { table_index: 0, headers: ["Item", "Amount"], rows: [["Base Rent", "$6,000.00"], ["CAM", "$900.00"]], markdown: "Item\tAmount\nBase Rent\t$6,000.00\nCAM\t$900.00" },
  ];

  return {
    extraction_method: "azure_layout",
    full_text: fullText,
    markdown: fullText,
    page_count: PAGE_COUNT,
    pages,
    text_blocks: textBlocks,
    tables,
    fields: [],
    warnings: [],
    raw_response: null,
    raw_response_summary: {
      provider: "azure_document_intelligence",
      extraction_method: "azure_layout",
      api_version: "2024-11-30",
      page_count: PAGE_COUNT,
      table_count: tables.length,
      text_block_count: textBlocks.length,
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
  };
}

// ── Write all fixtures ────────────────────────────────────────────────────────

async function main() {
  const dir = new URL(".", import.meta.url);
  const fixtures: Array<[string, unknown]> = [
    ["assignment-scale-synthetic.json", buildAssignmentScaleFixture()],
    ["base-lease-scale-synthetic.json", buildBaseLeaseScaleFixture()],
    ["cam-table-scale-synthetic.json", buildCamTableScaleFixture()],
    ["large-lease-scale-synthetic.json", buildLargeLeaseScaleFixture()],
    ["current-persisted-docling-raw-azure-shape.json", buildCurrentPersistedDoclingRawFixture()],
  ];

  for (const [name, data] of fixtures) {
    const path = new URL(name, dir);
    await Deno.writeTextFile(path, JSON.stringify(data, null, 2));
    console.log(`wrote ${name}`);
  }
}

if (import.meta.main) {
  await main();
}

export {
  buildAssignmentScaleFixture,
  buildBaseLeaseScaleFixture,
  buildCamTableScaleFixture,
  buildLargeLeaseScaleFixture,
  buildCurrentPersistedDoclingRawFixture,
};

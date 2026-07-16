// @ts-nocheck
/**
 * Azure Document Intelligence → Canonical Layout adapter (Phase 1 of the
 * Azure + Vertex canonical pipeline migration).
 *
 * Builds a CanonicalDocumentLayout (../document-intelligence-v3/canonical-layout.ts)
 * directly from Azure's raw Layout API `analyzeResult` -- as returned
 * untouched by `analyzeWithAzureLayout()` in
 * `_shared/azure/document-intelligence.ts` -- rather than from the already
 * lossy `docling_raw` shape the legacy builder (`legacyDoclingToCanonicalLayout`)
 * derives from. This is what lets the canonical contract carry real
 * polygons, spans, reading order, and merged-cell structure for the first
 * time.
 *
 * Pure, synchronous, deterministic. No network, no `Deno.env`, no database,
 * no Azure client invocation, and no runtime registration in Phase 1 --
 * nothing in the running pipeline calls this yet. Azure-specific enums,
 * object shapes, and REST payload types (the `AzureXLike` interfaces below)
 * must never appear outside this file; everything this module returns is
 * already canonical-typed.
 *
 * Input boundary: `azureAnalyzeResultToCanonicalLayout` accepts only the
 * inner Azure `analyzeResult` object (i.e. `payload.analyzeResult`, not the
 * outer polling-response envelope with `status`/`operationLocation`). No
 * silent double-unwrapping is performed.
 *
 * Losslessness over interpretation: this adapter stores Azure's raw spans
 * and the authoritative top-level `content` as the source of truth
 * (`text_projection` is `content`, verbatim). Per-page `plain_text` is kept
 * populated only for backward compatibility with the existing required
 * `CanonicalPage.plain_text` field, and is produced by explicitly calling
 * the separate `reconstructPageTextFromSpans()` helper -- this adapter does
 * not otherwise synthesize or interpret text it doesn't have to.
 *
 * The output of this adapter is not validated by itself -- validation is a
 * distinct pipeline stage (see `validateCanonicalLayout()` in
 * ../document-intelligence-v3/canonical-layout.ts), run explicitly by this
 * module's own tests and by any future caller, per the target pipeline
 * shape: Azure → Azure adapter → canonical validation → CanonicalDocumentLayout.
 */

import {
  CANONICAL_LAYOUT_SCHEMA_VERSION,
  reconstructPageTextFromSpans,
  type CanonicalBoundingRegion,
  type CanonicalDocumentLayout,
  type CanonicalPage,
  type CanonicalSpan,
  type CanonicalTable,
  type CanonicalTableCell,
  type CanonicalWarning,
  type LayoutBlock,
} from "../document-intelligence-v3/canonical-layout.ts";

// ── Azure input types (Task C) ───────────────────────────────────────────────
// Minimal shapes containing only the fields this adapter actually reads.
// Not bound to any Azure SDK type; isolated to this file by the leakage
// rule above.

export interface AzureSpanLike {
  offset: number;
  length: number;
}

export interface AzureBoundingRegionLike {
  pageNumber: number;
  polygon?: number[];
}

export interface AzureLineLike {
  content: string;
  polygon?: number[];
  spans?: AzureSpanLike[];
}

export interface AzureSelectionMarkLike {
  state?: string;
  polygon?: number[];
  confidence?: number;
}

export interface AzurePageLike {
  pageNumber: number;
  width?: number;
  height?: number;
  unit?: string;
  spans?: AzureSpanLike[];
  lines?: AzureLineLike[];
  selectionMarks?: AzureSelectionMarkLike[];
}

export interface AzureParagraphLike {
  role?: string;
  content: string;
  boundingRegions?: AzureBoundingRegionLike[];
  spans?: AzureSpanLike[];
}

export interface AzureTableCellLike {
  kind?: string;
  rowIndex: number;
  columnIndex: number;
  rowSpan?: number;
  columnSpan?: number;
  content: string;
  boundingRegions?: AzureBoundingRegionLike[];
  spans?: AzureSpanLike[];
}

export interface AzureTableLike {
  rowCount?: number;
  columnCount?: number;
  cells?: AzureTableCellLike[];
  boundingRegions?: AzureBoundingRegionLike[];
  spans?: AzureSpanLike[];
}

export interface AzureAnalyzeResultLike {
  content: string;
  apiVersion?: string;
  modelId?: string;
  pages?: AzurePageLike[];
  paragraphs?: AzureParagraphLike[];
  tables?: AzureTableLike[];
}

export interface AzureToCanonicalLayoutContext {
  documentId?: string | null;
  uploadedFileId?: string | null;
  orgId?: string | null;
  modelId?: string | null;
  apiVersion?: string | null;
}

// ── Small shared conversions ─────────────────────────────────────────────────

function toCanonicalSpans(spans: AzureSpanLike[] | undefined): CanonicalSpan[] | undefined {
  if (!spans || spans.length === 0) return undefined;
  return spans.map((s) => ({ offset: s.offset, length: s.length }));
}

function toCanonicalBoundingRegions(regions: AzureBoundingRegionLike[] | undefined): CanonicalBoundingRegion[] | undefined {
  if (!regions || regions.length === 0) return undefined;
  return regions.map((r) => ({ page_number: r.pageNumber, polygon: Array.isArray(r.polygon) ? r.polygon : [] }));
}

function firstRegionPolygon(regions: AzureBoundingRegionLike[] | undefined): number[] {
  const polygon = regions?.[0]?.polygon;
  return Array.isArray(polygon) ? polygon : [];
}

function firstRegionPageNumber(regions: AzureBoundingRegionLike[] | undefined): number | null {
  const page = regions?.[0]?.pageNumber;
  return typeof page === "number" ? page : null;
}

function distinctPageNumbers(regions: AzureBoundingRegionLike[] | undefined): number[] {
  if (!regions || regions.length === 0) return [];
  return [...new Set(regions.map((r) => r.pageNumber).filter((n) => typeof n === "number"))];
}

// ── Adapter (Task D) ──────────────────────────────────────────────────────────

/**
 * Pure, synchronous, deterministic. `content_hash` is intentionally left
 * `null` -- the existing hash (`sha256Hex` via Web Crypto) is async, and
 * hashing (if ever needed for this path) is a separate, async caller
 * concern, not part of this function. No production hash semantics change
 * in Phase 1.
 */
export function azureAnalyzeResultToCanonicalLayout(
  analyzeResult: AzureAnalyzeResultLike | null | undefined,
  context: AzureToCanonicalLayoutContext = {},
): CanonicalDocumentLayout {
  const warnings: CanonicalWarning[] = [];

  if (!analyzeResult) {
    warnings.push({ code: "missing_analyze_result", message: "No Azure analyzeResult provided", severity: "fatal" });
    return {
      document_id: context.documentId ?? context.uploadedFileId ?? null,
      uploaded_file_id: context.uploadedFileId ?? null,
      org_id: context.orgId ?? null,
      content_hash: null,
      layout_provider: "azure_document_intelligence",
      layout_api_version: context.apiVersion ?? null,
      page_count: 0,
      full_text_chars: 0,
      text_projection: "",
      pages: [],
      assets: [],
      metadata: {},
      schema_version: CANONICAL_LAYOUT_SCHEMA_VERSION,
      provider: "azure_document_intelligence",
      provider_model_id: context.modelId ?? null,
      provider_api_version: context.apiVersion ?? null,
      warnings,
    };
  }

  const content = String(analyzeResult.content ?? "");
  const azurePages = Array.isArray(analyzeResult.pages) ? analyzeResult.pages : [];
  const paragraphs = Array.isArray(analyzeResult.paragraphs) ? analyzeResult.paragraphs : [];
  const tables = Array.isArray(analyzeResult.tables) ? analyzeResult.tables : [];

  // ── Page skeletons (O(pages)) ──────────────────────────────────────────────
  const pageSkeletons = new Map<number, CanonicalPage>();
  for (const page of azurePages) {
    if (pageSkeletons.has(page.pageNumber)) {
      warnings.push({
        code: "duplicate_azure_page_number",
        path: `pages[${page.pageNumber}]`,
        message: `Azure returned more than one page with pageNumber ${page.pageNumber}`,
        severity: "recoverable",
      });
      continue;
    }
    pageSkeletons.set(page.pageNumber, {
      page_number: page.pageNumber,
      plain_text: "",
      blocks: [],
      tables: [],
      figures: [],
      signature_regions: [],
      selection_marks: (page.selectionMarks ?? []).map((mark, index) => ({
        mark_id: `page-${page.pageNumber}-mark-${index}`,
        page_number: page.pageNumber,
        state: mark.state === "selected" || mark.state === "unselected" ? mark.state : "unknown",
        polygon: Array.isArray(mark.polygon) ? mark.polygon : [],
      })),
      page_width: typeof page.width === "number" ? page.width : null,
      page_height: typeof page.height === "number" ? page.height : null,
      page_unit: typeof page.unit === "string" ? page.unit : null,
      // Azure's page objects carry no boundingRegions of their own (that
      // concept applies to paragraphs/tables/cells, not to a page as a
      // whole) -- left undefined rather than fabricated.
      spans: toCanonicalSpans(page.spans),
    });
  }
  const knownPageNumbers = new Set<number>(pageSkeletons.keys());

  // ── Reading-order blocks: paragraphs primary, lines fallback only (O(n)) ───
  const blocksByPage = new Map<number, LayoutBlock[]>();
  const readingOrderCounters = new Map<number, number>();

  const addBlock = (pageNumber: number, block: LayoutBlock) => {
    const list = blocksByPage.get(pageNumber) ?? [];
    list.push(block);
    blocksByPage.set(pageNumber, list);
  };

  if (paragraphs.length > 0) {
    paragraphs.forEach((paragraph, index) => {
      let pageNumber = firstRegionPageNumber(paragraph.boundingRegions);
      if (pageNumber == null) {
        warnings.push({
          code: "paragraph_missing_bounding_region",
          path: `paragraphs[${index}]`,
          message: "Paragraph has no boundingRegions; assumed page 1 rather than dropping its text",
          severity: "recoverable",
        });
        pageNumber = knownPageNumbers.size > 0 ? Math.min(...knownPageNumbers) : 1;
      }
      const orderIndex = readingOrderCounters.get(pageNumber) ?? 0;
      readingOrderCounters.set(pageNumber, orderIndex + 1);

      addBlock(pageNumber, {
        block_id: `page-${pageNumber}-block-${orderIndex}`,
        page_number: pageNumber,
        kind: paragraph.role || "paragraph",
        text: String(paragraph.content ?? ""),
        span_start: paragraph.spans?.[0]?.offset ?? null,
        span_end: paragraph.spans?.[0] ? paragraph.spans[0].offset + paragraph.spans[0].length : null,
        polygon: firstRegionPolygon(paragraph.boundingRegions),
        confidence: null,
        role: paragraph.role,
        spans: toCanonicalSpans(paragraph.spans),
        bounding_regions: toCanonicalBoundingRegions(paragraph.boundingRegions),
        reading_order_index: orderIndex,
      });
    });
  } else {
    for (const page of azurePages) {
      const lines = Array.isArray(page.lines) ? page.lines : [];
      lines.forEach((line, index) => {
        const orderIndex = readingOrderCounters.get(page.pageNumber) ?? 0;
        readingOrderCounters.set(page.pageNumber, orderIndex + 1);
        const polygon = Array.isArray(line.polygon) ? line.polygon : [];
        addBlock(page.pageNumber, {
          block_id: `page-${page.pageNumber}-block-${orderIndex}`,
          page_number: page.pageNumber,
          kind: "line",
          text: String(line.content ?? ""),
          span_start: line.spans?.[0]?.offset ?? null,
          span_end: line.spans?.[0] ? line.spans[0].offset + line.spans[0].length : null,
          polygon,
          confidence: null,
          spans: toCanonicalSpans(line.spans),
          bounding_regions: polygon.length > 0 ? [{ page_number: page.pageNumber, polygon }] : undefined,
          reading_order_index: orderIndex,
        });
      });
    }
  }

  // ── Tables (O(total cells)) ─────────────────────────────────────────────────
  const tablesByPage = new Map<number, CanonicalTable[]>();
  tables.forEach((table, tableIndex) => {
    const tableId = `table-${tableIndex}`;
    const regionPages = distinctPageNumbers(table.boundingRegions);
    let pageNumber = firstRegionPageNumber(table.boundingRegions);
    if (pageNumber == null) {
      warnings.push({
        code: "table_missing_bounding_region",
        path: `tables[${tableIndex}]`,
        message: "Table has no boundingRegions; assumed page 1 rather than dropping it",
        severity: "recoverable",
      });
      pageNumber = knownPageNumbers.size > 0 ? Math.min(...knownPageNumbers) : 1;
    }
    if (regionPages.length > 1) {
      warnings.push({
        code: "table_spans_multiple_pages",
        path: `tables[${tableIndex}]`,
        message: `Table bounding regions span pages ${regionPages.join(", ")}; all regions are preserved, but the table is attributed to page ${pageNumber}`,
        severity: "recoverable",
      });
    }

    const cells: CanonicalTableCell[] = (table.cells ?? []).map((cell) => ({
      cell_id: `${tableId}-cell-r${cell.rowIndex}-c${cell.columnIndex}`,
      row_index: cell.rowIndex,
      column_index: cell.columnIndex,
      text: String(cell.content ?? ""),
      polygon: firstRegionPolygon(cell.boundingRegions),
      row_span: cell.rowSpan,
      column_span: cell.columnSpan,
      kind: cell.kind,
      spans: toCanonicalSpans(cell.spans),
      bounding_regions: toCanonicalBoundingRegions(cell.boundingRegions),
    }));

    const canonicalTable: CanonicalTable = {
      table_id: tableId,
      page_number: pageNumber,
      rows: typeof table.rowCount === "number" ? table.rowCount : cells.reduce((max, c) => Math.max(max, c.row_index + 1), 0),
      cells,
      polygon: firstRegionPolygon(table.boundingRegions),
      caption: null,
      row_count: table.rowCount,
      column_count: table.columnCount,
      spans: toCanonicalSpans(table.spans),
      bounding_regions: toCanonicalBoundingRegions(table.boundingRegions),
    };

    const list = tablesByPage.get(pageNumber) ?? [];
    list.push(canonicalTable);
    tablesByPage.set(pageNumber, list);
  });

  // ── Reconcile: a paragraph/table can reference a page Azure's own `pages[]`
  // array never listed (e.g. `pages` omitted from the response entirely).
  // Rather than silently dropping that block/table, synthesize a minimal
  // page skeleton for it and warn (O(blocks + tables), not O(n^2) -- each
  // referenced page number is synthesized at most once via the `has` check).
  for (const pageNumber of [...blocksByPage.keys(), ...tablesByPage.keys()]) {
    if (pageSkeletons.has(pageNumber)) continue;
    warnings.push({
      code: "page_synthesized_from_content",
      path: `pages[${pageNumber}]`,
      message: `Page ${pageNumber} was referenced by a paragraph or table but was not present in Azure's own pages[] array; a minimal page was synthesized rather than dropping its content`,
      severity: "recoverable",
    });
    pageSkeletons.set(pageNumber, {
      page_number: pageNumber,
      plain_text: "",
      blocks: [],
      tables: [],
      figures: [],
      signature_regions: [],
      selection_marks: [],
      page_width: null,
      page_height: null,
      page_unit: null,
    });
  }

  // ── Assemble pages, reconstructing plain_text explicitly (O(pages)) ────────
  const pages: CanonicalPage[] = [...pageSkeletons.values()]
    .sort((a, b) => a.page_number - b.page_number)
    .map((skeleton) => {
      const blocks = blocksByPage.get(skeleton.page_number) ?? [];
      const fallbackLines = blocks.filter((b) => b.kind === "line").map((b) => b.text);
      const reconstruction = reconstructPageTextFromSpans(content, skeleton.spans, fallbackLines);
      if (reconstruction.source === "line_fallback") {
        warnings.push({
          code: "page_text_from_lines_fallback",
          path: `pages[${skeleton.page_number}]`,
          message: `Page ${skeleton.page_number} had no usable spans against content; plain_text was reconstructed by joining line text instead`,
          severity: "recoverable",
        });
      }
      return {
        ...skeleton,
        plain_text: reconstruction.text,
        blocks,
        tables: tablesByPage.get(skeleton.page_number) ?? [],
      };
    });

  if (!content) {
    warnings.push({ code: "empty_content", message: "Azure analyzeResult had no top-level content", severity: "recoverable" });
  }

  return {
    document_id: context.documentId ?? context.uploadedFileId ?? null,
    uploaded_file_id: context.uploadedFileId ?? null,
    org_id: context.orgId ?? null,
    content_hash: null,
    layout_provider: "azure_document_intelligence",
    layout_api_version: context.apiVersion ?? analyzeResult.apiVersion ?? null,
    page_count: pages.length,
    full_text_chars: content.length,
    text_projection: content,
    pages,
    assets: [],
    metadata: {
      source: "azure_analyze_result",
      paragraph_count: paragraphs.length,
      table_count: tables.length,
    },
    schema_version: CANONICAL_LAYOUT_SCHEMA_VERSION,
    provider: "azure_document_intelligence",
    provider_model_id: context.modelId ?? analyzeResult.modelId ?? null,
    provider_api_version: context.apiVersion ?? analyzeResult.apiVersion ?? null,
    warnings,
  };
}

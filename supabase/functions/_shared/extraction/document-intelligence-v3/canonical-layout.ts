// @ts-nocheck
/**
 * Document Intelligence v3 — Canonical Layout Model (Phase 5)
 *
 * A richer, provider-agnostic layout projection used by future v3
 * extraction modules — distinct from (and complementary to) the summary-only
 * `layout` section already in the Phase 1 contract (types.ts's
 * DocumentIntelligenceV3LayoutSection). This module builds that projection
 * from whatever is already persisted on an uploaded_files.docling_raw row
 * (per docs/document-intelligence-v3-baseline.md's confirmed docling_raw
 * shape) -- it does not call Azure, does not re-parse, and does not require
 * the raw Azure response (raw_response is only ever read as "not present"
 * here; STORE_FULL_AZURE_RAW_RESPONSE=false rows work identically to true).
 */

import { countTextChars } from "../pipeline-contract.ts";
import type { EvidenceSupportType } from "./types.ts";

// ── Types (Task A) ──────────────────────────────────────────────────────────

export interface DocumentAsset {
  asset_id: string;
  page_number: number | null;
  kind: string;
  polygon: number[];
}

export interface SelectionMark {
  mark_id: string;
  page_number: number | null;
  state: "selected" | "unselected" | "unknown";
  polygon: number[];
}

export interface SignatureRegion {
  region_id: string;
  page_number: number | null;
  polygon: number[];
  confidence: number | null;
}

export interface LayoutBlock {
  block_id: string;
  page_number: number;
  kind: string;
  text: string;
  span_start: number | null;
  span_end: number | null;
  polygon: number[];
  confidence: number | null;
}

export interface CanonicalTableCell {
  cell_id: string;
  row_index: number;
  column_index: number;
  text: string;
  polygon: number[];
}

export interface CanonicalTable {
  table_id: string;
  page_number: number | null;
  /** Total row count including the header row, if any (matches Azure's own
   *  rowCount concept) -- the granular data lives in `cells`. */
  rows: number;
  cells: CanonicalTableCell[];
  polygon: number[];
  caption: string | null;
}

export interface CanonicalPage {
  page_number: number;
  plain_text: string;
  blocks: LayoutBlock[];
  tables: CanonicalTable[];
  figures: DocumentAsset[];
  signature_regions: SignatureRegion[];
  selection_marks: SelectionMark[];
  page_width: number | null;
  page_height: number | null;
}

export interface EvidenceAnchor {
  page: number | null;
  source_text: string | null;
  block_ids: string[];
  table_id: string | null;
  cell_ids: string[];
  polygon: number[];
  support_type: EvidenceSupportType;
}

export interface CanonicalDocumentLayout {
  document_id: string | null;
  uploaded_file_id: string | null;
  org_id: string | null;
  content_hash: string | null;
  layout_provider: string | null;
  layout_api_version: string | null;
  page_count: number | null;
  full_text_chars: number;
  text_projection: string;
  pages: CanonicalPage[];
  assets: DocumentAsset[];
  metadata: Record<string, unknown>;
}

export interface CanonicalLayoutSummary {
  layout_provider: string | null;
  api_version: string | null;
  page_count: number | null;
  full_text_chars: number;
  pages_with_text: number;
  text_block_count: number;
  table_count: number;
  figure_count: number;
  signature_region_count: number;
  selection_mark_count: number;
  page_markers_present: boolean;
  page_mapping_coverage: number | null;
  warnings: string[];
}

// ── Adapter (Task B) ─────────────────────────────────────────────────────────

export interface BuildCanonicalLayoutContext {
  documentId?: string | null;
  uploadedFileId?: string | null;
  orgId?: string | null;
  contentHash?: string | null;
  /** Reuse an already-built layout instead of rebuilding (Task B: "support
   *  canonical_layout if already present"). No current caller populates
   *  docling_raw with an embedded canonical layout -- this exists so a
   *  future caching layer has a defined place to plug in without changing
   *  this function's signature again. */
  existingCanonicalLayout?: CanonicalDocumentLayout | null;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

function blocksByPage(doclingRaw: Record<string, unknown>): Map<number, LayoutBlock[]> {
  const map = new Map<number, LayoutBlock[]>();
  const textBlocks = Array.isArray(doclingRaw?.text_blocks) ? (doclingRaw.text_blocks as any[]) : [];
  textBlocks.forEach((block, index) => {
    const pageNumber = typeof block?.page === "number" && block.page > 0 ? block.page : 1;
    const span = block?.span && typeof block.span === "object" ? block.span : null;
    const layoutBlock: LayoutBlock = {
      block_id: `block-${block?.block_index ?? index}`,
      page_number: pageNumber,
      kind: String(block?.type || "paragraph"),
      text: String(block?.text ?? ""),
      span_start: typeof span?.offset === "number" ? span.offset : null,
      span_end: typeof span?.offset === "number" && typeof span?.length === "number" ? span.offset + span.length : null,
      polygon: [],
      confidence: null,
    };
    const list = map.get(pageNumber) ?? [];
    list.push(layoutBlock);
    map.set(pageNumber, list);
  });
  return map;
}

function buildTableCells(tableId: string, headers: string[], rows: string[][]): CanonicalTableCell[] {
  const cells: CanonicalTableCell[] = [];
  let rowIndex = 0;
  if (headers.length > 0) {
    headers.forEach((text, columnIndex) => {
      cells.push({ cell_id: `${tableId}-r0-c${columnIndex}`, row_index: 0, column_index: columnIndex, text: String(text ?? ""), polygon: [] });
    });
    rowIndex = 1;
  }
  rows.forEach((row, dataRowIndex) => {
    (Array.isArray(row) ? row : []).forEach((text, columnIndex) => {
      cells.push({
        cell_id: `${tableId}-r${rowIndex + dataRowIndex}-c${columnIndex}`,
        row_index: rowIndex + dataRowIndex,
        column_index: columnIndex,
        text: String(text ?? ""),
        polygon: [],
      });
    });
  });
  return cells;
}

function tablesByPage(doclingRaw: Record<string, unknown>): Map<number, CanonicalTable[]> {
  const map = new Map<number, CanonicalTable[]>();
  const tables = Array.isArray(doclingRaw?.tables) ? (doclingRaw.tables as any[]) : [];
  tables.forEach((table, index) => {
    // docling_raw's persisted table shape carries no page attribution today
    // (see azure-layout-adapter.ts's normalizedTables) -- default to page 1
    // rather than fabricating a page number the source data doesn't have.
    const pageNumber = typeof table?.page === "number" && table.page > 0 ? table.page : 1;
    const headers = Array.isArray(table?.headers) ? table.headers : [];
    const rows = Array.isArray(table?.rows) ? table.rows : [];
    const tableId = `table-${table?.table_index ?? index}`;
    const canonicalTable: CanonicalTable = {
      table_id: tableId,
      page_number: pageNumber,
      rows: rows.length + (headers.length > 0 ? 1 : 0),
      cells: buildTableCells(tableId, headers, rows),
      polygon: [],
      caption: null,
    };
    const list = map.get(pageNumber) ?? [];
    list.push(canonicalTable);
    map.set(pageNumber, list);
  });
  return map;
}

/**
 * Builds text_projection (Task C): preserves whatever page-marked text is
 * already persisted verbatim when present (never re-derives it, avoiding
 * any risk of losing text azure-layout-adapter.ts already worked to
 * preserve); synthesizes [[PAGE n]] markers from per-page text only when
 * the persisted full_text has none; falls back to a single [[PAGE 1]]
 * wrapping the raw text as a last resort so text is never dropped.
 */
function buildTextProjection(
  doclingRaw: Record<string, unknown>,
  pages: Array<{ page: number; text: string }>,
): { text: string; pageMarkersPresent: boolean; pageMappingCoverage: number | null } {
  const fullText = String(doclingRaw?.full_text ?? "");
  const metadata = (doclingRaw?._metadata ?? {}) as Record<string, unknown>;
  const markersAlreadyPresent = typeof metadata.page_markers_present === "boolean"
    ? metadata.page_markers_present
    : /\[\[PAGE \d+\]\]/.test(fullText);

  if (markersAlreadyPresent && fullText) {
    return {
      text: fullText,
      pageMarkersPresent: true,
      pageMappingCoverage: typeof metadata.page_mapping_coverage === "number" ? metadata.page_mapping_coverage : 1,
    };
  }

  const pagesWithText = pages.filter((p) => p.text && p.text.trim().length > 0);
  if (pagesWithText.length > 0) {
    const text = pagesWithText.map((p) => `[[PAGE ${p.page}]]\n${p.text}`).join("\n\n");
    const coverage = fullText.length > 0
      ? Math.min(1, pagesWithText.reduce((sum, p) => sum + p.text.length, 0) / fullText.length)
      : (pagesWithText.length > 0 ? 1 : 0);
    return { text, pageMarkersPresent: true, pageMappingCoverage: coverage };
  }

  if (fullText) {
    return { text: `[[PAGE 1]]\n${fullText}`, pageMarkersPresent: false, pageMappingCoverage: 0 };
  }

  return { text: "", pageMarkersPresent: false, pageMappingCoverage: 0 };
}

export async function buildCanonicalLayoutFromAzureLikeOutput(
  doclingRaw: Record<string, unknown> | null | undefined,
  context: BuildCanonicalLayoutContext = {},
): Promise<CanonicalDocumentLayout> {
  if (context.existingCanonicalLayout) {
    return context.existingCanonicalLayout;
  }

  const raw = doclingRaw ?? {};
  const metadata = (raw._metadata ?? {}) as Record<string, unknown>;
  const rawPages = Array.isArray(raw.pages) ? (raw.pages as any[]) : [];

  const normalizedRawPages: Array<{ page: number; text: string; width: number | null; height: number | null }> =
    rawPages.map((p, index) => ({
      page: typeof p?.page === "number" && p.page > 0 ? p.page : index + 1,
      text: String(p?.text ?? ""),
      width: typeof p?.width === "number" ? p.width : null,
      height: typeof p?.height === "number" ? p.height : null,
    }));

  const blocksMap = blocksByPage(raw);
  const tablesMap = tablesByPage(raw);

  // Page list: prefer docling_raw.pages; fall back to any page numbers
  // discovered in text_blocks; last resort is a single synthetic page so a
  // document with only an unstructured full_text still gets one page.
  let pageNumbers = normalizedRawPages.map((p) => p.page);
  if (pageNumbers.length === 0) {
    const discovered = new Set<number>([...blocksMap.keys(), ...tablesMap.keys()]);
    pageNumbers = discovered.size > 0 ? [...discovered].sort((a, b) => a - b) : [1];
  }

  const pages: CanonicalPage[] = pageNumbers.map((pageNumber) => {
    const rawPage = normalizedRawPages.find((p) => p.page === pageNumber);
    return {
      page_number: pageNumber,
      plain_text: rawPage?.text ?? "",
      blocks: blocksMap.get(pageNumber) ?? [],
      tables: tablesMap.get(pageNumber) ?? [],
      figures: [],
      signature_regions: [],
      selection_marks: [],
      page_width: rawPage?.width ?? null,
      page_height: rawPage?.height ?? null,
    };
  });

  const { text: textProjection, pageMarkersPresent, pageMappingCoverage } = buildTextProjection(raw, normalizedRawPages);
  const fullText = String(raw.full_text ?? "");
  const contentHash = context.contentHash ?? (fullText ? await sha256Hex(fullText) : null);

  return {
    document_id: context.documentId ?? context.uploadedFileId ?? null,
    uploaded_file_id: context.uploadedFileId ?? null,
    org_id: context.orgId ?? null,
    content_hash: contentHash,
    layout_provider: typeof metadata.provider === "string" ? metadata.provider : (typeof raw.extraction_method === "string" ? raw.extraction_method : null),
    layout_api_version: typeof metadata.api_version === "string" ? metadata.api_version : null,
    page_count: typeof raw.page_count === "number" ? raw.page_count : (pages.length || null),
    full_text_chars: countTextChars(fullText),
    text_projection: textProjection,
    pages,
    assets: [],
    metadata: {
      page_markers_present: pageMarkersPresent,
      page_mapping_coverage: pageMappingCoverage,
      layout_contract_version: typeof metadata.layout_contract_version === "string" ? metadata.layout_contract_version : null,
      source_extraction_method: typeof raw.extraction_method === "string" ? raw.extraction_method : null,
    },
  };
}

// ── Layout audit summary (Task D) ────────────────────────────────────────────

export function summarizeCanonicalLayout(layout: CanonicalDocumentLayout | null | undefined): CanonicalLayoutSummary {
  const warnings: string[] = [];

  if (!layout) {
    return {
      layout_provider: null,
      api_version: null,
      page_count: null,
      full_text_chars: 0,
      pages_with_text: 0,
      text_block_count: 0,
      table_count: 0,
      figure_count: 0,
      signature_region_count: 0,
      selection_mark_count: 0,
      page_markers_present: false,
      page_mapping_coverage: null,
      warnings: ["no_canonical_layout"],
    };
  }

  const pages = Array.isArray(layout.pages) ? layout.pages : [];
  if (pages.length === 0) warnings.push("no_pages_detected");

  let pagesWithText = 0;
  let textBlockCount = 0;
  let tableCount = 0;
  let figureCount = 0;
  let signatureRegionCount = 0;
  let selectionMarkCount = 0;

  for (const page of pages) {
    const hasText = typeof page.plain_text === "string" && page.plain_text.trim().length > 0;
    if (hasText) pagesWithText += 1;
    else warnings.push(`empty_page_text:page_${page.page_number}`);

    textBlockCount += Array.isArray(page.blocks) ? page.blocks.length : 0;
    tableCount += Array.isArray(page.tables) ? page.tables.length : 0;
    figureCount += Array.isArray(page.figures) ? page.figures.length : 0;
    signatureRegionCount += Array.isArray(page.signature_regions) ? page.signature_regions.length : 0;
    selectionMarkCount += Array.isArray(page.selection_marks) ? page.selection_marks.length : 0;
  }

  if (!layout.text_projection) warnings.push("empty_text_projection");
  if (layout.full_text_chars === 0) warnings.push("zero_full_text_chars");

  return {
    layout_provider: layout.layout_provider ?? null,
    api_version: layout.layout_api_version ?? null,
    page_count: layout.page_count ?? pages.length ?? null,
    full_text_chars: layout.full_text_chars ?? 0,
    pages_with_text: pagesWithText,
    text_block_count: textBlockCount,
    table_count: tableCount,
    figure_count: figureCount,
    signature_region_count: signatureRegionCount,
    selection_mark_count: selectionMarkCount,
    page_markers_present: Boolean(layout.metadata?.page_markers_present),
    page_mapping_coverage: typeof layout.metadata?.page_mapping_coverage === "number" ? layout.metadata.page_mapping_coverage : null,
    warnings,
  };
}

// ── Evidence anchor helper ───────────────────────────────────────────────────

/**
 * Builds an EvidenceAnchor pointing at a specific block/table cell inside a
 * canonical layout -- for future extraction modules that need to cite
 * exactly where a claim's evidence came from in this richer model (distinct
 * from, and a superset of, the page+source_text pair claims currently
 * carry per Phase 1's simpler Evidence shape).
 */
export function buildEvidenceAnchor(opts: {
  page: number | null;
  sourceText: string | null;
  blockIds?: string[];
  tableId?: string | null;
  cellIds?: string[];
  polygon?: number[];
  supportType: EvidenceSupportType;
}): EvidenceAnchor {
  return {
    page: opts.page ?? null,
    source_text: opts.sourceText ?? null,
    block_ids: opts.blockIds ?? [],
    table_id: opts.tableId ?? null,
    cell_ids: opts.cellIds ?? [],
    polygon: opts.polygon ?? [],
    support_type: opts.supportType,
  };
}

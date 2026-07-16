// @ts-nocheck
/**
 * Canonical Document Layout — provider-neutral layout contract (Phase 1 of
 * the Azure + Vertex canonical pipeline migration).
 *
 * This is the single authoritative canonical layout contract, used both by
 * the legacy Docling-derived path (legacyDoclingToCanonicalLayout, aliased
 * as the original buildCanonicalLayoutFromAzureLikeOutput export for
 * backward compatibility) and by the new Azure-native adapter at
 * ../azure/azure-to-canonical-layout.ts (azureAnalyzeResultToCanonicalLayout).
 *
 * Architecture ownership:
 *   - Azure owns physical document understanding (OCR, page structure,
 *     reading order, tables, coordinates, spans, selection marks).
 *   - This module owns provider-neutral structure only -- no provider-
 *     specific shape may leak through it (enforced by the leakage rule in
 *     the Azure adapter module).
 *   - Vertex owns semantic understanding. Canonical Layout never infers
 *     business meaning -- it only preserves physical anchors. Evidence
 *     ownership belongs to Vertex, never to this module or its validator.
 *
 * Compatibility policy: a CanonicalDocumentLayout generated under schema
 * version X must remain readable by any consumer supporting
 * MINIMUM_SUPPORTED_SCHEMA_VERSION <= X <= CANONICAL_LAYOUT_SCHEMA_VERSION.
 * Consumers must gracefully ignore unknown additive fields and must never
 * require provider-specific fields to function.
 *
 * Schema evolution rules: fields may only be added, never removed in place;
 * existing fields cannot change semantics or type; any removal or semantic
 * change requires bumping CANONICAL_LAYOUT_SCHEMA_VERSION as a separate,
 * explicitly-approved change -- not something Phase 1 does.
 *
 * Contract invariants (checked by validateCanonicalLayout, except the last
 * one which is enforced by construction rather than by runtime check since
 * it spans documents rather than being visible within a single layout):
 *   - Page numbers are unique within a document.
 *   - block_id values are unique within a document.
 *   - table_id / cell_id values are unique within a document.
 *   - Spans never overlap inside a single block.
 *   - reading_order_index is unique per page (where populated).
 *   - Every bounding_regions[].page_number references a page that exists.
 *   - schema_version is set on every newly-built layout.
 *   - Every page belongs to exactly one document (enforced by construction:
 *     each adapter builds fresh CanonicalPage objects per call).
 *
 * ---- Original Phase 5 note (legacy path only) ----
 * legacyDoclingToCanonicalLayout builds a richer, provider-agnostic layout
 * projection from whatever is already persisted on an
 * uploaded_files.docling_raw row (per docs/document-intelligence-v3-baseline.md's
 * confirmed docling_raw shape) -- it does not call Azure, does not re-parse,
 * and does not require the raw Azure response (raw_response is only ever
 * read as "not present" here; STORE_FULL_AZURE_RAW_RESPONSE=false rows work
 * identically to true). Because docling_raw carries no real geometry, every
 * polygon/bounding_regions this path produces is empty -- see the Azure
 * adapter for a lossless, geometry-preserving alternative built directly
 * from Azure's raw analyzeResult.
 */

import { countTextChars } from "../pipeline-contract.ts";
import type { EvidenceSupportType } from "./types.ts";

// ── Schema version & compatibility (Phase 1) ────────────────────────────────

/** Bump only for an explicitly-approved breaking change; additive changes do
 *  not require a version bump. */
export const CANONICAL_LAYOUT_SCHEMA_VERSION = 1;

/** Oldest schema version a consumer must still be able to read. */
export const MINIMUM_SUPPORTED_SCHEMA_VERSION = 1;

/** Constrained provider identifier -- never a bare `string` at the type
 *  level, so a typo or an unvetted provider name is caught at compile time.
 *  Extending this union for a future provider is an additive, non-breaking
 *  change (see the Adapter Registry note in the Phase 1 migration doc). */
export type CanonicalLayoutProvider =
  | "azure_document_intelligence"
  | "legacy_docling_compatibility"
  | "unknown";

// ── Shared geometry/provenance types (Phase 1) ──────────────────────────────

export interface CanonicalSpan {
  offset: number;
  length: number;
}

export interface CanonicalBoundingRegion {
  page_number: number;
  polygon: number[];
}

export interface CanonicalWarning {
  code: string;
  path?: string;
  message: string;
  severity: "recoverable" | "fatal";
}

// ── Types (Task A, Phase 5; extended Phase 1) ───────────────────────────────

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
  /** Phase 1 additions -- optional, never required by any existing consumer. */
  role?: string;
  spans?: CanonicalSpan[];
  bounding_regions?: CanonicalBoundingRegion[];
  reading_order_index?: number | null;
}

export interface CanonicalTableCell {
  cell_id: string;
  row_index: number;
  column_index: number;
  text: string;
  polygon: number[];
  /** Phase 1 additions. */
  row_span?: number;
  column_span?: number;
  kind?: string;
  spans?: CanonicalSpan[];
  bounding_regions?: CanonicalBoundingRegion[];
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
  /** Phase 1 additions. */
  row_count?: number;
  column_count?: number;
  spans?: CanonicalSpan[];
  bounding_regions?: CanonicalBoundingRegion[];
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
  /** Phase 1 additions. */
  page_unit?: string | null;
  spans?: CanonicalSpan[];
  bounding_regions?: CanonicalBoundingRegion[];
}

export interface EvidenceAnchor {
  page: number | null;
  source_text: string | null;
  block_ids: string[];
  table_id: string | null;
  cell_ids: string[];
  polygon: number[];
  support_type: EvidenceSupportType;
  /** Phase 1 additions. */
  spans?: CanonicalSpan[];
  bounding_regions?: CanonicalBoundingRegion[];
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
  /** Phase 1 additions -- schema_version is set on every newly-built layout
   *  (see legacyDoclingToCanonicalLayout and azureAnalyzeResultToCanonicalLayout)
   *  even though it's typed optional for structural backward compatibility
   *  with any old in-memory object built before this field existed. */
  schema_version?: number;
  provider?: CanonicalLayoutProvider;
  provider_model_id?: string | null;
  provider_api_version?: string | null;
  warnings?: CanonicalWarning[];
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

// ── Adapter (Task B, Phase 5) ────────────────────────────────────────────────

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

/**
 * Builds a CanonicalDocumentLayout from the already-persisted, already-lossy
 * docling_raw shape. Renamed from `buildCanonicalLayoutFromAzureLikeOutput`
 * (Phase 1) -- the old name remains exported below as a deprecated alias so
 * no existing caller breaks. Output is unchanged in every respect that
 * existing consumers (document-index-v3.ts, side-write.ts) actually read:
 * same layout summary, same content hash, same document-index projection,
 * same ordering. The only behavioral addition is that `schema_version` and
 * `provider` are now always populated (Task A requirement), which no
 * existing consumer inspects.
 */
export async function legacyDoclingToCanonicalLayout(
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
    schema_version: CANONICAL_LAYOUT_SCHEMA_VERSION,
    provider: "legacy_docling_compatibility",
  };
}

/**
 * @deprecated Use `legacyDoclingToCanonicalLayout` instead (identical
 * implementation, clearer name reflecting that this builds the canonical
 * layout from the already-lossy docling_raw shape, not from a real Azure
 * response). Kept as an alias so no existing import breaks -- do not remove
 * before all known callers have migrated and several releases have passed.
 * For a lossless, geometry-preserving build directly from Azure's raw
 * analyzeResult, see azureAnalyzeResultToCanonicalLayout in
 * ../azure/azure-to-canonical-layout.ts.
 */
export const buildCanonicalLayoutFromAzureLikeOutput = legacyDoclingToCanonicalLayout;

// ── Layout audit summary (Task D, Phase 5) ───────────────────────────────────

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
 * carry per Phase 1's simpler Evidence shape). Note: this only preserves
 * *where* evidence lives structurally -- deciding what counts as evidence,
 * and what it means, belongs to Vertex, never to this module.
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

// ── Text reconstruction helper (Phase 1) ─────────────────────────────────────

export interface PageTextReconstructionResult {
  text: string;
  source: "spans" | "line_fallback" | "none";
}

/**
 * Reconstructs a page's plain text from its canonical spans against the
 * document's authoritative content. Kept as a separate, explicitly-named,
 * provider-neutral helper (operates only on CanonicalSpan + content, never
 * on provider-specific shapes) so page-text derivation is always a
 * traceable, opt-in step rather than something silently folded into an
 * adapter's main construction path -- spans + content remain the lossless
 * source of truth; this is a convenience projection on top of them. Falls
 * back to joining already-extracted line/paragraph text only when spans are
 * absent or invalid against the given content; never fabricates text.
 */
export function reconstructPageTextFromSpans(
  content: string,
  spans: CanonicalSpan[] | undefined,
  fallbackLines: string[] = [],
): PageTextReconstructionResult {
  if (spans && spans.length > 0) {
    const allValid = spans.every(
      (s) =>
        Number.isInteger(s.offset) && s.offset >= 0 &&
        Number.isInteger(s.length) && s.length >= 0 &&
        s.offset + s.length <= content.length,
    );
    if (allValid) {
      const text = spans.map((s) => content.slice(s.offset, s.offset + s.length)).join("");
      return { text, source: "spans" };
    }
  }
  if (fallbackLines.length > 0) {
    return { text: fallbackLines.join("\n"), source: "line_fallback" };
  }
  return { text: "", source: "none" };
}

// ── Canonical layout validator (Phase 1) ─────────────────────────────────────

export interface CanonicalLayoutValidationResult {
  /** false only if any fatal issue exists. */
  valid: boolean;
  errors: CanonicalWarning[];
  warnings: CanonicalWarning[];
}

/**
 * Structural validation only -- ids, spans, pages, polygons, reading order,
 * table dimensions. Never validates lease semantics, business rules,
 * approval rules, or extraction quality: those belong to Vertex's output
 * and to Lease Review's policy layer, never to this validator. This module
 * must remain provider-neutral forever; no lease-specific rule should ever
 * be added here.
 *
 * Pure, O(n) over the layout (one pass over pages/blocks/tables/cells, plus
 * a small per-block sort over that block's own spans -- never a second full
 * traversal), never throws. Recoverable issues (e.g. a malformed polygon on
 * one block) do not invalidate the layout; fatal issues (e.g. a page-count
 * mismatch or corrupt spans) do.
 */
export function validateCanonicalLayout(
  layout: CanonicalDocumentLayout | null | undefined,
): CanonicalLayoutValidationResult {
  const errors: CanonicalWarning[] = [];
  const warnings: CanonicalWarning[] = [];

  if (!layout) {
    errors.push({ code: "missing_layout", message: "No canonical layout provided", severity: "fatal" });
    return { valid: false, errors, warnings };
  }

  const pages = Array.isArray(layout.pages) ? layout.pages : [];

  const declaredPageCount = typeof layout.page_count === "number" ? layout.page_count : null;
  if (declaredPageCount != null && declaredPageCount !== pages.length) {
    errors.push({
      code: "page_count_mismatch",
      path: "page_count",
      message: `Declared page_count ${declaredPageCount} does not match ${pages.length} actual page(s)`,
      severity: "fatal",
    });
  }

  const knownPageNumbers = new Set<number>(pages.map((p) => p.page_number));
  const seenPageNumbers = new Set<number>();
  const seenBlockIds = new Set<string>();
  const seenTableIds = new Set<string>();
  const seenCellIds = new Set<string>();

  let anyPageHasText = false;

  for (const page of pages) {
    if (seenPageNumbers.has(page.page_number)) {
      errors.push({
        code: "duplicate_page_number",
        path: `pages[page_number=${page.page_number}]`,
        message: `Duplicate page_number ${page.page_number}`,
        severity: "fatal",
      });
    }
    seenPageNumbers.add(page.page_number);
    if (typeof page.plain_text === "string" && page.plain_text.trim().length > 0) anyPageHasText = true;

    const seenReadingOrderIndexes = new Set<number>();
    for (const block of page.blocks ?? []) {
      if (seenBlockIds.has(block.block_id)) {
        errors.push({
          code: "duplicate_block_id",
          path: `blocks[${block.block_id}]`,
          message: `Duplicate block_id ${block.block_id}`,
          severity: "fatal",
        });
      }
      seenBlockIds.add(block.block_id);

      if (block.reading_order_index != null) {
        if (seenReadingOrderIndexes.has(block.reading_order_index)) {
          errors.push({
            code: "duplicate_reading_order_index",
            path: `blocks[${block.block_id}].reading_order_index`,
            message: `Duplicate reading_order_index ${block.reading_order_index} on page ${page.page_number}`,
            severity: "fatal",
          });
        }
        seenReadingOrderIndexes.add(block.reading_order_index);
      }

      validateSpans(block.spans, `blocks[${block.block_id}].spans`, errors, (layout.text_projection ?? "").length);
      validatePolygon(block.polygon, `blocks[${block.block_id}].polygon`, warnings);
      for (const region of block.bounding_regions ?? []) {
        if (!knownPageNumbers.has(region.page_number)) {
          errors.push({
            code: "bounding_region_unknown_page",
            path: `blocks[${block.block_id}].bounding_regions`,
            message: `bounding_regions references page ${region.page_number}, which does not exist in this document`,
            severity: "fatal",
          });
        }
        validatePolygon(region.polygon, `blocks[${block.block_id}].bounding_regions`, warnings);
      }
    }

    for (const table of page.tables ?? []) {
      if (seenTableIds.has(table.table_id)) {
        errors.push({
          code: "duplicate_table_id",
          path: `tables[${table.table_id}]`,
          message: `Duplicate table_id ${table.table_id}`,
          severity: "fatal",
        });
      }
      seenTableIds.add(table.table_id);

      let maxRowIndex = -1;
      let maxColumnIndex = -1;
      for (const cell of table.cells ?? []) {
        if (cell.row_index > maxRowIndex) maxRowIndex = cell.row_index;
        if (cell.column_index > maxColumnIndex) maxColumnIndex = cell.column_index;

        if (seenCellIds.has(cell.cell_id)) {
          errors.push({
            code: "duplicate_cell_id",
            path: `cells[${cell.cell_id}]`,
            message: `Duplicate cell_id ${cell.cell_id}`,
            severity: "fatal",
          });
        }
        seenCellIds.add(cell.cell_id);
        validateSpans(cell.spans, `cells[${cell.cell_id}].spans`, errors, (layout.text_projection ?? "").length);
        validatePolygon(cell.polygon, `cells[${cell.cell_id}].polygon`, warnings);
      }

      if (typeof table.row_count === "number" && table.row_count < maxRowIndex + 1) {
        errors.push({
          code: "table_dimensions_conflict",
          path: `tables[${table.table_id}]`,
          message: `table.row_count ${table.row_count} is smaller than the highest cell row_index (${maxRowIndex})`,
          severity: "fatal",
        });
      }
      if (typeof table.column_count === "number" && table.column_count < maxColumnIndex + 1) {
        errors.push({
          code: "table_dimensions_conflict",
          path: `tables[${table.table_id}]`,
          message: `table.column_count ${table.column_count} is smaller than the highest cell column_index (${maxColumnIndex})`,
          severity: "fatal",
        });
      }

      validatePolygon(table.polygon, `tables[${table.table_id}].polygon`, warnings);
      for (const region of table.bounding_regions ?? []) {
        if (!knownPageNumbers.has(region.page_number)) {
          errors.push({
            code: "bounding_region_unknown_page",
            path: `tables[${table.table_id}].bounding_regions`,
            message: `bounding_regions references page ${region.page_number}, which does not exist in this document`,
            severity: "fatal",
          });
        }
      }
    }
  }

  if (pages.length > 0 && !anyPageHasText && !layout.text_projection) {
    errors.push({
      code: "missing_content",
      message: "Layout declares pages but has no page text and no text_projection",
      severity: "fatal",
    });
  }

  if (layout.schema_version == null) {
    errors.push({
      code: "missing_schema_version",
      path: "schema_version",
      message: "schema_version is required on every newly-built layout",
      severity: "fatal",
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateSpans(spans: CanonicalSpan[] | undefined, path: string, errors: CanonicalWarning[], contentLength: number): void {
  if (!spans || spans.length === 0) return;

  for (const span of spans) {
    if (!Number.isInteger(span.offset) || span.offset < 0 || !Number.isInteger(span.length) || span.length < 0) {
      errors.push({
        code: "invalid_span",
        path,
        message: `Span offset/length must be non-negative integers (got offset=${span.offset}, length=${span.length})`,
        severity: "fatal",
      });
    } else if (span.offset + span.length > contentLength) {
      errors.push({
        code: "invalid_span",
        path,
        message: `Span [${span.offset}, ${span.offset + span.length}) exceeds the authoritative content length (${contentLength})`,
        severity: "fatal",
      });
    }
  }

  const sorted = [...spans].sort((a, b) => a.offset - b.offset);
  for (let i = 1; i < sorted.length; i++) {
    const previousEnd = sorted[i - 1].offset + sorted[i - 1].length;
    if (sorted[i].offset < previousEnd) {
      errors.push({ code: "overlapping_spans", path, message: "Spans overlap within the same block", severity: "fatal" });
      break;
    }
  }
}

function validatePolygon(polygon: number[] | undefined, path: string, warnings: CanonicalWarning[]): void {
  if (!polygon || polygon.length === 0) return;
  const isEvenLength = polygon.length % 2 === 0;
  const allFinite = polygon.every((n) => Number.isFinite(n));
  if (!isEvenLength || !allFinite) {
    warnings.push({
      code: "malformed_polygon",
      path,
      message: `Polygon must be a flat, even-length array of finite numbers (length=${polygon.length})`,
      severity: "recoverable",
    });
  }
}

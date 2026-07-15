// @ts-nocheck
/**
 * Vertex Fact Ledger — Canonical-Layout-Backed Document Index (Phase 6)
 *
 * An OPT-IN alternate to document-index.ts's buildCanonicalDocumentIndex().
 * document-index.ts itself is untouched by this file (per Phase 6 Task A:
 * "do not rewrite the whole module") -- this is a new, additive sibling that
 * orchestrator.ts calls conditionally, falling straight back to the
 * existing legacy_evidence_index path on any failure or when not opted in.
 *
 * Reuses, rather than reimplements:
 *   - canonical-layout.ts's buildCanonicalLayoutFromAzureLikeOutput() (Phase 5)
 *     to build the richer CanonicalDocumentLayout from persisted docling_raw.
 *   - evidence-index.ts's buildEvidenceIndex()/normalizeForPageMatch()/
 *     compactForPageMatch() for the actual page-matching machinery, so this
 *     module and legacy_hybrid never disagree about how a snippet maps to a
 *     page for the same underlying text.
 *   - document-index.ts's own buildCanonicalDocumentIndex() as the fallback.
 */

import { buildEvidenceIndex, normalizeForPageMatch, compactForPageMatch } from "../evidence-index.ts";
import { isDocumentIntelligenceV3Enabled } from "../document-intelligence-v3/feature-flag.ts";
import {
  buildCanonicalLayoutFromAzureLikeOutput,
  type CanonicalDocumentLayout,
  type BuildCanonicalLayoutContext,
} from "../document-intelligence-v3/canonical-layout.ts";
import { buildCanonicalDocumentIndex } from "./document-index.ts";
import type { CanonicalDocumentIndex, Fact } from "./types.ts";

const HEAD_CHARS = 8000;
const TAIL_CHARS = 2000;

function buildHeadTailExcerpt(fullText: string): string {
  if (fullText.length <= HEAD_CHARS + TAIL_CHARS) return fullText;
  const head = fullText.slice(0, HEAD_CHARS);
  const tail = fullText.slice(-TAIL_CHARS);
  return `${head}\n\n[... document truncated for classification ...]\n\n${tail}`;
}

export interface CanonicalLayoutDocumentIndex extends CanonicalDocumentIndex {
  canonicalLayout: CanonicalDocumentLayout;
  blockIds: string[];
  tablePlaceholders: Array<{ table_id: string; page_number: number | null }>;
  figurePlaceholders: Array<{ asset_id: string; page_number: number | null }>;
  signaturePlaceholders: Array<{ region_id: string; page_number: number | null }>;
}

/**
 * Projects a CanonicalDocumentLayout back into a doclingRaw-compatible
 * object -- this is what lets buildEvidenceIndex(), chunkDocument(), and
 * resolveVerifiedSourcePage() (all doclingRaw-shaped consumers used
 * downstream by fact-ledger-extractor.ts) keep working completely
 * unchanged when handed this index, with zero signature changes to any of
 * them (Task A: "do not rewrite the whole module").
 */
function projectLayoutToDoclingRaw(layout: CanonicalDocumentLayout): Record<string, unknown> {
  const textBlocks: Array<Record<string, unknown>> = [];
  let blockIndex = 0;
  for (const page of layout.pages) {
    for (const block of page.blocks) {
      textBlocks.push({
        block_index: blockIndex++,
        type: block.kind,
        text: block.text,
        page: block.page_number,
      });
    }
  }

  const tables: Array<Record<string, unknown>> = [];
  let tableIndex = 0;
  for (const page of layout.pages) {
    for (const table of page.tables) {
      const headerRow = table.cells.filter((c) => c.row_index === 0).sort((a, b) => a.column_index - b.column_index);
      const dataRows = new Map<number, string[]>();
      for (const cell of table.cells) {
        if (cell.row_index === 0 && headerRow.length > 0) continue;
        const row = dataRows.get(cell.row_index) ?? [];
        row[cell.column_index] = cell.text;
        dataRows.set(cell.row_index, row);
      }
      tables.push({
        table_index: tableIndex++,
        headers: headerRow.map((c) => c.text),
        rows: [...dataRows.values()],
        page: table.page_number,
      });
    }
  }

  return {
    extraction_method: layout.layout_provider ?? "canonical_layout",
    full_text: layout.text_projection,
    page_count: layout.page_count,
    pages: layout.pages.map((p) => ({ page: p.page_number, text: p.plain_text, width: p.page_width, height: p.page_height })),
    text_blocks: textBlocks,
    tables,
    fields: [],
    warnings: [],
    _metadata: layout.metadata,
  };
}

export function buildCanonicalDocumentIndexFromLayout(layout: CanonicalDocumentLayout): CanonicalLayoutDocumentIndex {
  const projected = projectLayoutToDoclingRaw(layout);
  const fullText = layout.text_projection || String(projected.full_text ?? "");

  return {
    fullText,
    pageCount: layout.page_count,
    evidenceIndex: buildEvidenceIndex(projected),
    headTailExcerpt: buildHeadTailExcerpt(fullText),
    doclingRaw: projected,
    canonicalLayout: layout,
    blockIds: layout.pages.flatMap((p) => p.blocks.map((b) => b.block_id)),
    tablePlaceholders: layout.pages.flatMap((p) => p.tables.map((t) => ({ table_id: t.table_id, page_number: t.page_number }))),
    figurePlaceholders: layout.pages.flatMap((p) => p.figures.map((f) => ({ asset_id: f.asset_id, page_number: f.page_number }))),
    signaturePlaceholders: layout.pages.flatMap((p) => p.signature_regions.map((s) => ({ region_id: s.region_id, page_number: s.page_number }))),
  };
}

export type DocumentIndexSource = "canonical_layout" | "legacy_evidence_index";

export interface ResolveDocumentIndexOptions {
  /** Explicit override, primarily for tests (Phase 6 Task D: "the provider
   *  path is already vertex_fact_ledger or an explicit test calls it").
   *  Undefined defers to ENABLE_DOCUMENT_INTELLIGENCE_V3. */
  strategy?: DocumentIndexSource;
  context?: BuildCanonicalLayoutContext;
}

export interface ResolveDocumentIndexResult {
  index: CanonicalDocumentIndex | CanonicalLayoutDocumentIndex;
  indexSource: DocumentIndexSource;
  fallbackReason: string | null;
}

/**
 * Resolves which document index to use. Default (no explicit strategy,
 * flag off) is byte-for-byte the existing behavior: calls
 * document-index.ts's buildCanonicalDocumentIndex() directly, synchronously
 * equivalent to before this file existed. Only when
 * ENABLE_DOCUMENT_INTELLIGENCE_V3=true (or a caller explicitly requests
 * strategy: "canonical_layout") does this attempt the richer canonical
 * layout path -- and even then, any failure (or a degenerate layout with no
 * pages and no text) falls straight back to the legacy path, logs a
 * diagnostic warning, and never throws beyond what the legacy path itself
 * would throw (Task C).
 */
export async function resolveDocumentIndex(
  doclingRaw: Record<string, unknown> | null | undefined,
  options: ResolveDocumentIndexOptions = {},
): Promise<ResolveDocumentIndexResult> {
  const shouldTryCanonical =
    options.strategy === "canonical_layout" ||
    (options.strategy !== "legacy_evidence_index" && isDocumentIntelligenceV3Enabled());

  if (!shouldTryCanonical) {
    return { index: buildCanonicalDocumentIndex(doclingRaw), indexSource: "legacy_evidence_index", fallbackReason: null };
  }

  try {
    const layout = await buildCanonicalLayoutFromAzureLikeOutput(doclingRaw, options.context ?? {});
    if (layout.pages.length === 0 && !layout.text_projection) {
      throw new Error("canonical layout has no pages and no text_projection");
    }
    return { index: buildCanonicalDocumentIndexFromLayout(layout), indexSource: "canonical_layout", fallbackReason: null };
  } catch (error) {
    const message = (error as Error)?.message ?? String(error);
    console.warn(`[document-index-v3] canonical layout unavailable, falling back to legacy_evidence_index: ${message}`);
    return {
      index: buildCanonicalDocumentIndex(doclingRaw),
      indexSource: "legacy_evidence_index",
      fallbackReason: `canonical_layout_failed: ${message}`,
    };
  }
}

/**
 * Enriches a fact with block-level evidence (Task E) by locating a block on
 * the fact's claimed page whose text contains the fact's source_text.
 * Never fabricates: no match (or no layout/page/source_text at all) leaves
 * blockIds/polygon empty and supportType null, exactly like Phase 1's
 * Evidence model already treats an unfound source.
 */
export function enrichFactWithBlockEvidence(
  fact: Fact,
  layout: CanonicalDocumentLayout | null | undefined,
): Fact & { blockIds: string[]; polygon: number[]; supportType: string | null } {
  const empty = { ...fact, blockIds: [] as string[], polygon: [] as number[], supportType: null as string | null };
  if (!layout || fact.sourcePage == null || !fact.sourceText) return empty;

  const page = layout.pages.find((p) => p.page_number === fact.sourcePage);
  if (!page) return empty;

  const normalizedSource = normalizeForPageMatch(fact.sourceText);
  const compactSource = compactForPageMatch(fact.sourceText);
  if (normalizedSource.length < 8) return empty;

  const match = page.blocks.find((block) => {
    const normalizedBlock = normalizeForPageMatch(block.text);
    if (normalizedBlock.includes(normalizedSource)) return true;
    if (compactSource.length < 24) return false;
    return compactForPageMatch(block.text).includes(compactSource);
  });

  if (!match) return empty;
  return { ...fact, blockIds: [match.block_id], polygon: match.polygon ?? [], supportType: "direct_quote" };
}

// @ts-nocheck

import type { DoclingOutput, DoclingTable, DoclingTextBlock } from "./types.ts";

export function normalizeAzureLayoutToDoclingOutput(
  analyzeResult: Record<string, unknown>,
  opts: { apiVersion?: string; modelId?: string; warnings?: string[] } = {},
): DoclingOutput {
  const content = String((analyzeResult as any)?.content ?? "");
  const pages = Array.isArray((analyzeResult as any)?.pages) ? (analyzeResult as any).pages : [];
  const paragraphs = Array.isArray((analyzeResult as any)?.paragraphs) ? (analyzeResult as any).paragraphs : [];
  const tables = Array.isArray((analyzeResult as any)?.tables) ? (analyzeResult as any).tables : [];
  const textBlocks: DoclingTextBlock[] = [];

  // Paragraphs are the canonical text_blocks. Page lines are used only when
  // Azure returned no paragraphs — storing both duplicates nearly all of the
  // document text and doubles memory/JSONB size for long leases. Page-level
  // text (normalizedPages below) still keeps per-page line text for evidence
  // matching.
  if (paragraphs.length > 0) {
    for (const paragraph of paragraphs) {
      const text = cleanText(paragraph?.content);
      if (!text) continue;
      textBlocks.push({
        block_index: textBlocks.length,
        type: String(paragraph?.role || "paragraph"),
        text,
        page: firstBoundingPage(paragraph),
        span: firstSpan(paragraph),
      });
    }
  } else {
    for (const page of pages) {
      const pageNumber = positiveNumber(page?.pageNumber) ?? textBlocks.length + 1;
      for (const line of Array.isArray(page?.lines) ? page.lines : []) {
        const text = cleanText(line?.content);
        if (!text) continue;
        textBlocks.push({
          block_index: textBlocks.length,
          type: "line",
          text,
          page: pageNumber,
          span: firstSpan(line),
        });
      }
    }
  }

  const normalizedPages = pages.map((page: any, index: number) => {
    const pageNumber = positiveNumber(page?.pageNumber) ?? index + 1;
    const pageText = (Array.isArray(page?.lines) ? page.lines : [])
      .map((line: any) => cleanText(line?.content))
      .filter(Boolean)
      .join("\n");
    return {
      page: pageNumber,
      text: pageText,
      width: page?.width ?? null,
      height: page?.height ?? null,
      unit: page?.unit ?? null,
    };
  });

  const normalizedTables: DoclingTable[] = tables.map((table: any, tableIndex: number) => {
    const cells = Array.isArray(table?.cells) ? table.cells : [];
    const rowCount = positiveNumber(table?.rowCount) ?? inferMaxIndex(cells, "rowIndex") + 1;
    const columnCount = positiveNumber(table?.columnCount) ?? inferMaxIndex(cells, "columnIndex") + 1;
    const matrix: string[][] = Array.from({ length: Math.max(rowCount, 0) }, () =>
      Array.from({ length: Math.max(columnCount, 0) }, () => ""),
    );

    for (const cell of cells) {
      const row = nonNegativeNumber(cell?.rowIndex) ?? 0;
      const column = nonNegativeNumber(cell?.columnIndex) ?? 0;
      if (!matrix[row]) matrix[row] = [];
      matrix[row][column] = cleanText(cell?.content);
    }

    const firstRow = matrix[0] ?? [];
    const hasHeaderCells = cells.some((cell: any) => String(cell?.kind || "").toLowerCase().includes("header"));
    const headers = hasHeaderCells || matrix.length > 1
      ? firstRow.map((value, index) => value || `column_${index + 1}`)
      : [];
    const rows = headers.length > 0 ? matrix.slice(1) : matrix;

    return {
      table_index: tableIndex,
      headers,
      rows,
      markdown: matrix.map((row) => row.join("\t")).join("\n"),
    };
  });

  const fallbackBlocks = textBlocks.length > 0 ? [] : textToBlocks(content);
  const normalizedTextBlocks = textBlocks.length > 0 ? textBlocks : fallbackBlocks;
  const rawResponseStored = Deno.env.get("STORE_FULL_AZURE_RAW_RESPONSE")?.toLowerCase() === "true";
  const pageCount = normalizedPages.length || positiveNumber((analyzeResult as any)?.pageCount) || null;

  // Every legacy parser (native PDF text, Gemini Vision, Docling) emits
  // full_text as `[[PAGE n]]\n<page text>` joined blocks. Azure's raw content
  // has no such markers, so the LLM extraction prompt's page-anchoring rule
  // (source_page is only required when [[PAGE n]] markers are present) never
  // fires for Azure documents — every field comes back with source_page=null,
  // forcing an expensive brute-force page-matching scan downstream. Insert
  // markers using the most precise data Azure gave us, falling through
  // progressively less precise strategies rather than ever silently
  // returning unmarked content while any page mapping exists.
  const markedContent = buildPageMarkedContent(content, pages, paragraphs);

  const rawResponseSummary = {
    provider: "azure_document_intelligence",
    extraction_method: "azure_layout",
    model_id: opts.modelId ?? null,
    api_version: opts.apiVersion ?? null,
    output_format: "markdown",
    page_count: pageCount,
    paragraph_count: paragraphs.length,
    table_count: normalizedTables.length,
    text_block_count: normalizedTextBlocks.length,
    content_length: content.length,
    raw_response_stored: rawResponseStored,
  };

  const output: DoclingOutput & Record<string, unknown> = {
    extraction_method: "azure_layout",
    full_text: markedContent.text,
    markdown: content,
    page_count: pageCount,
    pages: normalizedPages,
    text_blocks: normalizedTextBlocks,
    tables: normalizedTables,
    fields: [],
    warnings: opts.warnings ?? [],
    raw_response: rawResponseStored ? analyzeResult : null,
    raw_response_summary: rawResponseSummary,
    _metadata: {
      provider: "azure_document_intelligence",
      extraction_method: "azure_layout",
      model_id: opts.modelId ?? null,
      api_version: opts.apiVersion ?? null,
      output_format: "markdown",
      content_format: "markdown",
      raw_response_stored: rawResponseStored,
      layout_contract_version: "document_layout_v1",
      canonical_layout_present: true,
      page_markers_present: markedContent.strategy !== "unmapped_content",
      page_marker_strategy: markedContent.strategy,
      page_mapping_coverage: markedContent.coverage,
    },
  };

  return output;
}

/**
 * Insert [[PAGE n]] markers into Azure's document text, preferring the most
 * precise page-mapping data available:
 *   1. content_spans            — page.spans[] partition `content` exactly;
 *                                  markers inserted directly into the
 *                                  original markdown, preserving tables/
 *                                  headings/lists verbatim.
 *   2. paragraph_bounding_regions — paragraphs grouped by
 *                                  boundingRegions[0].pageNumber, ordered by
 *                                  their span offset within the page.
 *   3. page_lines               — reconstructed from page.lines[] (always
 *                                  available whenever Azure returned pages).
 *   4. unmapped_content         — no page mapping exists at all; original
 *                                  content is kept as-is and explicitly
 *                                  flagged degraded via _metadata.
 */
function buildPageMarkedContent(
  content: string,
  pages: any[],
  paragraphs: any[],
): { text: string; strategy: string; coverage: number } {
  if (!content) {
    return { text: content, strategy: "unmapped_content", coverage: 0 };
  }

  const pageSpans = pages
    .map((page: any, index: number) => {
      const pageNumber = positiveNumber(page?.pageNumber) ?? index + 1;
      const spans = Array.isArray(page?.spans) ? page.spans : [];
      const offset = nonNegativeNumber(spans[0]?.offset);
      const length = nonNegativeNumber(spans[0]?.length);
      return offset != null && length != null ? { pageNumber, offset, length } : null;
    })
    .filter((p: any): p is { pageNumber: number; offset: number; length: number } => p != null)
    .sort((a, b) => a.offset - b.offset);

  if (pageSpans.length > 0) {
    const totalSpanLength = pageSpans.reduce((sum, p) => sum + p.length, 0);
    const coverage = content.length > 0 ? Math.min(1, totalSpanLength / content.length) : 0;
    const parts: string[] = [];
    let cursor = 0;
    for (const p of pageSpans) {
      const end = p.offset + p.length;
      parts.push(`[[PAGE ${p.pageNumber}]]\n${content.slice(p.offset, end)}`);
      cursor = Math.max(cursor, end);
    }
    if (cursor < content.length) {
      parts.push(content.slice(cursor));
    }
    return { text: parts.join("\n\n"), strategy: "content_spans", coverage };
  }

  if (paragraphs.length > 0) {
    const byPage = new Map<number, Array<{ offset: number; text: string }>>();
    let mapped = 0;
    for (const para of paragraphs) {
      const page = firstBoundingPage(para);
      const text = cleanText(para?.content);
      if (!page || !text) continue;
      mapped++;
      const spans = Array.isArray(para?.spans) ? para.spans : [];
      const offset = nonNegativeNumber(spans[0]?.offset) ?? Number.MAX_SAFE_INTEGER;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push({ offset, text });
    }
    if (byPage.size > 0) {
      const coverage = paragraphs.length > 0 ? mapped / paragraphs.length : 0;
      const pageNumbers = [...byPage.keys()].sort((a, b) => a - b);
      const parts = pageNumbers.map((pageNumber) => {
        const items = byPage.get(pageNumber)!.sort((a, b) => a.offset - b.offset);
        return `[[PAGE ${pageNumber}]]\n${items.map((item) => item.text).join("\n\n")}`;
      });
      return { text: parts.join("\n\n"), strategy: "paragraph_bounding_regions", coverage };
    }
  }

  if (pages.length > 0) {
    const parts: string[] = [];
    let mappedChars = 0;
    pages.forEach((page: any, index: number) => {
      const pageNumber = positiveNumber(page?.pageNumber) ?? index + 1;
      const lines = Array.isArray(page?.lines) ? page.lines : [];
      const pageText = lines.map((line: any) => cleanText(line?.content)).filter(Boolean).join("\n");
      if (pageText) {
        parts.push(`[[PAGE ${pageNumber}]]\n${pageText}`);
        mappedChars += pageText.length;
      }
    });
    if (parts.length > 0) {
      const coverage = content.length > 0 ? Math.min(1, mappedChars / content.length) : 0;
      return { text: parts.join("\n\n"), strategy: "page_lines", coverage };
    }
  }

  return { text: content, strategy: "unmapped_content", coverage: 0 };
}

function cleanText(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function nonNegativeNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function positiveNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function firstBoundingPage(value: Record<string, unknown>): number | undefined {
  const regions = Array.isArray(value?.boundingRegions) ? value.boundingRegions : [];
  const page = positiveNumber(regions[0]?.pageNumber);
  return page ?? undefined;
}

// Lightweight provenance: offset/length into analyzeResult.content. Metadata
// only — never duplicates text.
function firstSpan(value: Record<string, unknown>): { offset: number; length: number } | undefined {
  const spans = Array.isArray((value as any)?.spans) ? (value as any).spans : [];
  const offset = nonNegativeNumber(spans[0]?.offset);
  const length = nonNegativeNumber(spans[0]?.length);
  return offset != null && length != null ? { offset, length } : undefined;
}

function inferMaxIndex(cells: any[], key: string): number {
  return cells.reduce((max, cell) => {
    const value = nonNegativeNumber(cell?.[key]);
    return value == null ? max : Math.max(max, value);
  }, -1);
}

function textToBlocks(text: string): DoclingTextBlock[] {
  return String(text || "")
    .split(/\n\s*\n/)
    .map((block) => cleanText(block))
    .filter(Boolean)
    .map((block, index) => ({
      block_index: index,
      type: "paragraph",
      text: block,
      page: 1,
    }));
}
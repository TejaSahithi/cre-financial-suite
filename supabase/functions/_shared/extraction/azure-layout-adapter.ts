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
    full_text: content,
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
    },
  };

  return output;
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
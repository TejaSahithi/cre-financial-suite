// @ts-nocheck

import type { DoclingOutput } from "../types.ts";

export const COMPACT_DOCUMENT_VERSION = "lease-compact-document-v1";
export const PERSISTED_COMPACT_DOCUMENT_KEY = "_whole_document_llm_compact";

export interface CompactDocumentNode {
  id: string;
  kind: "page" | "block";
  page: number | null;
  text: string;
}

export interface CompactDocumentTable {
  id: string;
  page: number | null;
  headers: string[];
  rows: Array<{ id: string; cells: string[] }>;
}

export interface CompactDocumentField {
  id: string;
  key: string;
  value: string;
  page: number | null;
  sourceText: string | null;
}

export interface CompactLeaseDocument {
  version: typeof COMPACT_DOCUMENT_VERSION;
  source: "azure_full_layout" | "persisted_compact" | "available_docling";
  pageCount: number | null;
  nodes: CompactDocumentNode[];
  tables: CompactDocumentTable[];
  keyValues: CompactDocumentField[];
  diagnostics: {
    characterCount: number;
    nodeCount: number;
    tableCount: number;
    tableRowCount: number;
    keyValueCount: number;
    inputWasTruncated: boolean;
  };
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\u0000/g, "").trim() : "";
}

function buildNodes(docling: Record<string, unknown>): CompactDocumentNode[] {
  const pages = Array.isArray((docling as any).pages) ? (docling as any).pages : [];
  const pageNodes = pages
    .map((page: any, index: number) => {
      const pageNumber = positiveInteger(page?.page) ?? index + 1;
      const text = cleanText(page?.text);
      return text
        ? { id: `page:${pageNumber}`, kind: "page" as const, page: pageNumber, text }
        : null;
    })
    .filter(Boolean) as CompactDocumentNode[];

  // Azure page lines are the least noisy complete reading surface and avoid
  // duplicating paragraph text in the prompt. Older/non-Azure rows sometimes
  // have blocks but no pages, so blocks are the deterministic fallback.
  if (pageNodes.length > 0) return pageNodes;

  const blocks = Array.isArray((docling as any).text_blocks) ? (docling as any).text_blocks : [];
  return blocks
    .map((block: any, index: number) => {
      const blockIndex = Number.isInteger(Number(block?.block_index))
        ? Number(block.block_index)
        : index;
      const text = cleanText(block?.text);
      return text
        ? {
          id: `block:${blockIndex}`,
          kind: "block" as const,
          page: positiveInteger(block?.page),
          text,
        }
        : null;
    })
    .filter(Boolean) as CompactDocumentNode[];
}

function buildTables(docling: Record<string, unknown>): CompactDocumentTable[] {
  const tables = Array.isArray((docling as any).tables) ? (docling as any).tables : [];
  return tables.map((table: any, index: number) => {
    const tableIndex = Number.isInteger(Number(table?.table_index))
      ? Number(table.table_index)
      : index;
    const id = `table:${tableIndex}`;
    const headers = Array.isArray(table?.headers) ? table.headers.map(cleanText) : [];
    const rows = Array.isArray(table?.rows)
      ? table.rows.map((row: any, rowIndex: number) => ({
        id: `${id}:row:${rowIndex}`,
        cells: Array.isArray(row) ? row.map(cleanText) : [cleanText(row)],
      }))
      : [];
    return {
      id,
      page: positiveInteger(table?.page),
      headers,
      rows,
    };
  });
}

function buildKeyValues(docling: Record<string, unknown>): CompactDocumentField[] {
  const fields = Array.isArray((docling as any).fields) ? (docling as any).fields : [];
  return fields
    .map((field: any, index: number) => {
      const key = cleanText(field?.key);
      const value = cleanText(field?.value);
      if (!key && !value) return null;
      return {
        id: `key_value:${index}`,
        key,
        value,
        page: positiveInteger(field?.page),
        sourceText: cleanText(field?.source_text) || null,
      };
    })
    .filter(Boolean) as CompactDocumentField[];
}

export function isCompactLeaseDocument(value: unknown): value is CompactLeaseDocument {
  return !!value &&
    typeof value === "object" &&
    (value as any).version === COMPACT_DOCUMENT_VERSION &&
    Array.isArray((value as any).nodes) &&
    Array.isArray((value as any).tables);
}

/**
 * Create a semantically lossless representation of the normalized Azure
 * layout: complete page text, tables, and key-values; no polygons, styles,
 * duplicated markdown, or provider response metadata.
 */
export function buildCompactLeaseDocument(
  input: DoclingOutput | Record<string, unknown>,
  source: CompactLeaseDocument["source"] = "available_docling",
): CompactLeaseDocument {
  const docling = (input ?? {}) as Record<string, unknown>;
  const persisted = (docling as any)[PERSISTED_COMPACT_DOCUMENT_KEY];
  if (isCompactLeaseDocument(persisted)) {
    return { ...persisted, source: "persisted_compact" };
  }

  const nodes = buildNodes(docling);
  const tables = buildTables(docling);
  const keyValues = buildKeyValues(docling);
  const characterCount =
    nodes.reduce((sum, node) => sum + node.text.length, 0) +
    tables.reduce(
      (sum, table) => sum +
        table.headers.join("\t").length +
        table.rows.reduce((rowSum, row) => rowSum + row.cells.join("\t").length, 0),
      0,
    ) +
    keyValues.reduce((sum, field) => sum + field.key.length + field.value.length + (field.sourceText?.length ?? 0), 0);

  return {
    version: COMPACT_DOCUMENT_VERSION,
    source,
    pageCount: positiveInteger((docling as any).page_count),
    nodes,
    tables,
    keyValues,
    diagnostics: {
      characterCount,
      nodeCount: nodes.length,
      tableCount: tables.length,
      tableRowCount: tables.reduce((sum, table) => sum + table.rows.length, 0),
      keyValueCount: keyValues.length,
      inputWasTruncated:
        Boolean((docling as any)?._metadata?.text_truncated) ||
        Boolean((docling as any)?._metadata?.blocks_truncated) ||
        String((docling as any)?.full_text ?? "").includes("[truncated]"),
    },
  };
}

export function compactDocumentEvidenceMap(document: CompactLeaseDocument): Map<string, { text: string; page: number | null }> {
  const evidence = new Map<string, { text: string; page: number | null }>();
  for (const node of document.nodes) {
    evidence.set(node.id, { text: node.text, page: node.page });
  }
  for (const table of document.tables) {
    evidence.set(table.id, {
      text: [table.headers.join("\t"), ...table.rows.map((row) => row.cells.join("\t"))].filter(Boolean).join("\n"),
      page: table.page,
    });
    for (const row of table.rows) {
      evidence.set(row.id, { text: row.cells.join("\t"), page: table.page });
    }
  }
  for (const field of document.keyValues) {
    evidence.set(field.id, {
      text: field.sourceText || `${field.key}: ${field.value}`,
      page: field.page,
    });
  }
  return evidence;
}

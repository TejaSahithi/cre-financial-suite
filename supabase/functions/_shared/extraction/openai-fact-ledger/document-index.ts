// @ts-nocheck
/**
 * OpenAI Fact Ledger — Canonical Document Index
 *
 * Thin wrapper promoting evidence-index.ts's existing buildEvidenceIndex().
 * Does NOT reimplement page indexing — the WeakMap-cached page/keyword index
 * built there is reused as-is so this module and the legacy_hybrid pipeline
 * never disagree about page boundaries for the same docling_raw object.
 */

import type { DoclingOutput } from "../types.ts";
import { buildEvidenceIndex } from "../evidence-index.ts";
import type { CanonicalDocumentIndex } from "./types.ts";

const HEAD_CHARS = 8000;
const TAIL_CHARS = 2000;

function buildHeadTailExcerpt(fullText: string): string {
  if (fullText.length <= HEAD_CHARS + TAIL_CHARS) return fullText;
  const head = fullText.slice(0, HEAD_CHARS);
  const tail = fullText.slice(-TAIL_CHARS);
  return `${head}\n\n[... document truncated for classification ...]\n\n${tail}`;
}

function resolvePageCount(doclingRaw: Record<string, unknown> | null | undefined): number | null {
  const explicit = Number((doclingRaw as any)?.page_count);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const blocks = Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : [];
  const pages = new Set<number>();
  for (const block of blocks) {
    const page = Number(block?.page ?? block?.page_number ?? block?.source_page);
    if (Number.isFinite(page) && page > 0) pages.add(page);
  }
  return pages.size || null;
}

/**
 * Build the canonical, read-only document index every openai-fact-ledger
 * module operates against. `doclingRaw` must be the same object reference
 * used elsewhere in the request so buildEvidenceIndex()'s WeakMap cache hits.
 */
export function buildCanonicalDocumentIndex(
  doclingRaw: DoclingOutput | Record<string, unknown> | null | undefined,
): CanonicalDocumentIndex {
  const fullText = String((doclingRaw as any)?.full_text ?? (doclingRaw as any)?.markdown ?? "");
  return {
    fullText,
    pageCount: resolvePageCount(doclingRaw),
    evidenceIndex: buildEvidenceIndex(doclingRaw as Record<string, unknown> | null | undefined),
    headTailExcerpt: buildHeadTailExcerpt(fullText),
    doclingRaw: doclingRaw ?? { text_blocks: [], tables: [], fields: [], full_text: fullText },
  };
}

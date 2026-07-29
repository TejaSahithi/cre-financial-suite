// @ts-nocheck
import type { EnrichBoundedStageMode } from "./enrich-bounded-stage/feature-mode.ts";

export interface EnrichInputSize {
  fullTextChars: number;
  pageCount: number;
  textBlockCount: number;
}

function envBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(Deno.env.get(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

export function monolithicEnrichMaxFullTextChars(): number {
  return envBoundedInt("MONOLITHIC_ENRICH_MAX_FULL_TEXT_CHARS", 60_000, 10_000, 150_000);
}

export function monolithicEnrichMaxPages(): number {
  return envBoundedInt("MONOLITHIC_ENRICH_MAX_PAGES", 15, 5, 80);
}

export function monolithicEnrichMaxTextBlocks(): number {
  return envBoundedInt("MONOLITHIC_ENRICH_MAX_TEXT_BLOCKS", 1_200, 100, 4_000);
}

export function normalizeEnrichInputSize(raw: Partial<EnrichInputSize> | null | undefined): EnrichInputSize {
  return {
    fullTextChars: Math.max(0, Number(raw?.fullTextChars ?? 0) || 0),
    pageCount: Math.max(0, Number(raw?.pageCount ?? 0) || 0),
    textBlockCount: Math.max(0, Number(raw?.textBlockCount ?? 0) || 0),
  };
}

export function readEnrichInputSizeFromDocling(doclingRaw: Record<string, unknown> | null | undefined): EnrichInputSize {
  const metadata = (doclingRaw as any)?._metadata ?? {};
  const textBlocks = Array.isArray((doclingRaw as any)?.text_blocks) ? (doclingRaw as any).text_blocks : [];
  return normalizeEnrichInputSize({
    fullTextChars: Number(metadata.full_text_chars ?? String((doclingRaw as any)?.full_text ?? "").length),
    pageCount: Number(metadata.page_count ?? (doclingRaw as any)?.page_count ?? 0),
    textBlockCount: Number(metadata.text_block_count ?? textBlocks.length),
  });
}

export function monolithicEnrichGuardReasons(size: EnrichInputSize): string[] {
  const normalized = normalizeEnrichInputSize(size);
  const reasons: string[] = [];
  const maxFullTextChars = monolithicEnrichMaxFullTextChars();
  const maxPages = monolithicEnrichMaxPages();
  const maxTextBlocks = monolithicEnrichMaxTextBlocks();
  if (normalized.fullTextChars > maxFullTextChars) reasons.push(`fullTextChars ${normalized.fullTextChars} > ${maxFullTextChars}`);
  if (normalized.pageCount > maxPages) reasons.push(`pageCount ${normalized.pageCount} > ${maxPages}`);
  if (normalized.textBlockCount > maxTextBlocks) reasons.push(`textBlockCount ${normalized.textBlockCount} > ${maxTextBlocks}`);
  return reasons;
}

export function isMonolithicEnrichUnsafeForSize(size: EnrichInputSize): boolean {
  return monolithicEnrichGuardReasons(size).length > 0;
}

export function shouldUseBoundedEnrich(mode: EnrichBoundedStageMode, size: EnrichInputSize): boolean {
  void mode;
  void size;
  return true;
}

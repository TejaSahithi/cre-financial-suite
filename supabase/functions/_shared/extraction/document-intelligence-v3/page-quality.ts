// @ts-nocheck

import type { CanonicalDocumentLayout } from "./canonical-layout.ts";
import { isValidPolygon } from "./layout-provenance.ts";

export const PAGE_QUALITY_VERSION = "page-quality-v1";
export const LOW_TEXT_CHARACTER_THRESHOLD = 40;
export const LOW_CONFIDENCE_THRESHOLD = 0.55;

export type PageProcessingStatus =
  | "complete"
  | "blank_confirmed"
  | "low_text"
  | "low_confidence"
  | "possibly_missing"
  | "unreadable";

export interface PageProcessingResult {
  pageNumber: number;
  expected: boolean;
  textLength: number;
  blockCount: number;
  tableCount: number;
  figureCount: number;
  selectionMarkCount: number;
  averageConfidence: number | null;
  geometryCoverage: number;
  status: PageProcessingStatus;
  reasonCodes: string[];
}

export function computePageQuality(
  layout: CanonicalDocumentLayout | null | undefined,
  opts: { expectedPageCount?: number | null; azureNative?: boolean } = {},
): PageProcessingResult[] {
  const pages = Array.isArray(layout?.pages) ? layout!.pages : [];
  const expectedPageCount = positiveInteger(opts.expectedPageCount) ?? positiveInteger(layout?.page_count) ?? pages.length;
  const byPage = new Map<number, any>();
  for (const page of pages) {
    const pageNumber = positiveInteger(page?.page_number);
    if (pageNumber != null && !byPage.has(pageNumber)) byPage.set(pageNumber, page);
  }

  const upper = Math.max(expectedPageCount, ...[...byPage.keys(), 0]);
  const results: PageProcessingResult[] = [];
  for (let pageNumber = 1; pageNumber <= upper; pageNumber++) {
    const page = byPage.get(pageNumber) ?? null;
    results.push(computeSinglePageQuality(page, pageNumber, pageNumber <= expectedPageCount, opts.azureNative === true));
  }
  return results;
}

export function computeSinglePageQuality(
  page: any,
  pageNumber: number,
  expected: boolean,
  azureNative: boolean,
): PageProcessingResult {
  if (!page) {
    return {
      pageNumber,
      expected,
      textLength: 0,
      blockCount: 0,
      tableCount: 0,
      figureCount: 0,
      selectionMarkCount: 0,
      averageConfidence: null,
      geometryCoverage: 0,
      status: "possibly_missing",
      reasonCodes: ["expected_page_absent"],
    };
  }

  const blocks = Array.isArray(page.blocks) ? page.blocks : [];
  const tables = Array.isArray(page.tables) ? page.tables : [];
  const figures = Array.isArray(page.figures) ? page.figures : [];
  const selectionMarks = Array.isArray(page.selection_marks) ? page.selection_marks : [];
  const textLength = String(page.plain_text ?? "").trim().length || blocks.reduce((sum, b) => sum + String(b?.text ?? "").trim().length, 0);
  const averageConfidence = average([
    ...blocks.map((b) => b?.confidence),
    ...tables.flatMap((t) => (Array.isArray(t?.cells) ? t.cells : []).map((c) => c?.confidence)),
  ]);
  const geometryCoverage = azureNative ? computePageGeometryCoverage(page) : 0;
  const structuralCount = blocks.length + tables.length + figures.length + selectionMarks.length;
  const validDimensions = Number(page.page_width) > 0 && Number(page.page_height) > 0;
  const reasonCodes: string[] = [];

  if (!validDimensions && structuralCount === 0) reasonCodes.push("missing_dimensions_and_structure");
  if (expected && structuralCount === 0 && textLength === 0 && !validDimensions) reasonCodes.push("no_content_and_blank_not_confirmed");
  if (validDimensions && structuralCount === 0 && textLength === 0) reasonCodes.push("azure_processed_empty_page");
  if (averageConfidence != null && averageConfidence < LOW_CONFIDENCE_THRESHOLD) reasonCodes.push("average_confidence_below_threshold");
  if (structuralCount > 0 && textLength < LOW_TEXT_CHARACTER_THRESHOLD) reasonCodes.push("text_below_threshold");

  const status = decidePageStatus({
    exists: true,
    expected,
    validDimensions,
    structuralCount,
    textLength,
    averageConfidence,
    reasonCodes,
  });

  return {
    pageNumber,
    expected,
    textLength,
    blockCount: blocks.length,
    tableCount: tables.length,
    figureCount: figures.length,
    selectionMarkCount: selectionMarks.length,
    averageConfidence,
    geometryCoverage,
    status,
    reasonCodes,
  };
}

export function computePageGeometryCoverage(page: any): number {
  const eligible: any[] = [
    ...(Array.isArray(page?.blocks) ? page.blocks : []),
    ...(Array.isArray(page?.tables) ? page.tables.flatMap((t) => Array.isArray(t?.cells) ? t.cells : []) : []),
  ];
  if (eligible.length === 0) return 0;
  return eligible.filter((item) => isValidPolygon(item?.polygon)).length / eligible.length;
}

function decidePageStatus(args: {
  exists: boolean;
  expected: boolean;
  validDimensions: boolean;
  structuralCount: number;
  textLength: number;
  averageConfidence: number | null;
  reasonCodes: string[];
}): PageProcessingStatus {
  if (args.exists && !args.validDimensions && args.structuralCount === 0) return "unreadable";
  if (!args.exists) return "possibly_missing";
  if (args.validDimensions && args.structuralCount === 0 && args.textLength === 0) return "blank_confirmed";
  if (args.averageConfidence != null && args.averageConfidence < LOW_CONFIDENCE_THRESHOLD) return "low_confidence";
  if (args.structuralCount > 0 && args.textLength < LOW_TEXT_CHARACTER_THRESHOLD) return "low_text";
  return "complete";
}

function average(values: unknown[]): number | null {
  const numbers = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (numbers.length === 0) return null;
  return numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

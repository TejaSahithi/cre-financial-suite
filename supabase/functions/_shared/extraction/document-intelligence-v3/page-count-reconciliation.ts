// @ts-nocheck

import type { PageProcessingResult } from "./page-quality.ts";
import type { CanonicalDocumentLayout } from "./canonical-layout.ts";

export const PAGE_COUNT_RECONCILIATION_VERSION = "page-count-reconciliation-v1";

export type PageCountFinding =
  | "page_count_mismatch"
  | "missing_page"
  | "duplicate_page"
  | "empty_nonblank_page"
  | "geometry_missing"
  | "low_confidence_page"
  | "unreadable_page";

export interface PageCountReconciliationResult {
  version: string;
  counts: {
    pdfMetadata: number | null;
    azure: number | null;
    canonicalLayout: number | null;
    legacyParsed: number | null;
  };
  agreementStatus: "agree" | "disagree" | "insufficient_data";
  findings: Array<{
    code: PageCountFinding;
    pageNumber: number | null;
    severity: "informational" | "warning" | "material";
    message: string;
  }>;
}

export function reconcilePageCounts(args: {
  pdfMetadataPageCount?: number | null;
  azurePageCount?: number | null;
  canonicalLayout?: CanonicalDocumentLayout | null;
  legacyParsedPageCount?: number | null;
  pageQuality?: PageProcessingResult[];
  azureNative?: boolean;
}): PageCountReconciliationResult {
  const layout = args.canonicalLayout ?? null;
  const pages = Array.isArray(layout?.pages) ? layout!.pages : [];
  const counts = {
    pdfMetadata: positiveInteger(args.pdfMetadataPageCount),
    azure: positiveInteger(args.azurePageCount),
    canonicalLayout: positiveInteger(layout?.page_count) ?? (pages.length > 0 ? pages.length : null),
    legacyParsed: positiveInteger(args.legacyParsedPageCount),
  };
  const availableCounts = Object.values(counts).filter((n): n is number => typeof n === "number");
  const uniqueCounts = new Set(availableCounts);
  const findings: PageCountReconciliationResult["findings"] = [];

  if (availableCounts.length >= 2 && uniqueCounts.size > 1) {
    findings.push({
      code: "page_count_mismatch",
      pageNumber: null,
      severity: "material",
      message: "Independent page-count signals disagree.",
    });
  }

  const pageNumbers = pages.map((p) => positiveInteger(p?.page_number)).filter((n): n is number => n != null);
  const seen = new Set<number>();
  for (const pageNumber of pageNumbers) {
    if (seen.has(pageNumber)) {
      findings.push({ code: "duplicate_page", pageNumber, severity: "material", message: `Page ${pageNumber} appears more than once in canonical layout.` });
    }
    seen.add(pageNumber);
  }

  const expectedCount = counts.pdfMetadata ?? counts.azure ?? counts.canonicalLayout ?? counts.legacyParsed ?? null;
  if (expectedCount != null) {
    for (let pageNumber = 1; pageNumber <= expectedCount; pageNumber++) {
      if (!seen.has(pageNumber)) {
        findings.push({ code: "missing_page", pageNumber, severity: "material", message: `Expected page ${pageNumber} is missing from canonical layout.` });
      }
    }
  }

  for (const page of args.pageQuality ?? []) {
    if (args.azureNative && page.expected && page.geometryCoverage === 0 && page.blockCount + page.tableCount > 0) {
      findings.push({ code: "geometry_missing", pageNumber: page.pageNumber, severity: "warning", message: `Page ${page.pageNumber} has eligible Azure-native elements without usable geometry.` });
    }
    if (page.status === "low_confidence") {
      findings.push({ code: "low_confidence_page", pageNumber: page.pageNumber, severity: "warning", message: `Page ${page.pageNumber} is below the page confidence threshold.` });
    }
    if (page.status === "unreadable") {
      findings.push({ code: "unreadable_page", pageNumber: page.pageNumber, severity: "material", message: `Page ${page.pageNumber} lacks reliable dimensions or usable structure.` });
    }
  }

  return {
    version: PAGE_COUNT_RECONCILIATION_VERSION,
    counts,
    agreementStatus: availableCounts.length < 2 ? "insufficient_data" : (uniqueCounts.size === 1 ? "agree" : "disagree"),
    findings,
  };
}

function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

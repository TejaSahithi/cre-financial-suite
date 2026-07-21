// @ts-nocheck

import type { CanonicalDocumentLayout } from "./canonical-layout.ts";

export const SECTION_HIERARCHY_VERSION = "section-hierarchy-v1";
export const MAX_STORED_SECTIONS = 500;

export interface CanonicalSection {
  sectionId: string;
  parentSectionId: string | null;
  sectionPath: string[];
  headingLevel: 0 | 1 | null;
  documentOrder: number;
  pageNumber: number;
  headingText: string;
  headingBlockId: string | null;
  blockIds: string[];
  hierarchyVersion: string;
  definitionIds?: string[];
  crossReferenceIds?: string[];
}

export function buildSectionHierarchy(layout: CanonicalDocumentLayout | null | undefined): {
  version: string;
  sections: CanonicalSection[];
  summary: {
    totalDetected: number;
    storedCount: number;
    capped: boolean;
    maxStored: number;
    maximumDepth: number;
    warnings: string[];
  };
} {
  const blocks = (layout?.pages ?? [])
    .flatMap((page, pageIndex) => (page.blocks ?? []).map((block, blockIndex) => ({ page, pageIndex, block, blockIndex })))
    .sort((a, b) =>
      (a.page.page_number - b.page.page_number) ||
      ((a.block.reading_order_index ?? Number.MAX_SAFE_INTEGER) - (b.block.reading_order_index ?? Number.MAX_SAFE_INTEGER)) ||
      (a.blockIndex - b.blockIndex)
    );

  const detected: CanonicalSection[] = [];
  let currentTitle: CanonicalSection | null = null;
  let currentSection: CanonicalSection | null = null;

  const ensurePreamble = (pageNumber: number): CanonicalSection => {
    if (detected.length > 0) return currentSection ?? detected[detected.length - 1];
    const preamble = makeSection({
      order: 0,
      level: null,
      parent: null,
      pageNumber,
      headingText: "Preamble",
      headingBlockId: null,
      path: ["Preamble"],
    });
    detected.push(preamble);
    currentSection = preamble;
    return preamble;
  };

  for (const item of blocks) {
    const role = String(item.block.role ?? item.block.kind ?? "").toLowerCase();
    if (role === "title") {
      currentTitle = makeSection({
        order: detected.length,
        level: 0,
        parent: null,
        pageNumber: item.block.page_number,
        headingText: cleanHeading(item.block.text) || "Untitled",
        headingBlockId: item.block.block_id,
        path: [cleanHeading(item.block.text) || "Untitled"],
      });
      detected.push(currentTitle);
      currentSection = currentTitle;
      continue;
    }
    if (role === "sectionheading" || role === "section_heading") {
      const parent = currentTitle ?? ensurePreamble(item.block.page_number);
      currentSection = makeSection({
        order: detected.length,
        level: 1,
        parent,
        pageNumber: item.block.page_number,
        headingText: cleanHeading(item.block.text) || "Untitled Section",
        headingBlockId: item.block.block_id,
        path: [...parent.sectionPath, cleanHeading(item.block.text) || "Untitled Section"],
      });
      detected.push(currentSection);
      continue;
    }
    const section = currentSection ?? ensurePreamble(item.block.page_number);
    section.blockIds.push(item.block.block_id);
  }

  const capped = detected.length > MAX_STORED_SECTIONS;
  const sections = detected.slice(0, MAX_STORED_SECTIONS);
  return {
    version: SECTION_HIERARCHY_VERSION,
    sections,
    summary: {
      totalDetected: detected.length,
      storedCount: sections.length,
      capped,
      maxStored: MAX_STORED_SECTIONS,
      maximumDepth: sections.reduce((max, section) => Math.max(max, section.sectionPath.length), 0),
      warnings: capped ? [`section_hierarchy_capped:${detected.length}:${MAX_STORED_SECTIONS}`] : [],
    },
  };
}

function makeSection(args: {
  order: number;
  level: 0 | 1 | null;
  parent: CanonicalSection | null;
  pageNumber: number;
  headingText: string;
  headingBlockId: string | null;
  path: string[];
}): CanonicalSection {
  return {
    sectionId: `section-${String(args.order).padStart(4, "0")}`,
    parentSectionId: args.parent?.sectionId ?? null,
    sectionPath: args.path,
    headingLevel: args.level,
    documentOrder: args.order,
    pageNumber: args.pageNumber,
    headingText: args.headingText,
    headingBlockId: args.headingBlockId,
    blockIds: [],
    hierarchyVersion: SECTION_HIERARCHY_VERSION,
    definitionIds: [],
    crossReferenceIds: [],
  };
}

function cleanHeading(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

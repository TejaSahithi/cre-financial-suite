// @ts-nocheck
/**
 * Extraction Pipeline — Document Chunking
 *
 * Splits large Azure document text into chunks of 1000–2000 tokens (~4000–8000 chars)
 * for targeted LLM extraction. Each chunk is processed independently.
 *
 * Rules:
 *   - Respect paragraph boundaries (never split mid-paragraph)
 *   - Track page numbers when available
 *   - Include overlap between chunks for context
 *   - Estimate token count (1 token ≈ 4 chars for English)
 */

import type { DoclingOutput, DoclingTextBlock, TextChunk } from "./types.ts";
import type { FieldDef } from "./schemas.ts"; // type-only import, no circular dependency

/** Approximate token count — conservative for English CRE documents */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk an Azure document into text segments suitable for LLM extraction.
 *
 * @param docling  The full Azure document output
 * @param targetTokens  Target tokens per chunk (default: 1500)
 * @param overlapChars  Characters of overlap between chunks (default: 200)
 * @returns Array of TextChunks with metadata
 */
export function chunkDocument(
  docling: DoclingOutput,
  targetTokens = 1500,
  overlapChars = 200,
): TextChunk[] {
  const targetChars = targetTokens * 4;
  const blocks = docling.text_blocks ?? [];

  // If the document is small enough, return as a single chunk
  const fullText = docling.full_text ?? blocks.map((b) => b.text).join("\n\n");
  if (estimateTokens(fullText) <= targetTokens * 1.5) {
    return [
      {
        text: fullText,
        index: 0,
        startPage: blocks[0]?.page,
        endPage: blocks[blocks.length - 1]?.page,
        tokenEstimate: estimateTokens(fullText),
      },
    ];
  }

  // Group text blocks into chunks respecting paragraph boundaries
  const chunks: TextChunk[] = [];
  let currentText = "";
  let currentStartPage: number | undefined;
  let currentEndPage: number | undefined;

  function flushChunk() {
    if (currentText.trim().length > 0) {
      chunks.push({
        text: currentText.trim(),
        index: chunks.length,
        startPage: currentStartPage,
        endPage: currentEndPage,
        tokenEstimate: estimateTokens(currentText),
      });
    }
    currentText = "";
    currentStartPage = undefined;
    currentEndPage = undefined;
  }

  for (const block of blocks) {
    const blockText = block.text.trim();
    if (!blockText) continue;

    // If adding this block would exceed the target, flush first
    if (currentText.length > 0 && currentText.length + blockText.length > targetChars) {
      // Keep some overlap
      const overlapText = currentText.slice(-overlapChars);
      flushChunk();
      currentText = overlapText + "\n\n";
    }

    if (currentStartPage === undefined) currentStartPage = block.page;
    currentEndPage = block.page;
    currentText += blockText + "\n\n";
  }

  // Flush remaining
  flushChunk();

  // If no blocks, fall back to splitting full_text by character
  if (chunks.length === 0 && fullText.length > 0) {
    return chunkPlainText(fullText, targetChars, overlapChars);
  }

  return chunks;
}

/**
 * Fallback: chunk plain text when no text blocks are available.
 * Splits at paragraph boundaries (double newlines) or sentence boundaries.
 */
function chunkPlainText(
  text: string,
  targetChars: number,
  overlapChars: number,
): TextChunk[] {
  const chunks: TextChunk[] = [];
  const paragraphs = text.split(/\n\s*\n/);

  let currentText = "";

  for (const para of paragraphs) {
    if (currentText.length > 0 && currentText.length + para.length > targetChars) {
      const overlapText = currentText.slice(-overlapChars);
      chunks.push({
        text: currentText.trim(),
        index: chunks.length,
        tokenEstimate: estimateTokens(currentText),
      });
      currentText = overlapText + "\n\n";
    }
    currentText += para + "\n\n";
  }

  if (currentText.trim().length > 0) {
    chunks.push({
      text: currentText.trim(),
      index: chunks.length,
      tokenEstimate: estimateTokens(currentText),
    });
  }

  return chunks;
}

function testPatternSafely(pattern: RegExp, text: string): boolean {
  // Regexes with the g/y flag carry mutable lastIndex state. Reusing the same
  // RegExp object (from FieldDef.patterns) across many blocks in this loop
  // would make .test() results depend on call order — a match in an earlier
  // block can suppress a match in a later block. Reset explicitly so scoring
  // is deterministic regardless of block order.
  pattern.lastIndex = 0;
  const matched = pattern.test(text);
  pattern.lastIndex = 0;
  return matched;
}

/**
 * Build a focused text snippet from Azure document output for a specific field group.
 * Selects only the most relevant text blocks based on field labels/patterns/table headers.
 */
export function buildRelevantSnippet(
  docling: DoclingOutput,
  fieldDefs: FieldDef[],
  maxTokens = 2000,
): string {
  const blocks = docling.text_blocks ?? [];
  const fullText = docling.full_text ?? blocks.map((b) => b.text).join("\n");

  // If small enough, return everything
  if (estimateTokens(fullText) <= maxTokens) return fullText;

  // Score each block by relevance to the field labels/patterns/table headers
  const scored = blocks.map((block, index) => {
    const textLower = block.text.toLowerCase();
    let score = 0;
    for (const def of fieldDefs) {
      for (const label of def.labels ?? []) {
        if (textLower.includes(label.toLowerCase())) score += 2;
      }
      for (const header of def.tableHeaders ?? []) {
        if (textLower.includes(header.toLowerCase())) score += 2;
      }
      for (const pattern of def.patterns ?? []) {
        if (testPatternSafely(pattern, block.text)) score += 3; // a regex hit is a stronger, more specific signal than a bare substring
      }
    }
    // Only reward a heading that already matched something — an unmatched
    // heading ("Miscellaneous", "Exhibit C", "Table of Contents") is not
    // itself relevant, and scoring it positive would defeat the score>0
    // stop-condition below.
    if (score > 0 && block.type === "heading") score += 1;
    return { block, index, score };
  });

  const byIndex = new Map(scored.map((s) => [s.index, s]));
  // Sort by score descending, take top blocks within token budget
  const positive = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score);

  const selectedIndexes = new Set<number>();
  let tokens = 0;
  for (const item of positive) {
    if (selectedIndexes.has(item.index)) continue;
    const itemTokens = estimateTokens(item.block.text);
    if (tokens + itemTokens > maxTokens) {
      // Skip (not stop) — a single oversized high-scoring block (e.g. a big
      // table) must not prevent smaller, still-relevant blocks ranked below
      // it from being considered.
      continue;
    }
    selectedIndexes.add(item.index);
    tokens += itemTokens;

    // Pull in the immediate neighboring block on each side, budget permitting.
    // Low-risk recall fix for split obligation/exception sentences that sit
    // just outside the matched block (e.g. "Tenant shall maintain the HVAC
    // system." followed by "Notwithstanding the foregoing, Landlord shall
    // replace units that fail through ordinary wear.") — this is NOT a
    // clause-aware retrieval architecture: no semantic queries, no multi-hop
    // cross-reference resolution, just the immediate ±1 block.
    for (const neighborIndex of [item.index - 1, item.index + 1]) {
      const neighbor = byIndex.get(neighborIndex);
      if (!neighbor || selectedIndexes.has(neighborIndex)) continue;
      const neighborTokens = estimateTokens(neighbor.block.text);
      if (tokens + neighborTokens > maxTokens) continue;
      selectedIndexes.add(neighborIndex);
      tokens += neighborTokens;
    }
  }

  // Restore original document order using the index tracked above (not
  // block.block_index, which may be unset on some blocks) so the LLM can
  // reason about context.
  const selectedBlocks = [...selectedIndexes].sort((a, b) => a - b).map((i) => byIndex.get(i)!.block);

  let result = "";
  let lastPage = null;
  for (const block of selectedBlocks) {
    if (block.page && block.page !== lastPage) {
      result += `\n[[PAGE ${block.page}]]\n`;
      lastPage = block.page;
    }
    result += block.text + "\n\n";
  }

  return result.trim() || fullText.slice(0, maxTokens * 4);
}

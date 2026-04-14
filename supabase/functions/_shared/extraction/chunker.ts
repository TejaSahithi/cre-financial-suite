// @ts-nocheck
/**
 * Extraction Pipeline — Document Chunking
 *
 * Splits large Docling text into chunks of 1000–2000 tokens (~4000–8000 chars)
 * for targeted LLM extraction. Each chunk is processed independently.
 *
 * Rules:
 *   - Respect paragraph boundaries (never split mid-paragraph)
 *   - Track page numbers when available
 *   - Include overlap between chunks for context
 *   - Estimate token count (1 token ≈ 4 chars for English)
 */

import type { DoclingOutput, DoclingTextBlock, TextChunk } from "./types.ts";

/** Approximate token count — conservative for English CRE documents */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Chunk a Docling document into text segments suitable for LLM extraction.
 *
 * @param docling  The full Docling output
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

/**
 * Build a focused text snippet from Docling output for a specific field group.
 * Selects only the most relevant text blocks based on field labels.
 */
export function buildRelevantSnippet(
  docling: DoclingOutput,
  fieldLabels: string[],
  maxTokens = 2000,
): string {
  const blocks = docling.text_blocks ?? [];
  const fullText = docling.full_text ?? blocks.map((b) => b.text).join("\n");

  // If small enough, return everything
  if (estimateTokens(fullText) <= maxTokens) return fullText;

  // Score each block by relevance to the field labels
  const scored = blocks.map((block) => {
    const textLower = block.text.toLowerCase();
    let score = 0;
    for (const label of fieldLabels) {
      if (textLower.includes(label.toLowerCase())) score += 2;
    }
    // Headings get a small bonus (likely section headers)
    if (block.type === "heading") score += 1;
    return { block, score };
  });

  // Sort by score descending, take top blocks within token budget
  scored.sort((a, b) => b.score - a.score);

  let result = "";
  let tokens = 0;
  for (const { block } of scored) {
    const blockTokens = estimateTokens(block.text);
    if (tokens + blockTokens > maxTokens) break;
    result += block.text + "\n\n";
    tokens += blockTokens;
  }

  return result.trim() || fullText.slice(0, maxTokens * 4);
}

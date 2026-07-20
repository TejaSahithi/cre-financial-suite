// @ts-nocheck
/**
 * _shared/ocr/ocr-provider.ts — OCR abstraction layer.
 *
 * Azure Document Intelligence is the current implementation.
 * Future providers (AWS Textract, etc.) can be added here without
 * touching any caller.
 *
 * Required env vars (unchanged from existing Azure config):
 *   AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT
 *   AZURE_DOCUMENT_INTELLIGENCE_KEY
 */

import {
  analyzeWithAzureLayout,
  getAzureDocumentIntelligenceConfig,
} from "../azure/document-intelligence.ts";

// ---------------------------------------------------------------------------
// Public interface — callers depend only on these types
// ---------------------------------------------------------------------------

export interface OCRProvider {
  /**
   * Extract raw plain text from a document (for LLM consumption).
   */
  extractText(fileBytes: Uint8Array | null, mimeType: string, fileUrl?: string): Promise<string>;

  /**
   * Extract structured layout (paragraphs, tables, reading order) from a document.
   * Returns the Azure Markdown layout string ready for normalization.
   */
  extractLayout(fileBytes: Uint8Array | null, mimeType: string, fileUrl?: string): Promise<OCRLayoutResult>;
}

export interface OCRLayoutResult {
  /** Markdown-formatted document content (Azure's outputContentFormat=markdown) */
  content: string;
  /** Provider that produced this result — for provenance records */
  provider: string;
  /** Number of pages detected */
  pageCount: number;
  /** Raw provider response — stored as docling_raw for downstream compatibility */
  rawResponse: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Azure Document Intelligence adapter (internal)
// ---------------------------------------------------------------------------

class AzureOCRProvider implements OCRProvider {
  private async analyze(
    fileBytes: Uint8Array | null,
    mimeType: string,
    fileUrl?: string,
  ): Promise<Record<string, unknown>> {
    const config = getAzureDocumentIntelligenceConfig();
    if (!config.endpoint || !config.keyPresent) {
      throw new Error(
        "Azure Document Intelligence is not configured. " +
        "Set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_KEY.",
      );
    }

    return await analyzeWithAzureLayout({
      fileBytes,
      fileUrl: fileUrl ?? null,
      mimeType,
    });
  }

  async extractText(
    fileBytes: Uint8Array | null,
    mimeType: string,
    fileUrl?: string,
  ): Promise<string> {
    const result = await this.analyze(fileBytes, mimeType, fileUrl);
    // Azure returns analyzeResult.content as the plain-text representation
    const content = (result as any)?.analyzeResult?.content ?? "";
    if (!content || content.length < 5) {
      throw new Error("Azure Document Intelligence returned empty content — document may be blank.");
    }
    return content;
  }

  async extractLayout(
    fileBytes: Uint8Array | null,
    mimeType: string,
    fileUrl?: string,
  ): Promise<OCRLayoutResult> {
    const rawResponse = await this.analyze(fileBytes, mimeType, fileUrl);
    const analyzeResult = (rawResponse as any)?.analyzeResult ?? {};
    const content: string = analyzeResult?.content ?? "";
    const pageCount: number = analyzeResult?.pages?.length ?? 1;

    if (!content || content.length < 5) {
      throw new Error("Azure Document Intelligence returned empty layout — document may be blank.");
    }

    return {
      content,
      provider: "azure_document_intelligence",
      pageCount,
      rawResponse,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton — swap implementation here to change providers globally
// ---------------------------------------------------------------------------

const _provider: OCRProvider = new AzureOCRProvider();

/**
 * Extract plain text from a document using the configured OCR provider.
 * Use this for feeding text into LLM extraction.
 */
export async function runOCRText(
  fileBytes: Uint8Array | null,
  mimeType: string,
  fileUrl?: string,
): Promise<string> {
  return _provider.extractText(fileBytes, mimeType, fileUrl);
}

/**
 * Extract structured layout from a document using the configured OCR provider.
 * Use this for the full document parsing pipeline.
 */
export async function runOCRLayout(
  fileBytes: Uint8Array | null,
  mimeType: string,
  fileUrl?: string,
): Promise<OCRLayoutResult> {
  return _provider.extractLayout(fileBytes, mimeType, fileUrl);
}

// @ts-nocheck
/**
 * Azure Document Intelligence OCR helpers.
 *
 * Azure reads layout/text. OpenAI extracts visible key-value pairs from the
 * Azure-extracted text when structured fields are needed.
 */

import { analyzeWithAzureLayout, getAzureDocumentIntelligenceConfig } from "../azure/document-intelligence.ts";
import { normalizeAzureLayoutToDoclingOutput } from "../extraction/azure-layout-adapter.ts";
import { callLLMJSON } from "../llm.ts";

/** Extract text from a scanned PDF or image using Azure Document Intelligence. */
export async function runDocumentOCR(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
  fileUri?: string,
): Promise<string> {
  console.log(`[ocr] Running Azure Document Intelligence OCR (${mimeType}, ${fileBytes?.length ?? 0} bytes)`);
  const parsed = await parseWithAzure(fileBytes, mimeType, fileUri);
  return parsed.full_text;
}

/** Combined layout/text extraction with Azure and key-value extraction with OpenAI. */
export async function extractDocumentWithAzureAndOpenAI(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
  fileUri?: string,
): Promise<{
  text: string;
  page_count?: number;
  pages: Array<{
    page: number;
    text: string;
    fields: Array<{ key: string; value: string; confidence?: number; page?: number; source_text?: string }>;
  }>;
  fields: Array<{ key: string; value: string; confidence?: number; page?: number; source_text?: string }>;
  warnings: string[];
}> {
  console.log(`[ocr] Running Azure + OpenAI document extraction (${mimeType}, ${fileBytes?.length ?? 0} bytes)`);
  const parsed = await parseWithAzure(fileBytes, mimeType, fileUri);
  const fields = await extractVisibleKeyValues(fileBytes, mimeType, fileUri, parsed.full_text);

  return {
    text: parsed.full_text,
    page_count: parsed.page_count,
    pages: parsed.pages.map((p: any) => ({
      page: p.page,
      text: p.text,
      fields: [],
    })),
    fields,
    warnings: [],
  };
}

/** Extract visible key-value pairs using OpenAI over Azure-extracted text. */
export async function extractVisibleKeyValues(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
  fileUri?: string,
  preextractedText?: string,
): Promise<Array<{ key: string; value: string; confidence?: number; page?: number }>> {
  console.log(`[ocr] Extracting visible key-value pairs with OpenAI`);

  let text = preextractedText;
  if (!text) {
    const parsed = await parseWithAzure(fileBytes, mimeType, fileUri);
    text = parsed.full_text;
  }

  const result = await callLLMJSON({
    systemPrompt: `You extract structured data from commercial real estate legal documents.

Return JSON only with this shape:
{"fields":[{"key":"field name exactly as seen or clearly implied","value":"field value exactly as seen","confidence":0.9,"page":1}]}

Rules:
1. Extract every visible meaningful field/value pair, party, date, address, legal reference, premises, suite/unit, rent, term, assignment, assignor, assignee, landlord, tenant, consent, notice address, CAM, exhibits, signatures, and notary details.
2. Do not invent values. If a value is not visible, omit that field.
3. Preserve names and addresses exactly.
4. Split compound clauses into useful field/value pairs when possible.
5. Use snake_case-like concise keys when the document has no explicit label.
6. Return valid JSON only. No markdown.`,
    userPrompt: `Here is the document text:\n\n${text.slice(0, 100000)}\n\nExtract all meaningful field/value pairs from this document for a review UI.`,
  });

  const fields = Array.isArray(result?.fields) ? result.fields : [];
  return fields
    .map((field: any) => ({
      key: String(field?.key ?? "").trim(),
      value: String(field?.value ?? "").trim(),
      confidence: typeof field?.confidence === "number" ? field.confidence : 0.9,
      page: typeof field?.page === "number" ? field.page : undefined,
    }))
    .filter((field: any) => field.key.length > 0 && field.value.length > 0)
    .slice(0, 120);
}
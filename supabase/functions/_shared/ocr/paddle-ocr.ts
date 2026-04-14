// @ts-nocheck
/**
 * supabase/functions/_shared/ocr/paddle-ocr.ts
 *
 * OCR text extraction using Google Gemini Vision.
 *
 * Replaces the previous Deno.Command + Python subprocess approach
 * which cannot run in Supabase Edge Functions (Deno Deploy).
 * Gemini 1.5 natively understands PDFs, images, and scanned documents
 * and is already configured in this project via Vertex AI.
 */

import { callVertexAIWithFile } from "../vertex-ai.ts";

const OCR_SYSTEM_PROMPT = `You are a precise OCR engine. Extract ALL visible text from this document exactly as it appears.

RULES:
1. Preserve the original reading order (top to bottom, left to right).
2. Preserve paragraph breaks as double newlines.
3. Preserve table structure using tab-separated values where possible.
4. Do NOT interpret, summarize, or modify the content — extract verbatim.
5. If text is partially illegible, provide your best reading in [brackets].
6. Return ONLY the extracted text. No JSON, no markdown fences, no explanation.`;

/**
 * Extract text from a scanned PDF or image using Gemini Vision.
 *
 * @param fileBytes - Raw file bytes (PDF or image)
 * @param mimeType - MIME type of the file (e.g. "application/pdf", "image/png")
 * @returns Extracted text content
 */
export async function runPaddleOCR(fileBytes: Uint8Array, mimeType: string = "application/pdf"): Promise<string> {
  console.log(`[ocr] Running Gemini Vision OCR (${mimeType}, ${fileBytes.length} bytes)`);

  const hasVertexAI = !!(
    Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")
  ) && !!(
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY")
  );

  if (!hasVertexAI) {
    throw new Error(
      "OCR requires Vertex AI (Gemini). Set VERTEX_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY in Supabase secrets."
    );
  }

  try {
    const response = await callVertexAIWithFile({
      systemPrompt: OCR_SYSTEM_PROMPT,
      userPrompt: "Extract all text from this document. Return only the raw text, nothing else.",
      fileBytes,
      fileMimeType: mimeType,
      maxOutputTokens: 8192,
      temperature: 0,
      responseMimeType: "text/plain",
    });

    const text = response.content?.trim() ?? "";

    console.log(
      `[ocr] Gemini Vision OCR complete: ${text.length} chars, ` +
      `input=${response.inputTokens} tokens, output=${response.outputTokens} tokens`
    );

    if (!text || text.length < 5) {
      throw new Error("Gemini Vision returned empty text — document may be blank or unreadable.");
    }

    return cleanOCRText(text);
  } catch (err) {
    // Re-throw with clear context
    if (err.message?.includes("Vertex AI")) {
      throw err;
    }
    throw new Error(`Gemini Vision OCR failed: ${err.message}`);
  }
}

/**
 * Removes excess whitespace, OCR artifacts, and normalizes output.
 */
function cleanOCRText(text: string): string {
  if (!text) return "";

  // Remove control characters and null bytes
  let cleaned = text.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, "");

  // Replace multiple newlines with double newline (paragraph break)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Replace multiple spaces/tabs with single space
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");

  return cleaned.trim();
}

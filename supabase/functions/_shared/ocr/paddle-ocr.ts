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

import { callVertexAIFileJSON, callVertexAIWithFile } from "../vertex-ai.ts";

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

export async function extractDocumentWithVision(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
): Promise<{
  text: string;
  fields: Array<{ key: string; value: string; confidence?: number; page?: number }>;
  warnings: string[];
}> {
  console.log(`[ocr] Running combined Gemini document extraction (${mimeType}, ${fileBytes.length} bytes)`);

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

  const result = await callVertexAIFileJSON<{
    text?: string;
    fields?: Array<{ key?: string; value?: unknown; confidence?: number; page?: number }>;
    warnings?: string[];
  }>({
    systemPrompt: `You extract data from commercial real estate documents for a review UI.

Return JSON only:
{"text":"important OCR text and clauses", "fields":[{"key":"field_name","value":"field value","confidence":0.0,"page":1}], "warnings":[]}

Rules:
1. Extract every meaningful field/value pair you can see: parties, tenant, landlord, assignor, assignee, property, premises, address, suite/unit, dates, lease term, rent, annual rent, rent per SF, square footage, security deposit, CAM, options, consent, notices, exhibits, signatures, and notary information.
2. For standard lease fields, prefer these exact keys whenever applicable:
   tenant_name, landlord_name, property_name, property_address, unit_number,
   start_date, end_date, monthly_rent, annual_rent, rent_per_sf, square_footage,
   lease_type, security_deposit, cam_amount, escalation_rate, renewal_options,
   ti_allowance, free_rent_months, lease_term_months, status,
   assignor_name, assignee_name, assignment_effective_date, landlord_consent,
   assumption_scope, assignee_notice_address.
3. For anything useful that is not a standard field, still extract it with a concise snake_case key so it can appear as a custom field.
4. Do not invent values. If not visible, omit it.
5. Keep values exact, especially names, dates, addresses, and money.
6. Put important surrounding lease/assignment clauses in "text"; do not include boilerplate if the output would be too long.
7. Return valid JSON only. No markdown.`,
    userPrompt: "Extract all reviewable fields and the important OCR text from this document.",
    fileBytes,
    fileMimeType: mimeType,
    maxOutputTokens: 16384,
    temperature: 0,
  });

  const fields = Array.isArray(result?.fields) ? result.fields : [];
  const cleanedFields = fields
    .map((field) => ({
      key: String(field?.key ?? "").trim(),
      value: String(field?.value ?? "").trim(),
      confidence: typeof field?.confidence === "number" ? field.confidence : 0.78,
      page: typeof field?.page === "number" ? field.page : undefined,
    }))
    .filter((field) => field.key.length > 0 && field.value.length > 0)
    .slice(0, 200);

  const textFromFields = cleanedFields.map((field) => `${field.key}: ${field.value}`).join("\n");
  const text = cleanOCRText([result?.text, textFromFields].filter(Boolean).join("\n"));

  if (!text && cleanedFields.length === 0) {
    throw new Error("Gemini Vision returned no text or fields.");
  }

  console.log(`[ocr] Combined Gemini extraction complete: ${text.length} chars, ${cleanedFields.length} fields`);
  return {
    text,
    fields: cleanedFields,
    warnings: Array.isArray(result?.warnings) ? result.warnings.map(String) : [],
  };
}

export async function extractVisibleKeyValues(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
): Promise<Array<{ key: string; value: string; confidence?: number; page?: number }>> {
  console.log(`[ocr] Extracting visible key-value pairs (${mimeType}, ${fileBytes.length} bytes)`);

  const hasVertexAI = !!(
    Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")
  ) && !!(
    Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY")
  );

  if (!hasVertexAI) {
    throw new Error(
      "Key-value extraction requires Vertex AI (Gemini). Set VERTEX_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY in Supabase secrets."
    );
  }

  const result = await callVertexAIFileJSON<{
    fields?: Array<{ key?: string; value?: unknown; confidence?: number; page?: number }>;
  }>({
    systemPrompt: `You extract structured data from commercial real estate legal documents.

Return JSON only with this shape:
{"fields":[{"key":"field name exactly as seen or clearly implied","value":"field value exactly as seen","confidence":0.0,"page":1}]}

Rules:
1. Extract every visible meaningful field/value pair, party, date, address, legal reference, premises, suite/unit, rent, term, assignment, assignor, assignee, landlord, tenant, consent, notice address, CAM, exhibits, signatures, and notary details.
2. Do not invent values. If a value is not visible, omit that field.
3. Preserve names and addresses exactly.
4. Split compound clauses into useful field/value pairs when possible.
5. Use snake_case-like concise keys when the document has no explicit label.
6. Return valid JSON only. No markdown.`,
    userPrompt: "Extract all meaningful field/value pairs from this document for a review UI.",
    fileBytes,
    fileMimeType: mimeType,
    maxOutputTokens: 8192,
    temperature: 0,
  });

  const fields = Array.isArray(result?.fields) ? result.fields : [];
  const cleaned = fields
    .map((field) => ({
      key: String(field?.key ?? "").trim(),
      value: String(field?.value ?? "").trim(),
      confidence: typeof field?.confidence === "number" ? field.confidence : 0.72,
      page: typeof field?.page === "number" ? field.page : undefined,
    }))
    .filter((field) => field.key.length > 0 && field.value.length > 0)
    .slice(0, 120);

  console.log(`[ocr] Gemini key-value extraction complete: ${cleaned.length} fields`);
  return cleaned;
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

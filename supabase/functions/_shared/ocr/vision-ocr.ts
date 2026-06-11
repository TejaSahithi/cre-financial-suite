// @ts-nocheck
/**
 * supabase/functions/_shared/ocr/vision-ocr.ts
 *
 * OCR text extraction and visible field extraction using Google Gemini Vision.
 *
 * Supabase Edge Functions cannot reliably run native Python OCR binaries, so
 * scanned PDFs/images are sent to Vertex AI Gemini Vision instead.
 */

import { callVertexAIFileJSON, callVertexAIWithFile, callGeminiWithAPIKeyAndFile } from "../vertex-ai.ts";

const OCR_SYSTEM_PROMPT = `You are a precise OCR engine. Extract ALL visible text from this document exactly as it appears.

RULES:
1. Preserve the original reading order (top to bottom, left to right).
2. Preserve paragraph breaks as double newlines.
3. Preserve table structure using tab-separated values where possible.
4. Do NOT interpret, summarize, or modify the content - extract verbatim.
5. If text is partially illegible, provide your best reading in [brackets].
6. Return ONLY the extracted text. No JSON, no markdown fences, no explanation.`;

/**
 * Extract text from a scanned PDF or image using Gemini Vision.
 *
 * @param fileBytes - Raw file bytes (PDF or image)
 * @param mimeType - MIME type of the file (e.g. "application/pdf", "image/png")
 * @returns Extracted text content
 */
export async function runVisionOCR(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
  fileUri?: string,
): Promise<string> {
  const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
  const useUri = !!fileUri && fileBytes.length > INLINE_LIMIT_BYTES;
  console.log(`[ocr] Running Gemini Vision OCR (${mimeType}, ${fileBytes.length} bytes, mode=${useUri ? "uri" : "inline"})`);

  const hasVertexCreds = !!(
    (Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
    (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))
  );
  const hasGeminiKey = !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY"));

  if (!hasVertexCreds && !hasGeminiKey) {
    throw new Error(
      "OCR requires Vertex AI or a Gemini API key. Set VERTEX_PROJECT_ID + GOOGLE_SERVICE_ACCOUNT_KEY " +
      "or GEMINI_API_KEY in Supabase secrets."
    );
  }

  try {
    let response;
    if (hasVertexCreds) {
      try {
        response = await callVertexAIWithFile({
          systemPrompt: OCR_SYSTEM_PROMPT,
          userPrompt: "Extract all text from this document. Return only the raw text, nothing else.",
          fileBytes,
          fileUri: useUri ? fileUri : undefined,
          fileMimeType: mimeType,
          maxOutputTokens: 32768,
          temperature: 0,
          responseMimeType: "text/plain",
        });
      } catch (vertexErr) {
        if (hasGeminiKey) {
          console.warn(`[ocr] Vertex AI OCR failed (${vertexErr?.message}), falling back to Gemini API key`);
          response = await callGeminiWithAPIKeyAndFile({
            systemPrompt: OCR_SYSTEM_PROMPT,
            userPrompt: "Extract all text from this document. Return only the raw text, nothing else.",
            fileBytes,
            fileUri: useUri ? fileUri : undefined,
            fileMimeType: mimeType,
            maxOutputTokens: 32768,
            temperature: 0,
          });
        } else {
          throw vertexErr;
        }
      }
    } else {
      response = await callGeminiWithAPIKeyAndFile({
        systemPrompt: OCR_SYSTEM_PROMPT,
        userPrompt: "Extract all text from this document. Return only the raw text, nothing else.",
        fileBytes,
        fileUri: useUri ? fileUri : undefined,
        fileMimeType: mimeType,
        maxOutputTokens: 32768,
        temperature: 0,
      });
    }

    const text = response.content?.trim() ?? "";

    console.log(
      `[ocr] Gemini Vision OCR complete: ${text.length} chars, ` +
      `input=${response.inputTokens} tokens, output=${response.outputTokens} tokens`
    );

    if (!text || text.length < 5) {
      throw new Error("Gemini Vision returned empty text - document may be blank or unreadable.");
    }

    return cleanOCRText(text);
  } catch (err) {
    if (err.message?.includes("Vertex AI")) {
      throw err;
    }
    throw new Error(`Gemini Vision OCR failed: ${err.message}`);
  }
}

export async function extractDocumentWithVision(
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
  // For files ≤ 20 MB always use inline base64 — it's more reliable than asking
  // Vertex AI to fetch the file over HTTP (signed URLs can expire, CDN firewalls
  // differ, and Supabase CDN may not be reachable from all Vertex AI data centres).
  // Only use the fileUri path for files above 20 MB where inline is impractical.
  const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
  const useUri = !!fileUri && fileBytes.length > INLINE_LIMIT_BYTES;
  const effectiveUri = useUri ? fileUri : undefined;
  const isLargeInlineFile = !useUri && fileBytes.length > 15 * 1024 * 1024;

  console.log(
    `[ocr] Running combined Gemini document extraction (${mimeType}, ${fileBytes.length} bytes, ` +
    `mode=${useUri ? "uri" : "inline"})`,
  );

  const hasVertexCreds2 = !!(
    (Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
    (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))
  );
  const hasGeminiKey2 = !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY"));

  if (!hasVertexCreds2 && !hasGeminiKey2) {
    throw new Error(
      "OCR requires Vertex AI or a Gemini API key. Set VERTEX_PROJECT_ID + GOOGLE_SERVICE_ACCOUNT_KEY " +
      "or GEMINI_API_KEY in Supabase secrets."
    );
  }

  const geminiFileJSON = async <T>(opts: Parameters<typeof callVertexAIFileJSON>[0]): Promise<T | null> => {
    const response = await callGeminiWithAPIKeyAndFile(opts);
    let text = response.content.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    if (!text) return null;
    try { return JSON.parse(text) as T; } catch { return null; }
  };

  const callFileJSON = hasVertexCreds2
    ? async <T>(opts: Parameters<typeof callVertexAIFileJSON>[0]): Promise<T | null> => {
        try {
          return await callVertexAIFileJSON<T>(opts);
        } catch (vertexErr) {
          if (hasGeminiKey2) {
            console.warn(`[ocr] Vertex AI file JSON failed (${vertexErr?.message}), falling back to Gemini API key`);
            return await geminiFileJSON<T>(opts);
          }
          throw vertexErr;
        }
      }
    : geminiFileJSON;

  const result = await callFileJSON<{
    page_count?: number;
    pages?: Array<{
      page?: number;
      text?: string;
      fields?: Array<{ key?: string; value?: unknown; confidence?: number; page?: number; source_text?: string }>;
    }>;
    text?: string;
    fields?: Array<{ key?: string; value?: unknown; confidence?: number; page?: number; source_text?: string }>;
    warnings?: string[];
  }>({
    systemPrompt: `You extract data from commercial real estate documents for a review UI.

Return JSON only:
{"page_count":1,"pages":[{"page":1,"text":"verbatim text from this page","fields":[{"key":"field_name","value":"field value","source_text":"exact sentence or table row from this same page","confidence":0.0}]}],"warnings":[]}

Rules:
1. Preserve page boundaries. For every PDF page you can read, return one pages[] item with its real page number and verbatim page text.
2. Extract every meaningful field/value pair you can see: parties, tenant, landlord, assignor, assignee, property, premises, address, suite/unit, dates, lease term, rent, annual rent, rent per SF, square footage, security deposit, CAM, options, consent, notices, exhibits, signatures, and notary information.
2. For standard lease fields, prefer these exact keys whenever applicable:
   tenant_name, landlord_name, property_name, property_address, unit_number,
   start_date, end_date, monthly_rent, annual_rent, rent_per_sf, square_footage,
   lease_type, security_deposit, cam_amount, escalation_rate, renewal_options,
   ti_allowance, free_rent_months, lease_term_months, status,
   assignor_name, assignee_name, assignment_effective_date, landlord_consent,
   assumption_scope, assignee_notice_address.
3. Every field must include source_text copied verbatim from the same page. Use a complete sentence, clause fragment, or table row that supports the value.
4. For anything useful that is not a standard field, still extract it with a concise snake_case key so it can appear as a custom field.
5. Do not invent values. If not visible, omit it.
6. Keep values exact, especially names, dates, addresses, and money.
7. Return valid JSON only. No markdown.`,
    userPrompt: "Extract all reviewable fields and the important OCR text from this document.",
    fileBytes,
    fileUri: effectiveUri,
    fileMimeType: mimeType,
    // 32 K tokens covers leases up to ~80 pages. Files > 15 MB inline use
    // 24 K to stay under the 110s Vertex AI timeout; everything else gets
    // the full 32 K. URI-mode files (fileUri set) always use 32 K since
    // memory pressure is on Google's side, not in the Edge Function.
    maxOutputTokens: isLargeInlineFile ? 24576 : 32768,
    temperature: 0,
  });

  // If JSON extraction failed (null = model returned empty / truncated response),
  // fall back to plain-text OCR so we still get readable content from the document.
  if (!result) {
    console.warn("[ocr] JSON extraction returned null — falling back to plain-text OCR");
    let fallbackText = "";
    try {
      fallbackText = await runVisionOCR(fileBytes, mimeType, fileUri);
    } catch (fallbackErr) {
      throw new Error(`Gemini Vision failed (JSON + text fallback both failed): ${fallbackErr.message}`);
    }
    if (!fallbackText || fallbackText.length < 5) {
      throw new Error("Gemini Vision returned no text or fields.");
    }
    return {
      text: fallbackText,
      page_count: undefined,
      pages: [],
      fields: [],
      warnings: ["JSON extraction failed; plain-text OCR used as fallback — field extraction may be limited"],
    };
  }

  const cleanedPages = Array.isArray(result?.pages)
    ? result.pages
      .map((page, index) => {
        const pageNumber = Number(page?.page ?? index + 1);
        const pageFields = Array.isArray(page?.fields) ? page.fields : [];
        const cleanedPageFields = pageFields
          .map((field) => ({
            key: String(field?.key ?? "").trim(),
            value: String(field?.value ?? "").trim(),
            confidence: typeof field?.confidence === "number" ? field.confidence : 0.78,
            page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : undefined,
            source_text: String(field?.source_text ?? "").trim() || undefined,
          }))
          .filter((field) => field.key.length > 0 && field.value.length > 0)
          .slice(0, 80);
        return {
          page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : index + 1,
          text: cleanOCRText(String(page?.text ?? "")),
          fields: cleanedPageFields,
        };
      })
      .filter((page) => page.text || page.fields.length > 0)
    : [];

  const flattenedPageFields = cleanedPages.flatMap((page) => page.fields);
  const legacyFields = Array.isArray(result?.fields) ? result.fields : [];
  const cleanedLegacyFields = legacyFields
    .map((field) => ({
      key: String(field?.key ?? "").trim(),
      value: String(field?.value ?? "").trim(),
      confidence: typeof field?.confidence === "number" ? field.confidence : 0.78,
      page: typeof field?.page === "number" ? field.page : undefined,
      source_text: String(field?.source_text ?? "").trim() || undefined,
    }))
    .filter((field) => field.key.length > 0 && field.value.length > 0)
    .slice(0, 200);

  const cleanedFields = flattenedPageFields.length ? flattenedPageFields : cleanedLegacyFields;
  const textFromFields = cleanedFields.map((field) => `${field.key}: ${field.value}`).join("\n");
  const pageText = cleanedPages.map((page) => page.text).filter(Boolean).join("\n\n");
  const text = cleanOCRText([pageText, result?.text, textFromFields].filter(Boolean).join("\n\n"));

  if (!text && cleanedFields.length === 0) {
    throw new Error("Gemini Vision returned no text or fields.");
  }

  console.log(`[ocr] Combined Gemini extraction complete: ${text.length} chars, ${cleanedPages.length} pages, ${cleanedFields.length} fields`);
  return {
    text,
    page_count: typeof result?.page_count === "number" && result.page_count > 0 ? result.page_count : cleanedPages.length || undefined,
    pages: cleanedPages,
    fields: cleanedFields,
    warnings: Array.isArray(result?.warnings) ? result.warnings.map(String) : [],
  };
}

export async function extractVisibleKeyValues(
  fileBytes: Uint8Array,
  mimeType: string = "application/pdf",
  fileUri?: string,
): Promise<Array<{ key: string; value: string; confidence?: number; page?: number }>> {
  console.log(`[ocr] Extracting visible key-value pairs (${mimeType}, ${fileBytes.length} bytes)`);

  const hasVertexCreds3 = !!(
    (Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
    (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))
  );
  const hasGeminiKey3 = !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY"));

  if (!hasVertexCreds3 && !hasGeminiKey3) {
    throw new Error(
      "Key-value extraction requires Vertex AI or a Gemini API key. Set VERTEX_PROJECT_ID + GOOGLE_SERVICE_ACCOUNT_KEY " +
      "or GEMINI_API_KEY in Supabase secrets."
    );
  }

  const geminiFileJSON3 = async (opts: any) => {
    const response = await callGeminiWithAPIKeyAndFile(opts);
    let text = response.content.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/, "")
      .trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  };

  const callFileJSON3 = hasVertexCreds3
    ? async (opts: any) => {
        try {
          return await callVertexAIFileJSON(opts);
        } catch (vertexErr) {
          if (hasGeminiKey3) {
            console.warn(`[ocr] Vertex AI key-value failed (${vertexErr?.message}), falling back to Gemini API key`);
            return await geminiFileJSON3(opts);
          }
          throw vertexErr;
        }
      }
    : geminiFileJSON3;

  const INLINE_LIMIT_BYTES = 20 * 1024 * 1024;
  const useUri3 = !!fileUri && fileBytes.length > INLINE_LIMIT_BYTES;

  const result = await callFileJSON3({
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
    fileUri: useUri3 ? fileUri : undefined,
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

function cleanOCRText(text: string): string {
  if (!text) return "";

  let cleaned = text.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, "");
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");

  return cleaned.trim();
}

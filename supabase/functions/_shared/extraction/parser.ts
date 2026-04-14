// @ts-nocheck
import { DoclingOutput, DoclingTextBlock, DoclingTable, DoclingField } from "./types.ts";
import { runPaddleOCR } from "../ocr/paddle-ocr.ts";

/**
 * Shared Document Parsing Utility
 * Calls Docling API (primary) and falls back to Gemini Vision OCR (scanned documents)
 */

export async function parseDocument(
  fileBytes: Uint8Array,
  fileName: string,
  mimeType: string = "application/pdf"
): Promise<DoclingOutput> {
  const doclingUrl = Deno.env.get("DOCLING_API_URL");
  let doclingOutput: DoclingOutput | null = null;
  let extractionMethod = "unknown";
  const warnings: string[] = [];

  // 1. Try Docling API if configured (Skip for images - go straight to OCR)
  const isImage = mimeType.startsWith("image/");
  if (doclingUrl && !isImage) {
    try {
      console.log(`[parser] Calling Docling for ${fileName} (${mimeType})`);
      
      const formData = new FormData();
      formData.append("file", new Blob([fileBytes], { type: mimeType }), fileName);
      formData.append("output_formats", "text,tables,fields");

      const apiKey = Deno.env.get("DOCLING_API_KEY");
      const headers: Record<string, string> = {};
      if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

      const response = await fetch(`${doclingUrl}/api/v1/convert`, {
        method: "POST",
        headers,
        body: formData,
      });

      if (response.ok) {
        const raw = await response.json();
        doclingOutput = normaliseDoclingResponse(raw, fileName);
        extractionMethod = "docling";
      } else {
        const errText = await response.text().catch(() => "unknown error");
        console.warn(`[parser] Docling API failed (${response.status}): ${errText}`);
      }
    } catch (err) {
      console.error(`[parser] Docling extraction error: ${err.message}`);
    }
  } else {
    console.warn("[parser] DOCLING_API_URL not set — bypassing Docling");
  }

  // 2. Fallback strategy (OCR if Docling failed or returned < 5 blocks)
  const textBlocksCount = doclingOutput?.text_blocks?.length || 0;
  const isScanned = textBlocksCount < 5 && (mimeType.includes("pdf") || mimeType.startsWith("image/"));
  console.log(`[parser] textBlocksCount=${textBlocksCount}, isScanned=${isScanned}, mimeType=${mimeType}`);

  if (isScanned) {
    console.log("[parser] Using Gemini Vision OCR fallback (Docling output insufficient or missing)");

    try {
      // runPaddleOCR now uses Gemini Vision — no subprocess, no temp files
      const ocrText = await runPaddleOCR(fileBytes, mimeType);

      // Initialize or merge into Docling shape
      if (!doclingOutput) {
        doclingOutput = {
          text_blocks: [],
          tables: [],
          fields: [],
          full_text: "",
          page_count: 1
        };
      }

      doclingOutput.full_text = ocrText;
      // Split OCR text into paragraph-like blocks for rule-based extraction
      const paragraphs = ocrText.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
      doclingOutput.text_blocks = paragraphs.map((text, i) => ({
        block_index: i,
        type: "paragraph",
        text: text.trim(),
        page: 1,
      }));
      doclingOutput.extraction_method = "gemini_vision_ocr";
      console.log(`[parser] Gemini Vision OCR complete: ${ocrText.length} chars, ${paragraphs.length} blocks`);
      return doclingOutput;
    } catch (ocrErr) {
      const msg = `OCR fallback failed: ${(ocrErr as Error).message}`;
      console.error(`[parser] ${msg}`);
      warnings.push(msg);
    }
  }

  // If we have docling output (and it wasn't scanned enough to trigger OCR or OCR failed)
  if (doclingOutput) {
    doclingOutput.extraction_method = extractionMethod;
    doclingOutput.warnings = (doclingOutput.warnings || []).concat(warnings);
    return doclingOutput;
  }

  // Final fallback: return empty output with warnings (not mock data)
  console.warn("[parser] All parsing methods failed — returning empty output with warnings");
  return {
    text_blocks: [],
    tables: [],
    fields: [],
    full_text: "",
    page_count: 1,
    extraction_method: "none",
    warnings: [
      ...warnings,
      "All parsing methods failed. Ensure Vertex AI (VERTEX_PROJECT_ID + GOOGLE_SERVICE_ACCOUNT_KEY) is configured for OCR support.",
    ],
  };
}

function normaliseDoclingResponse(raw: any, fileName: string): DoclingOutput {
  const rawBlocks = raw.blocks ?? raw.paragraphs ?? raw.elements ?? [];
  const text_blocks: DoclingTextBlock[] = rawBlocks.map((b: any, i: number) => ({
    block_index: i,
    type: b.type ?? "paragraph",
    text: b.text ?? "",
    page: b.page ?? undefined,
  }));

  const rawTables = raw.tables ?? [];
  const tables: DoclingTable[] = rawTables.map((t: any, i: number) => ({
    table_index: i,
    headers: t.headers ?? [],
    rows: (t.data ?? t.rows ?? []).map((row: any) => 
      Array.isArray(row) ? row.map(String) : Object.values(row).map(String)
    ),
    markdown: t.markdown ?? undefined,
  }));

  const rawFields = raw.fields ?? raw.key_value_pairs ?? [];
  const fields: DoclingField[] = rawFields.map((f: any) => ({
    key: f.key ?? "",
    value: f.value ?? "",
    confidence: f.confidence ?? undefined,
    page: f.page ?? undefined,
  }));

  return {
    text_blocks,
    tables,
    fields,
    full_text: raw.full_text ?? text_blocks.map(b => b.text).join("\n"),
    page_count: raw.page_count ?? 1,
  };
}


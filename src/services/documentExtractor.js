/**
 * documentExtractor.js
 *
 * Universal browser-side document extractor for CRE Financial Suite.
 *
 * Supported formats:
 *   .csv / .txt  → parsingEngine (fast, no AI needed)
 *   .xlsx / .xls → SheetJS → CSV → parsingEngine
 *   .docx        → Mammoth.js → raw text → Vertex AI (Gemini)
 *   .pdf         → PDF.js → raw text → Vertex AI (Gemini)
 *
 * Returns: { rows, method, warning? }
 *   rows   — array of parsed record objects (canonical field names)
 *   method — 'csv_parser' | 'excel_parser' | 'ai_gemini' | 'text_parser'
 */

import * as parsers from "@/services/parsingEngine";
import { supabase } from "@/services/supabaseClient";

// ── Excel / SheetJS ──────────────────────────────────────────────────────────

async function extractExcel(file) {
  const { read, utils } = await import("xlsx");
  const buf = await file.arrayBuffer();
  const workbook = read(buf, { type: "array" });

  // Take the first sheet
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excel file contains no sheets.");

  const sheet = workbook.Sheets[sheetName];
  // Convert to CSV string, then let parsingEngine handle it
  const csv = utils.sheet_to_csv(sheet, { blankrows: false });
  return csv;
}

// ── Word / Mammoth ───────────────────────────────────────────────────────────

async function extractDocx(file) {
  const mammoth = await import("mammoth");
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  if (!result.value || result.value.trim().length < 10) {
    throw new Error("Could not extract text from Word document. The file may be empty or encrypted.");
  }
  return result.value;
}

// ── PDF / PDF.js ─────────────────────────────────────────────────────────────

async function extractPdf(file) {
  // Dynamically import PDF.js (lazy-loaded to keep bundle small)
  const pdfjsLib = await import("pdfjs-dist");

  // PDF.js needs a worker — use the CDN worker for simplicity
  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.js`;
  }

  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    pageTexts.push(pageText);
  }

  const fullText = pageTexts.join("\n\n").trim();

  if (fullText.length < 50) {
    throw new Error(
      "This PDF appears to be a scanned image with no text layer. " +
      "Please use a text-based PDF or convert it using Adobe Acrobat / Google Drive OCR first."
    );
  }
  return fullText;
}

// ── Vertex AI call via Supabase Edge Function ─────────────────────────────────

async function extractWithAI(rawText, moduleType, fileName) {
  const { data, error } = await supabase.functions.invoke("extract-document-fields", {
    body: { moduleType, rawText, fileName },
  });

  if (error) throw new Error(`AI extraction failed: ${error.message}`);
  if (data?.error) throw new Error(`AI extraction error: ${data.error}`);
  if (!data?.rows || data.rows.length === 0) {
    throw new Error("AI could not find any structured data in this document. Try a different file.");
  }

  return { rows: data.rows, method: "ai_gemini", model: data.model };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Extract structured records from a File object for a given CRE module.
 *
 * @param {File}   file        — The uploaded File
 * @param {string} moduleType  — 'property' | 'lease' | 'tenant' | 'unit' | ...
 * @returns {{ rows: object[], method: string, warning?: string }}
 */
export async function extractFromFile(file, moduleType) {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const parserFn = parsers.PARSER_MAP?.[moduleType];

  // ── CSV / TXT → fast local parser ─────────────────────────────────────────
  if (ext === "csv" || ext === "txt") {
    const text = await file.text();

    if (parserFn) {
      const result = parserFn(text);
      if (result.rows.length > 0) {
        return { rows: result.rows, method: "csv_parser" };
      }
    }

    // Fallback: if CSV parser found nothing useful, try AI
    console.warn("[documentExtractor] CSV parser found 0 rows — trying AI fallback");
    return await extractWithAI(text, moduleType, file.name);
  }

  // ── Excel (.xlsx / .xls) → SheetJS → CSV → local parser ──────────────────
  if (ext === "xlsx" || ext === "xls") {
    const csvText = await extractExcel(file);

    if (parserFn) {
      const result = parserFn(csvText);
      if (result.rows.length > 0) {
        return { rows: result.rows, method: "excel_parser" };
      }
    }

    // If local parser found nothing, send the CSV text to AI
    return await extractWithAI(csvText, moduleType, file.name);
  }

  // ── Word DOCX → Mammoth → raw text → AI ───────────────────────────────────
  if (ext === "docx" || ext === "doc") {
    const rawText = await extractDocx(file);
    return await extractWithAI(rawText, moduleType, file.name);
  }

  // ── PDF → PDF.js → raw text → AI ──────────────────────────────────────────
  if (ext === "pdf") {
    let rawText;
    let warning;
    try {
      rawText = await extractPdf(file);
    } catch (pdfErr) {
      // Scanned PDF fallback — show descriptive error
      throw new Error(pdfErr.message);
    }
    const result = await extractWithAI(rawText, moduleType, file.name);
    if (warning) result.warning = warning;
    return result;
  }

  throw new Error(
    `Unsupported file type: .${ext}. Please upload CSV, Excel (.xlsx), Word (.docx), PDF, or plain text (.txt).`
  );
}

/**
 * Returns a human-readable label for the extraction method.
 */
export function methodLabel(method) {
  switch (method) {
    case "csv_parser":    return "CSV Parser";
    case "excel_parser":  return "Excel Parser (SheetJS)";
    case "ai_gemini":     return "AI Extraction (Gemini 1.5 Pro)";
    case "text_parser":   return "Text Parser";
    default:              return method ?? "Unknown";
  }
}

/**
 * Returns the badge color class for the extraction method.
 */
export function methodBadgeClass(method) {
  switch (method) {
    case "csv_parser":
    case "excel_parser":
    case "text_parser":
      return "bg-slate-100 text-slate-700";
    case "ai_gemini":
      return "bg-violet-100 text-violet-700";
    default:
      return "bg-slate-100 text-slate-500";
  }
}

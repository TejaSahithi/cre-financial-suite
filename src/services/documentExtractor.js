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
 * ALL rows from ALL sources pass through normalizeAndCalculate() so that
 * derived fields (annual_rent, rent_per_sf, lease_term_months, cap_rate, etc.)
 * are always computed correctly regardless of file format.
 *
 * Returns: { rows, method, warning? }
 *   rows   — fully normalized array of record objects
 *   method — 'csv_parser' | 'excel_parser' | 'ai_gemini' | 'text_parser'
 */

import * as parsers from "@/services/parsingEngine";
import { normalizeAndCalculate } from "@/services/parsingEngine";
import { supabase } from "@/services/supabaseClient";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

// ── Excel / SheetJS ──────────────────────────────────────────────────────────

async function extractExcel(file) {
  const { read, utils } = await import("xlsx");
  const buf = await file.arrayBuffer();
  const workbook = read(buf, { type: "array" });

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("Excel file contains no sheets.");

  const sheet = workbook.Sheets[sheetName];
  // Convert to CSV, then let parsingEngine handle column mapping
  return utils.sheet_to_csv(sheet, { blankrows: false });
}

// ── Word / Mammoth ───────────────────────────────────────────────────────────

async function extractDocx(file) {
  const mammoth = await import("mammoth");
  const buf = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: buf });
  if (!result.value || result.value.trim().length < 10) {
    throw new Error(
      "Could not extract text from this Word document. It may be empty or password-protected."
    );
  }
  return result.value;
}

// ── PDF / PDF.js ─────────────────────────────────────────────────────────────

async function extractPdf(file) {
  const pdfjsLib = await import("pdfjs-dist");

  if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  }

  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const pageTexts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    // Preserve line breaks by grouping items with significant y-gaps
    let lastY = null;
    const parts = [];
    for (const item of content.items) {
      if (lastY !== null && Math.abs(item.transform[5] - lastY) > 5) {
        parts.push("\n");
      }
      parts.push(item.str);
      lastY = item.transform[5];
    }
    pageTexts.push(parts.join(" "));
  }

  const fullText = pageTexts.join("\n\n").replace(/\s{3,}/g, "  ").trim();

  if (fullText.length < 50) {
    throw new Error(
      "This PDF has no selectable text — it appears to be a scanned image. " +
      "Please open it in Adobe Acrobat or Google Drive and use 'Make Searchable PDF' / OCR, then re-upload."
    );
  }
  return fullText;
}

// ── Vertex AI call via Supabase Edge Function ─────────────────────────────────

async function extractWithAI(rawText, moduleType, fileName) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    throw new Error("AI extraction requires an authenticated session.");
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const res = await fetch(`${supabaseUrl}/functions/v1/extract-document-fields`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${session.access_token}`,
      "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ moduleType, rawText, fileName }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`AI extraction failed: ${data?.error || data?.message || res.statusText}`);
  }
  if (data?.error) throw new Error(`AI extraction error: ${data.error}`);
  if (!data?.rows || data.rows.length === 0) {
    throw new Error(
      "Gemini could not find structured data in this document. " +
      "Make sure the document contains identifiable fields."
    );
  }

  return { rows: data.rows, method: "ai_gemini", model: data.model };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Extract structured records from a File object for a given CRE module.
 * ALL rows pass through normalizeAndCalculate() before being returned.
 *
 * @param {File}   file        — The uploaded File
 * @param {string} moduleType  — 'property' | 'lease' | 'tenant' | 'unit' | ...
 * @returns {{ rows: object[], method: string, warning?: string }}
 */
export async function extractFromFile(file, moduleType) {
  const ext    = (file.name.split(".").pop() ?? "").toLowerCase();
  const parser = parsers.PARSER_MAP?.[moduleType];

  let rawRows;
  let method;

  // ── CSV / TXT ─────────────────────────────────────────────────────────────
  if (ext === "csv" || ext === "txt") {
    const text = await file.text();

    if (parser) {
      const result = parser(text);
      if (result.rows.length > 0) {
        rawRows = result.rows;
        method  = result.method || "csv_parser";
      }
    }

    // If CSV parser found nothing, try AI as fallback
    if (!rawRows) {
      console.warn("[documentExtractor] CSV parser found 0 rows — trying AI");
      const aiResult = await extractWithAI(text, moduleType, file.name);
      rawRows = aiResult.rows;
      method  = aiResult.method;
    }
  }

  // ── Excel (.xlsx / .xls) ──────────────────────────────────────────────────
  else if (ext === "xlsx" || ext === "xls") {
    const csvText = await extractExcel(file);

    if (parser) {
      const result = parser(csvText);
      if (result.rows.length > 0) {
        rawRows = result.rows;
        method  = result.method || "excel_parser";
      }
    }

    // If local parser found nothing, send to AI
    if (!rawRows) {
      const aiResult = await extractWithAI(csvText, moduleType, file.name);
      rawRows = aiResult.rows;
      method  = aiResult.method;
    }
  }

  // ── Word DOCX ─────────────────────────────────────────────────────────────
  else if (ext === "docx" || ext === "doc") {
    const rawText  = await extractDocx(file);
    const aiResult = await extractWithAI(rawText, moduleType, file.name);
    rawRows = aiResult.rows;
    method  = aiResult.method;
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  else if (ext === "pdf") {
    const rawText  = await extractPdf(file);
    const aiResult = await extractWithAI(rawText, moduleType, file.name);
    rawRows = aiResult.rows;
    method  = aiResult.method;
  }

  // ── Unsupported ───────────────────────────────────────────────────────────
  else {
    throw new Error(
      `Unsupported file type: .${ext}. ` +
      `Accepted formats: CSV, Excel (.xlsx/.xls), Word (.docx), PDF, plain text (.txt).`
    );
  }

  // ── CRITICAL: Run all calculations on every row regardless of source ───────
  const normalizedRows = normalizeAndCalculate(moduleType, rawRows);

  return { rows: normalizedRows, method };
}

// ── UI Helper exports ─────────────────────────────────────────────────────────

/** Human-readable label for the extraction method. */
export function methodLabel(method) {
  switch (method) {
    case "csv_parser":    return "CSV Parser";
    case "excel_parser":  return "Excel Parser (SheetJS)";
    case "ai_gemini":     return "AI Extraction (Gemini 1.5 Pro)";
    case "text_parser":   return "Text Parser";
    default:              return method ?? "Unknown";
  }
}

/** Tailwind badge class for the extraction method. */
export function methodBadgeClass(method) {
  switch (method) {
    case "csv_parser":
    case "excel_parser":
    case "text_parser":   return "bg-slate-100 text-slate-700";
    case "ai_gemini":     return "bg-violet-100 text-violet-700";
    default:              return "bg-slate-100 text-slate-500";
  }
}

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
 * Responsibility split (enforced):
 *   CSV/Excel → parsingEngine normalizeAndCalculate (client-side)
 *   PDF/Word  → extract-document-fields Edge Function (server-side)
 *     The edge function handles its own normalization + calculations.
 *     We NEVER run normalizeAndCalculate on AI rows to avoid overwriting.
 *
 * Returns: { rows, method, warnings?, validationErrors?, extractionSummary? }
 *   rows              — fully normalized array of record objects
 *   method            — 'csv_parser' | 'excel_parser' | 'ai_gemini' | 'text_parser'
 *   warnings          — non-fatal issues from extraction (e.g. LLM skipped)
 *   validationErrors  — fields the pipeline rejected and why
 *   extractionSummary — stats from edge function (rule/table/llm field counts)
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
    // If it's a scanned PDF, we convert the original file to Base64 
    // so the edge function can use Gemini Vision.
    const fileBase64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = error => reject(error);
    });
    console.warn("[documentExtractor] Scanned PDF detected, passing as Base64 image payload.");
    return { rawText: "", fileBase64, fileMimeType: "application/pdf" };
  }
  return fullText;
}

// ── Images / Generic Base64 ──────────────────────────────────────────────────

async function extractImage(file) {
  const fileBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = (error) => reject(error);
  });
  return { rawText: "", fileBase64, fileMimeType: file.type || "image/png" };
}


// ── Vertex AI call via Supabase Edge Function ─────────────────────────────────

async function extractWithAI(rawText, moduleType, fileName, fileBase64 = null, fileMimeType = null) {
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
    body: JSON.stringify({ moduleType, rawText, fileName, fileBase64, fileMimeType }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(`AI extraction failed: ${data?.error || data?.message || res.statusText}`);
  }
  if (data?.error) throw new Error(`AI extraction error: ${data.error}`);
  if (!data?.rows || data.rows.length === 0) {
    const isMissingConfig = (data.warnings || []).some(w => 
      w.toLowerCase().includes("vertex ai not configured") || 
      w.toLowerCase().includes("missing env vars")
    );

    if (isMissingConfig) {
      throw new Error(
        "AI Extraction (Gemini) is not configured. Please ensure VERTEX_PROJECT_ID and GOOGLE_SERVICE_ACCOUNT_KEY " +
        "are set in your Supabase project secrets."
      );
    }

    const hasWarnings = (data.warnings || []).length > 0;
    const warningText = hasWarnings ? ` (Reason: ${data.warnings[0]})` : "";

    throw new Error(
      `Gemini could not find structured data in this document.${warningText} ` +
      "Make sure the document contains identifiable fields and all OCR dependencies are installed."
    );
  }

  // ── Debug: log raw AI response ────────────────────────────────────────────
  console.log("[documentExtractor] AI raw response:", {
    rows: data.rows.length,
    method: data.method,
    warnings: data.warnings,
    validationErrors: data.validationErrors,
    extractionSummary: data.extraction_summary,
    row0: data.rows[0],
  });

  // ── Normalize AI rows ─────────────────────────────────────────────────────
  // The extraction pipeline stores per-field confidence in `_field_confidences`
  // (0–1 float range). The rest of the app expects `confidence_scores` (0–100 int).
  const normalizedRows = data.rows.map((row) => {
    const r = { ...row };
    // Map _field_confidences → confidence_scores
    if (r._field_confidences && !r.confidence_scores) {
      const scores = {};
      for (const [field, conf] of Object.entries(r._field_confidences)) {
        // Pipeline uses 0–1 range; UI expects 0–100
        scores[field] = typeof conf === "number" && conf <= 1
          ? Math.round(conf * 100)
          : conf;
      }
      r.confidence_scores = scores;
    }
    // Remove internal metadata keys — they don't belong in UI state
    delete r._field_confidences;
    delete r._field_sources;
    return r;
  });

  return {
    rows: normalizedRows,
    method: "ai_gemini",
    model: data.model,
    // Surface pipeline diagnostics to the caller
    warnings: data.warnings || [],
    validationErrors: data.validationErrors || [],
    extractionSummary: data.extraction_summary || null,
  };
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Extract structured records from a File object for a given CRE module.
 *
 * CSV/Excel rows are normalized via normalizeAndCalculate() (client-side).
 * PDF/Word/AI rows are NOT re-normalized — the edge function already handles
 * all calculations server-side. Running normalizeAndCalculate() again would
 * overwrite correctly extracted values with potentially wrong recalculations.
 *
 * @param {File}   file        — The uploaded File
 * @param {string} moduleType  — 'property' | 'lease' | 'tenant' | 'unit' | ...
 * @returns {{ rows, method, warnings?, validationErrors?, extractionSummary? }}
 */
export async function extractFromFile(file, moduleType) {
  const ext    = (file.name.split(".").pop() ?? "").toLowerCase();
  const parser = parsers.PARSER_MAP?.[moduleType];

  let rawRows;
  let method;
  let aiMeta = { warnings: [], validationErrors: [], extractionSummary: null };
  let isAIResult = false;

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
      rawRows  = aiResult.rows;
      method   = aiResult.method;
      aiMeta   = { warnings: aiResult.warnings, validationErrors: aiResult.validationErrors, extractionSummary: aiResult.extractionSummary };
      isAIResult = true;
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
      rawRows  = aiResult.rows;
      method   = aiResult.method;
      aiMeta   = { warnings: aiResult.warnings, validationErrors: aiResult.validationErrors, extractionSummary: aiResult.extractionSummary };
      isAIResult = true;
    }
  }

  // ── Word DOCX ─────────────────────────────────────────────────────────────
  else if (ext === "docx" || ext === "doc") {
    const rawText  = await extractDocx(file);
    try {
      const aiResult = await extractWithAI(rawText, moduleType, file.name);
      rawRows  = aiResult.rows;
      method   = aiResult.method;
      aiMeta   = { warnings: aiResult.warnings, validationErrors: aiResult.validationErrors, extractionSummary: aiResult.extractionSummary };
      isAIResult = true;
    } catch (err) {
      if (parser) {
        const fallbackResult = parser(rawText);
        if (fallbackResult.rows.length > 0) {
          rawRows = fallbackResult.rows;
          method = fallbackResult.method || "text_parser";
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
  }

  // ── PDF ───────────────────────────────────────────────────────────────────
  else if (ext === "pdf") {
    let pdfRawText = "";
    let pdfBase64 = null;
    let pdfMimeType = null;
    
    const pdfTextOrObj = await extractPdf(file);
    if (typeof pdfTextOrObj === "string") {
      pdfRawText = pdfTextOrObj;
    } else {
      pdfRawText = pdfTextOrObj.rawText;
      pdfBase64 = pdfTextOrObj.fileBase64;
      pdfMimeType = pdfTextOrObj.fileMimeType;
    }

    try {
      const aiResult = await extractWithAI(pdfRawText, moduleType, file.name, pdfBase64, pdfMimeType);
      rawRows  = aiResult.rows;
      method   = aiResult.method;
      aiMeta   = { warnings: aiResult.warnings, validationErrors: aiResult.validationErrors, extractionSummary: aiResult.extractionSummary };
      isAIResult = true;
    } catch (err) {
      if (parser && pdfRawText.length > 50) {
        const fallbackResult = parser(pdfRawText);
        if (fallbackResult.rows.length > 0) {
          rawRows = fallbackResult.rows;
          method = fallbackResult.method || "text_parser";
        } else {
          throw err;
        }
      } else {
        throw err;
    }
  }

  // ── Images (PNG, JPG, etc.) ───────────────────────────────────────────────
  else if (ext === "png" || ext === "jpg" || ext === "jpeg") {
    const { rawText, fileBase64, fileMimeType } = await extractImage(file);
    try {
      const aiResult = await extractWithAI(rawText, moduleType, file.name, fileBase64, fileMimeType);
      rawRows = aiResult.rows;
      method = aiResult.method;
      aiMeta = {
        warnings: aiResult.warnings,
        validationErrors: aiResult.validationErrors,
        extractionSummary: aiResult.extractionSummary,
      };
      isAIResult = true;
    } catch (err) {
      throw err;
    }
  }


  // ── Unsupported ───────────────────────────────────────────────────────────
  else {
    throw new Error(
      `Unsupported file type: .${ext}. ` +
      `Accepted formats: CSV, Excel (.xlsx/.xls), Word (.docx), PDF, plain text (.txt).`
    );
  }

  // ── Post-processing ───────────────────────────────────────────────────────
  // For AI results: the edge function already ran calculations server-side.
  // DO NOT run normalizeAndCalculate() again — it would overwrite correct values.
  // For CSV/Excel/text results: run client-side normalization as usual.

  let finalRows;

  if (isAIResult) {
    // AI result: preserve confidence metadata + extraction_notes
    // Only re-attach metadata that normalizeAndCalculate would strip
    finalRows = rawRows.map((row) => {
      const r = { ...row };
      // Ensure confidence_score is preserved (it comes from the edge function)
      return r;
    });
    console.log("[documentExtractor] AI result — skipping normalizeAndCalculate to preserve extracted values");
  } else {
    // CSV / Excel / text result: run full normalization including derived field calculation
    // Preserve confidence_scores (and any other metadata) before normalization
    const confidenceScoresMap  = rawRows.map(r => r?.confidence_scores  || null);
    const confidenceScoreMap   = rawRows.map(r => r?.confidence_score   ?? null);
    const extractionNotesMap   = rawRows.map(r => r?.extraction_notes   || null);

    finalRows = normalizeAndCalculate(moduleType, rawRows);

    // Re-attach confidence metadata after normalization
    finalRows.forEach((row, i) => {
      if (confidenceScoresMap[i])          row.confidence_scores  = confidenceScoresMap[i];
      if (confidenceScoreMap[i] !== null)  row.confidence_score   = confidenceScoreMap[i];
      if (extractionNotesMap[i])           row.extraction_notes   = extractionNotesMap[i];
    });

    console.log("[documentExtractor] CSV/Excel result — normalizeAndCalculate applied");
  }

  console.log("[documentExtractor] Final result:", {
    rows: finalRows.length,
    method,
    isAIResult,
    warnings: aiMeta.warnings?.length,
    validationErrors: aiMeta.validationErrors?.length,
    row0: finalRows[0],
  });

  return {
    rows: finalRows,
    method,
    warnings: aiMeta.warnings,
    validationErrors: aiMeta.validationErrors,
    extractionSummary: aiMeta.extractionSummary,
  };
}

// ── UI Helper exports ─────────────────────────────────────────────────────────

/** Human-readable label for the extraction method. */
export function methodLabel(method) {
  switch (method) {
    case "csv_parser":    return "CSV Parser";
    case "excel_parser":  return "Excel Parser (SheetJS)";
    case "ai_gemini":     return "AI Extraction (Gemini)";
    case "text_parser":   return "Text Parser";
    default:              return method ?? "Unknown";
  }
}

/** Badge class for the extraction method. */
export function methodBadgeClass(method) {
  switch (method) {
    case "csv_parser":
    case "excel_parser":
    case "text_parser":   return "bg-slate-100 text-slate-700";
    case "ai_gemini":     return "bg-violet-100 text-violet-700";
    default:              return "bg-slate-100 text-slate-500";
  }
}

// @ts-nocheck
/**
 * Extraction Pipeline — Main Orchestrator (v3)
 *
 * Responsibility split (enforced):
 *   Docling   → parsing only (text + table structure)
 *   Rule/Table → PRIMARY extraction (deterministic, highest confidence)
 *   LLM        → FALLBACK only for missing fields (never primary)
 *   Code       → validation, normalization, all calculations
 *
 * Pipeline steps:
 *   Step 0: Normalize  — clean Docling output (OCR noise, whitespace, dedup)
 *   Step 1: Rule-Based — regex + label patterns against normalized text
 *   Step 2: Table      — structured table extraction (highest priority for tabular docs)
 *   Step 3: LLM        — ONLY for fields still missing after Steps 1+2
 *   Step 4: Merge      — rule > table > llm by confidence
 *   Step 5: Validate   — types, ranges, schema enforcement
 *   Step 6: Calculate  — derived fields (code only, never overwrites extracted values)
 */

import type {
  DoclingOutput,
  ExtractionInput,
  ExtractionOptions,
  ExtractionPipelineResult,
  ModuleType,
} from "./types.ts";
import { extractRuleBased } from "./rule-extractor.ts";
import { extractFromTables } from "./table-extractor.ts";
import { extractWithLLM } from "./llm-extractor.ts";
import { mergeResults, findMissingFields } from "./merger.ts";
import { validateRecords, flattenRecords } from "./validator.ts";
import { computeDerivedFields } from "./calculator.ts";
import { parseDocument } from "./parser.ts";

// ── Step 0: Normalize Docling output ─────────────────────────────────────────

/**
 * Normalize Docling output before extraction.
 *
 * Problems solved:
 *   - OCR noise (control chars, repeated whitespace, hyphenation artifacts)
 *   - Inconsistent line structure (merged lines, split words)
 *   - Deduplication of repeated header/footer text blocks
 *   - Ensure `full_text` is always populated for rule-based extraction
 */
function normalizeDoclingOutput(docling: DoclingOutput): DoclingOutput {
  const normalized = { ...docling };

  // 1. Normalize each text block
  const seenTexts = new Set<string>();
  const normalizedBlocks = (docling.text_blocks ?? [])
    .map((block) => {
      let text = block.text ?? "";
      // Remove control characters and null bytes
      text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ");
      // Normalize whitespace (preserve line breaks)
      text = text.replace(/[ \t]+/g, " ").trim();
      // Fix hyphenated line breaks: "some- \nthing" → "something"
      text = text.replace(/-\s*\n\s*/g, "");
      return { ...block, text };
    })
    .filter((block) => {
      // Remove empty blocks
      if (!block.text || block.text.length < 3) return false;
      // Deduplicate repeated blocks (headers/footers that repeat on every page)
      const key = block.text.toLowerCase().slice(0, 80);
      if (seenTexts.has(key)) return false;
      seenTexts.add(key);
      return true;
    });

  normalized.text_blocks = normalizedBlocks;

  // 2. Rebuild full_text from normalized blocks
  const fullText = normalizedBlocks.map((b) => b.text).join("\n");
  normalized.full_text = fullText;

  // 3. Normalize tables: clean header cells and trim values
  if (docling.tables && docling.tables.length > 0) {
    normalized.tables = docling.tables.map((table) => ({
      ...table,
      headers: (table.headers ?? []).map((h) =>
        h.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").trim()
      ),
      rows: (table.rows ?? []).map((row) =>
        row.map((cell) => (cell ?? "").toString().trim())
      ),
    }));
  }

  // 4. Normalize Docling key-value fields
  if (docling.fields && docling.fields.length > 0) {
    normalized.fields = docling.fields
      .filter((f) => f.key && f.value)
      .map((f) => ({
        ...f,
        key: f.key.trim(),
        value: f.value.toString().trim(),
        confidence: f.confidence ?? 0.85,
      }));
  }

  return normalized;
}

// ── Convert raw text to minimal DoclingOutput (backward compat) ──────────────

function rawTextToDocling(rawText: string): DoclingOutput {
  // Split text into paragraph-like blocks
  const paragraphs = rawText.split(/\n\s*\n/).filter((p) => p.trim().length > 0);

  return {
    text_blocks: paragraphs.map((text, i) => ({
      block_index: i,
      type: "paragraph",
      text: text.trim(),
    })),
    tables: [],
    fields: [],
    full_text: rawText,
  };
}

// ── Debug logger ──────────────────────────────────────────────────────────────

function createLogger(moduleType: string, fileName: string) {
  const prefix = `[pipeline:${moduleType}:${fileName}]`;
  return {
    step: (step: number, name: string, detail = "") =>
      console.log(`${prefix} STEP ${step}: ${name}${detail ? ` — ${detail}` : ""}`),
    info: (msg: string) => console.log(`${prefix} ${msg}`),
    warn: (msg: string) => console.warn(`${prefix} WARN: ${msg}`),
    result: (label: string, count: number, fields: string[] = []) =>
      console.log(
        `${prefix} ✓ ${label}: ${count} field(s)` +
        (fields.length > 0 ? ` [${fields.slice(0, 8).join(", ")}${fields.length > 8 ? "…" : ""}]` : "")
      ),
  };
}

// ── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full hybrid extraction pipeline.
 *
 * Priority order enforced:
 *   1. Rule-based (regex/patterns) — always runs first
 *   2. Table-based (Docling tables) — always runs second, may override rule results with higher confidence
 *   3. LLM — ONLY for fields still missing after 1+2
 *
 * Accepts either structured DoclingOutput or raw text (backward compat).
 * Returns flat row objects ready for the API response.
 */
export async function runExtractionPipeline(
  input: ExtractionInput,
  options: ExtractionOptions = {},
): Promise<ExtractionPipelineResult> {
  const startTime = Date.now();
  const allWarnings: string[] = [];

  const {
    maxLLMChunks = 6,
    chunkSize = 1500,
    llmTemperature = 0,
    skipLLM = false,
    confidenceThreshold = 0.4,
  } = options;

  const fileName = input.fileName ?? "document";
  const log = createLogger(input.moduleType, fileName);

  // ── Normalize/Parse input ──────────────────────────────────────────────────────
  log.info(`Starting pipeline: moduleType=${input.moduleType}, rawText=${(input.rawText ?? "").length} chars, docling=${!!input.docling}, fileBase64=${!!input.fileBase64}`);

  let rawDocling: DoclingOutput;

  if (input.docling) {
    rawDocling = input.docling;
  } else if (input.fileBase64) {
    log.info("No docling output provided — parsing raw file bytes");
    // Convert base64 to Uint8Array
    const binaryString = atob(input.fileBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    rawDocling = await parseDocument(bytes, input.fileName || "document", input.fileMimeType || "application/pdf");
  } else {
    rawDocling = rawTextToDocling(input.rawText ?? "");
  }

  const moduleType: ModuleType = input.moduleType;

  // ── STEP 0: Normalize ────────────────────────────────────────────────────
  log.step(0, "Normalization", `text_blocks=${rawDocling.text_blocks?.length ?? 0}, tables=${rawDocling.tables?.length ?? 0}`);
  const docling = normalizeDoclingOutput(rawDocling);

  const fullText = docling.full_text ?? "";
  log.info(`Normalized: ${fullText.length} chars, ${docling.text_blocks?.length ?? 0} blocks, ${docling.tables?.length ?? 0} tables`);

  if (fullText.trim().length < 10) {
    log.warn("Document text too short — aborting pipeline");
    return {
      rows: [],
      method: "fallback",
      warnings: ["Document text is too short for extraction"],
      validationErrors: [],
      metadata: {
        ruleFieldsExtracted: 0,
        tableFieldsExtracted: 0,
        llmFieldsExtracted: 0,
        totalRecords: 0,
        avgConfidence: 0,
        chunksProcessed: 0,
        processingTimeMs: Date.now() - startTime,
      },
    };
  }

  // ── STEP 1: Rule-Based Extraction ────────────────────────────────────────
  log.step(1, "Rule-Based Extraction");
  const ruleResult = extractRuleBased(docling, moduleType);
  allWarnings.push(...ruleResult.warnings);

  const ruleFieldCount = ruleResult.records.reduce(
    (sum, r) => sum + Object.keys(r.fields).length, 0,
  );
  const ruleFieldNames = ruleResult.records.flatMap((r) => Object.keys(r.fields));
  log.result("Rule extraction", ruleFieldCount, ruleFieldNames);

  // ── STEP 2: Table-Based Extraction ───────────────────────────────────────
  log.step(2, "Table-Based Extraction", `tables=${docling.tables?.length ?? 0}`);
  const tableResult = extractFromTables(docling.tables ?? [], moduleType);
  allWarnings.push(...tableResult.warnings);

  const tableFieldCount = tableResult.records.reduce(
    (sum, r) => sum + Object.keys(r.fields).length, 0,
  );
  const tableFieldNames = tableResult.records.flatMap((r) => Object.keys(r.fields));
  log.result("Table extraction", tableFieldCount, tableFieldNames);

  // ── STEP 3: LLM Extraction (FALLBACK for missing fields only) ───────────
  let llmResult = { records: [], warnings: [] as string[] };
  let llmFieldCount = 0;
  let chunksProcessed = 0;

  if (!skipLLM) {
    const missingFields = findMissingFields(ruleResult, tableResult, moduleType);
    log.step(3, "LLM Extraction (fallback)", `missing=${missingFields.length} fields: [${missingFields.join(", ")}]`);

    if (missingFields.length > 0) {
      // Merge existing records for context
      const existingMerge = mergeResults(ruleResult, tableResult, { records: [], warnings: [] }, moduleType);

      llmResult = await extractWithLLM(
        input,
        docling,
        missingFields,
        moduleType,
        existingMerge.records,
        { maxChunks: maxLLMChunks, temperature: llmTemperature },
      );
      allWarnings.push(...llmResult.warnings);

      // Check if LLM was skipped (Vertex AI not configured)
      const llmSkipped = llmResult.warnings.some((w) =>
        w.toLowerCase().includes("vertex ai not configured") ||
        w.toLowerCase().includes("skipping llm")
      );
      if (llmSkipped) {
        log.warn("LLM skipped — Vertex AI not configured. Only rule/table extraction results available.");
        allWarnings.push(
          "⚠️ LLM extraction was skipped because Vertex AI (VERTEX_PROJECT_ID / GOOGLE_SERVICE_ACCOUNT_KEY) is not configured. " +
          "Fields not found by rule-based or table extraction will be empty. " +
          "Configure Vertex AI to enable full AI extraction."
        );
      }

      llmFieldCount = llmResult.records.reduce(
        (sum, r) => sum + Object.keys(r.fields).length, 0,
      );
      const llmFieldNames = llmResult.records.flatMap((r) => Object.keys(r.fields));
      log.result("LLM extraction", llmFieldCount, llmFieldNames);
    } else {
      log.info("Step 3 skipped — all fields already extracted by rule/table steps");
    }
  } else {
    log.info("Step 3 skipped — LLM disabled by options");
    allWarnings.push("LLM extraction was skipped (disabled by options)");
  }

  // ── STEP 4: Merge Results ────────────────────────────────────────────────
  log.step(4, "Merge", "rule > table > llm by confidence");
  const merged = mergeResults(ruleResult, tableResult, llmResult, moduleType);
  allWarnings.push(...merged.warnings);
  log.info(`Merged: ${merged.records.length} record(s)`);

  // Log extracted fields for debugging
  if (merged.records.length > 0) {
    const fieldSummary = Object.entries(merged.records[0].fields)
      .map(([k, v]) => `${k}=${JSON.stringify(v.value)}@${Math.round(v.confidence * 100)}%`)
      .join(", ");
    log.info(`Record[0] fields: ${fieldSummary}`);
  }

  // ── STEP 5: Validate ─────────────────────────────────────────────────────
  log.step(5, "Validation");
  const validated = validateRecords(merged.records, moduleType);

  if (validated.errors.length > 0) {
    log.warn(`${validated.errors.length} validation error(s):`);
    for (const err of validated.errors.slice(0, 5)) {
      log.warn(`  field="${err.field}" — ${err.message} (received: ${JSON.stringify(err.receivedValue)})`);
    }
  } else {
    log.info("Validation passed — no errors");
  }

  // ── STEP 6: Calculate Derived Fields ─────────────────────────────────────
  log.step(6, "Calculate Derived Fields");
  const flatRows = flattenRecords(validated.records, moduleType);
  computeDerivedFields(flatRows, moduleType);

  const derivedLog = flatRows.length > 0
    ? Object.entries(flatRows[0])
        .filter(([k]) => !k.startsWith("_") && k !== "confidence_score" && k !== "extraction_notes")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ")
    : "no rows";
  log.info(`Final row[0]: ${derivedLog}`);

  // ── Build method indicator ───────────────────────────────────────────────
  let method: ExtractionPipelineResult["method"] = "hybrid";
  if (ruleFieldCount > 0 && tableFieldCount === 0 && llmFieldCount === 0) method = "rule_only";
  else if (tableFieldCount > 0 && ruleFieldCount === 0 && llmFieldCount === 0) method = "table_only";
  else if (llmFieldCount > 0 && ruleFieldCount === 0 && tableFieldCount === 0) method = "llm_only";
  else if (flatRows.length === 0) method = "fallback";

  // ── Compute average confidence ───────────────────────────────────────────
  const avgConfidence = flatRows.length > 0
    ? Math.round(
        flatRows.reduce((sum, r) => sum + ((r.confidence_score as number) || 0), 0) / flatRows.length,
      )
    : 0;

  const processingTimeMs = Date.now() - startTime;
  log.info(
    `Pipeline complete: ${flatRows.length} rows, method=${method}, ` +
    `confidence=${avgConfidence}%, time=${processingTimeMs}ms, ` +
    `rule=${ruleFieldCount}f / table=${tableFieldCount}f / llm=${llmFieldCount}f`,
  );

  return {
    rows: flatRows,
    method,
    warnings: allWarnings,
    validationErrors: validated.errors,
    metadata: {
      ruleFieldsExtracted: ruleFieldCount,
      tableFieldsExtracted: tableFieldCount,
      llmFieldsExtracted: llmFieldCount,
      totalRecords: flatRows.length,
      avgConfidence,
      chunksProcessed,
      parsingMethod: rawDocling.extraction_method || "text",
      charCount: fullText.length,
      processingTimeMs,
    },
  };
}

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
import { getSchema } from "./schemas.ts";

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

  // 2. Rebuild full_text from normalized blocks plus explicit key/value fields.
  // Keep the parser-provided full_text when it is richer than the rebuilt
  // blocks. Some parsers return a complete full_text but sparse blocks; if we
  // discard that here, downstream lease extraction reviews a tiny slice of the
  // lease and incorrectly marks fields as Not Found.
  const blockText = normalizedBlocks.map((b) => b.text).join("\n");
  const rawFullText = String(docling.full_text ?? "")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const fieldText = (docling.fields ?? [])
    .filter((f) => f?.key && f?.value)
    .map((f) => `${String(f.key).trim()}: ${String(f.value).trim()}`)
    .join("\n");
  const primaryText = rawFullText.length > blockText.length ? rawFullText : blockText;
  normalized.full_text = [primaryText, fieldText].filter(Boolean).join("\n");

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

function sanitizeUserWarning(warning: string): string {
  const text = String(warning || "");
  if (/GOOGLE_SERVICE_ACCOUNT_KEY|service account|Vertex AI|JWT|private_key/i.test(text)) {
    return "AI fallback extraction is unavailable because Google Vertex AI is not fully configured. Deterministic document parsing still ran.";
  }
  return text;
}

function addWarnings(target: string[], warnings: string[]) {
  for (const warning of warnings || []) {
    const sanitized = sanitizeUserWarning(warning);
    if (sanitized && !target.includes(sanitized)) target.push(sanitized);
  }
}

function getAllExtractableFieldNames(moduleType: ModuleType): string[] {
  return Object.entries(getSchema(moduleType))
    .filter(([, def]) => !def.derived)
    .map(([name]) => name);
}

export function snapshotFieldMap(records: any[]): Record<string, Record<string, unknown>> {
  const first = records?.[0]?.fields ?? {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [field, entry] of Object.entries(first)) {
    out[field] = {
      value: (entry as any)?.value ?? null,
      source: (entry as any)?.source ?? null,
      confidence: (entry as any)?.confidence ?? null,
      source_text: (entry as any)?.sourceText ?? (entry as any)?.source_text ?? null,
      source_page: (entry as any)?.sourcePage ?? (entry as any)?.source_page ?? null,
    };
  }
  return out;
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
  } else if ((input.rawText ?? "").trim().length > 0) {
    rawDocling = rawTextToDocling(input.rawText ?? "");
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
  const isLeaseLikeModule = ["lease", "leases"].includes(String(moduleType));

  // ── STEP 0: Normalize ────────────────────────────────────────────────────
  log.step(0, "Normalization", `text_blocks=${rawDocling.text_blocks?.length ?? 0}, tables=${rawDocling.tables?.length ?? 0}`);
  const docling = normalizeDoclingOutput(rawDocling);

  const fullText = docling.full_text ?? "";
  const hasStructuredFields = (docling.fields?.length ?? 0) > 0;
  const embeddedTextChars = fullText.length;
  const fileBase64Available = Boolean(input.fileBase64);
  const LEASE_SHALLOW_TEXT_THRESHOLD = 2500;
  const shallowLeaseTextDetected =
    isLeaseLikeModule &&
    fileBase64Available &&
    embeddedTextChars > 0 &&
    embeddedTextChars < LEASE_SHALLOW_TEXT_THRESHOLD;
  log.info(`Normalized: ${fullText.length} chars, ${docling.text_blocks?.length ?? 0} blocks, ${docling.tables?.length ?? 0} tables`);

  if (fullText.trim().length < 10 && !input.fileBase64 && !hasStructuredFields) {
    log.warn("Document text too short and no file bytes available — aborting pipeline");
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

  if (fullText.trim().length < 10 && input.fileBase64 && !hasStructuredFields) {
    log.info("Document text too short but fileBase64 present — skipping rule/table, delegating to LLM Vision");
  }

  // ── STEP 1: Rule-Based Extraction ────────────────────────────────────────
  log.step(1, "Rule-Based Extraction");
  const ruleResult = extractRuleBased(docling, moduleType);
  addWarnings(allWarnings, ruleResult.warnings);

  const ruleFieldCount = ruleResult.records.reduce(
    (sum, r) => sum + Object.keys(r.fields).length, 0,
  );
  const ruleFieldNames = ruleResult.records.flatMap((r) => Object.keys(r.fields));
  log.result("Rule extraction", ruleFieldCount, ruleFieldNames);

  // ── STEP 2: Table-Based Extraction ───────────────────────────────────────
  log.step(2, "Table-Based Extraction", `tables=${docling.tables?.length ?? 0}`);
  const tableResult = extractFromTables(docling.tables ?? [], moduleType);
  addWarnings(allWarnings, tableResult.warnings);

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
    const initialMissingFields = findMissingFields(ruleResult, tableResult, moduleType);
    const missingFields = shallowLeaseTextDetected
      ? [...new Set([...initialMissingFields, ...getAllExtractableFieldNames(moduleType)])]
      : initialMissingFields;
    log.step(
      3,
      "LLM Extraction (fallback)",
      `missing=${missingFields.length} fields: [${missingFields.join(", ")}]` +
        (shallowLeaseTextDetected ? " (full lease field pass because parser text is shallow)" : ""),
    );

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
      addWarnings(allWarnings, llmResult.warnings);

      // Check if LLM was skipped (Vertex AI not configured)
      const llmSkipped = llmResult.warnings.some((w) =>
        w.toLowerCase().includes("vertex ai not configured") ||
        w.toLowerCase().includes("skipping llm")
      );
      if (llmSkipped) {
        log.warn("LLM skipped — Vertex AI not configured. Only rule/table extraction results available.");
        addWarnings(allWarnings, [
          "⚠️ LLM extraction was skipped because Vertex AI (VERTEX_PROJECT_ID / GOOGLE_SERVICE_ACCOUNT_KEY) is not configured. " +
          "Fields not found by rule-based or table extraction will be empty. " +
          "Configure Vertex AI to enable full AI extraction."
        ]);
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
    addWarnings(allWarnings, ["LLM extraction was skipped (disabled by options)"]);
  }

  // ── STEP 4: Merge Results ────────────────────────────────────────────────
  log.step(4, "Merge", "rule > table > llm by confidence");
  const merged = mergeResults(ruleResult, tableResult, llmResult, moduleType);
  addWarnings(allWarnings, merged.warnings);
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
  const preValidationFields = snapshotFieldMap(merged.records as any[]);
  const validated = validateRecords(merged.records, moduleType);
  const postValidationFields = snapshotFieldMap(validated.records as any[]);
  const validatorFieldStatus: Record<string, string> = {};
  const validatorRejectionReasons: Record<string, string> = {};
  for (const field of new Set([...Object.keys(preValidationFields), ...Object.keys(postValidationFields)])) {
    const before = preValidationFields[field];
    const after = postValidationFields[field];
    if (!before) {
      validatorFieldStatus[field] = "not_seen";
      continue;
    }
    if (before.value != null && after?.value == null) {
      validatorFieldStatus[field] = "rejected";
      validatorRejectionReasons[field] =
        validated.errors.find((error) => error.field === field && error.receivedValue != null)?.message
        ?? "Value was present before validation but null after validation.";
      continue;
    }
    validatorFieldStatus[field] = after?.value != null ? "accepted" : "not_seen";
  }

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

  // Source-backed evidence counting. A field is "source-backed" if it has a
  // non-empty sourceText OR a sourcePage. Used to surface how much of the
  // extraction is grounded in real document evidence vs derived/inferred.
  const WEAK_TEXT_THRESHOLD = 800; // chars; below this triggers Vision fallback
  const isGenericSourceText = (text: unknown) => {
    const t = String(text || "").trim();
    if (!t) return true;
    if (/^(llm extracted|extracted|manual_review|unknown|n\/?a|null)$/i.test(t)) return true;
    if (/^[a-z][a-z0-9_]{2,40}$/.test(t)) return true; // bare identifier
    if (/derived from|calculated from|workflow placeholder/i.test(t)) return true;
    return false;
  };
  let fieldsReturnedCount = 0;
  let sourceBackedFieldsCount = 0;
  let fieldsWithoutSourceCount = 0;
  let rejectedGenericSourceCount = 0;
  for (const record of validated.records || []) {
    for (const field of Object.values(record.fields || {})) {
      if (field?.value == null || field.value === "") continue;
      fieldsReturnedCount += 1;
      const sourceText = (field as any).sourceText ?? (field as any).source_text ?? null;
      const sourcePage = (field as any).sourcePage ?? (field as any).source_page ?? null;
      if (isGenericSourceText(sourceText) && sourcePage == null) {
        fieldsWithoutSourceCount += 1;
        if (sourceText) rejectedGenericSourceCount += 1;
      } else {
        sourceBackedFieldsCount += 1;
      }
    }
  }

  const weakTextDetected = embeddedTextChars < WEAK_TEXT_THRESHOLD;
  // Vision fallback "triggered" means the LLM step ran in file mode. The
  // llm-extractor only switches to callVertexAIFileJSON when input.fileBase64
  // is truthy; if any LLM fields were produced under that condition we
  // count it as fired. (No flag bubbles back from llm-extractor today, so
  // this is the closest non-invasive observation.)
  const visionFallbackTriggered = fileBase64Available && llmFieldCount > 0;
  const visionFallbackSkippedReason = !fileBase64Available && weakTextDetected
    ? "file_bytes_not_provided"
    : (fileBase64Available && llmFieldCount === 0 && (weakTextDetected || shallowLeaseTextDetected))
      ? "llm_returned_zero_fields"
      : (!weakTextDetected && !shallowLeaseTextDetected ? "parser_text_sufficient" : null);

  // ── Stage 1: Vision-as-parser diagnostics ─────────────────────────────
  // The parser's extraction_method (set by parser.ts tag()) records which
  // backend produced the docling_raw payload. "gemini_vision" or "hybrid"
  // mean the PDF was read by Gemini Vision (Stage 1). This is distinct
  // from the Stage 2 fileBase64 LLM fallback above. Either may be true
  // independently — for example, a strong-text scan can be Vision-parsed
  // but never need the Stage 2 file-mode LLM fallback.
  const parserSource = String(rawDocling?.extraction_method || "").toLowerCase();
  const visionParserUsed = parserSource === "gemini_vision" || parserSource === "hybrid";
  // Best-effort page count from the parser output. Not all parsers fill
  // page_count, so fall back to the count of distinct block pages.
  const parserPageCount = (() => {
    const explicit = (rawDocling as any)?.page_count;
    if (typeof explicit === "number" && explicit > 0) return explicit;
    const blocks = Array.isArray((rawDocling as any)?.text_blocks)
      ? (rawDocling as any).text_blocks
      : [];
    const pages = new Set<number>();
    for (const b of blocks) {
      const p = b?.page ?? b?.page_number ?? b?.source_page;
      if (typeof p === "number" && p > 0) pages.add(p);
    }
    return pages.size || null;
  })();

  log.info(
    `Pipeline complete: ${flatRows.length} rows, method=${method}, ` +
    `confidence=${avgConfidence}%, time=${processingTimeMs}ms, ` +
    `rule=${ruleFieldCount}f / table=${tableFieldCount}f / llm=${llmFieldCount}f, ` +
    `text=${embeddedTextChars}ch weak=${weakTextDetected} ` +
    `fileBase64=${fileBase64Available} vision=${visionFallbackTriggered}, ` +
    `sourceBackedFields=${sourceBackedFieldsCount}/${fieldsReturnedCount}`,
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
      // Extraction diagnostics for normalize-pdf-output to forward into
      // uploaded_files.normalized_output.metadata and ultimately into
      // lease.extraction_data.extraction_debug.
      extractionDebug: {
        extraction_contract_version: "lease-review-evidence-v3",
        extraction_build_version: "2026-06-22.1",
        normalized_at: new Date().toISOString(),
        embedded_text_chars_total: embeddedTextChars,
        normalized_text_chars_total: embeddedTextChars,
        shallow_lease_text_detected: shallowLeaseTextDetected,
        shallow_lease_text_threshold: LEASE_SHALLOW_TEXT_THRESHOLD,
        llm_all_fields_due_to_shallow_text: shallowLeaseTextDetected,
        weak_text_detected: weakTextDetected,
        weak_text_threshold: WEAK_TEXT_THRESHOLD,
        fileBase64_available: fileBase64Available,
        fileMimeType: input.fileMimeType || null,
        vision_fallback_triggered: visionFallbackTriggered,
        vision_fallback_skipped_reason: visionFallbackSkippedReason,
        llm_file_mode_used: visionFallbackTriggered,
        // ── Split Vision diagnostics ─────────────────────────────────
        // Stage 1 (parser): did Gemini Vision read the document?
        vision_parser_used: visionParserUsed,
        vision_parser_source: parserSource || null,
        vision_parser_pages_count: parserPageCount,
        // Stage 2 (field extraction): did the LLM run in file mode to
        // pull structured fields directly from the PDF bytes?
        vision_field_extraction_attempted: fileBase64Available,
        vision_field_extraction_used: visionFallbackTriggered,
        vision_field_extraction_skipped_reason: visionFallbackTriggered
          ? null
          : (!fileBase64Available
            ? "file_bytes_unavailable"
            : (!weakTextDetected && !shallowLeaseTextDetected
              ? "parser_text_sufficient"
              : (llmFieldCount === 0 ? "llm_returned_zero_fields" : null))),
        vision_field_extraction_fields_count: llmFieldCount,
        fields_returned_count: fieldsReturnedCount,
        source_backed_fields_count: sourceBackedFieldsCount,
        fields_without_source_count: fieldsWithoutSourceCount,
        rejected_generic_source_count: rejectedGenericSourceCount,
        rule_fields_extracted: ruleFieldCount,
        table_fields_extracted: tableFieldCount,
        llm_fields_extracted: llmFieldCount,
        parsing_method: rawDocling.extraction_method || "text",
        processing_time_ms: processingTimeMs,
        // ── LLM call diagnostics (from extractWithLLM) ───────────────
        // All requested diagnostic fields come directly from the extractor's
        // accumulator so they reflect what actually happened inside the call.
        ...((llmResult as any).diagnostics ?? {}),
        // ── Validator rejection counts (computed here post-validate) ──
        // fields_rejected_by_validator_count = fields whose value was
        // non-null when they entered validateRecords but null came out.
        fields_rejected_by_validator_count: validated.errors.filter(
          (e) => e.receivedValue !== null && e.receivedValue !== undefined,
        ).length,
        validator_field_status: validatorFieldStatus,
        validator_rejection_reasons: validatorRejectionReasons,
        merged_field_sources: preValidationFields,
        validated_field_values: postValidationFields,
        rejected_fields_with_reasons: Object.entries(validatorRejectionReasons).map(([field, reason]) => ({
          field,
          reason,
          received_value: preValidationFields[field]?.value ?? null,
        })),
        first_rejection_reasons: validated.errors
          .filter((e) => e.receivedValue !== null && e.receivedValue !== undefined)
          .slice(0, 5)
          .map((e) => `${e.field}: ${e.message}`),
        // llm_fields_after_validation_count: LLM fields that survived the
        // validator (proxy: llmFieldCount minus validator-rejected that
        // originated from the LLM step — we can't split by source here
        // so expose the total llmFieldCount as "after merge" and let the
        // debug panel show the gap).
        llm_fields_after_validation_count: llmFieldCount,
      },
    },
  };
}

// @ts-nocheck
/**
 * Extraction Pipeline — Main Orchestrator
 *
 * Coordinates the 6-step hybrid extraction flow:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │  DoclingOutput                                              │
 *   │    │                                                        │
 *   │    ├─ Step 1: Rule-Based Extraction (regex / patterns)      │
 *   │    │    → deterministic, highest confidence                 │
 *   │    │                                                        │
 *   │    ├─ Step 2: Table-Based Extraction (Docling tables)       │
 *   │    │    → multi-row support, header mapping                 │
 *   │    │                                                        │
 *   │    ├─ Step 3: LLM Extraction (ONLY missing fields)          │
 *   │    │    → field-wise prompts, targeted chunks               │
 *   │    │                                                        │
 *   │    ├─ Step 4: Merge (rule > table > llm by confidence)      │
 *   │    │                                                        │
 *   │    ├─ Step 5: Validate (types, ranges, required fields)     │
 *   │    │                                                        │
 *   │    └─ Step 6: Calculate Derived Fields (deterministic)      │
 *   │         → annual_rent, lease_term, rent_per_sf              │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Input:  ExtractionInput (DoclingOutput + moduleType + options)
 * Output: ExtractionPipelineResult (rows + metadata + errors)
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

// ── Main pipeline ────────────────────────────────────────────────────────────

/**
 * Run the full hybrid extraction pipeline.
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

  // ── Normalize input ──────────────────────────────────────────────────────
  const docling: DoclingOutput = input.docling ?? rawTextToDocling(input.rawText ?? "");
  const moduleType: ModuleType = input.moduleType;

  const fullText = docling.full_text ?? docling.text_blocks.map((b) => b.text).join("\n");
  if (fullText.trim().length < 10) {
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

  // ── Step 1: Rule-Based Extraction ────────────────────────────────────────
  console.log(`[extraction-pipeline] Step 1: Rule-based extraction for ${moduleType}`);
  const ruleResult = extractRuleBased(docling, moduleType);
  allWarnings.push(...ruleResult.warnings);

  const ruleFieldCount = ruleResult.records.reduce(
    (sum, r) => sum + Object.keys(r.fields).length, 0,
  );
  console.log(`[extraction-pipeline] Step 1 complete: ${ruleFieldCount} fields from ${ruleResult.records.length} records`);

  // ── Step 2: Table-Based Extraction ───────────────────────────────────────
  console.log(`[extraction-pipeline] Step 2: Table-based extraction`);
  const tableResult = extractFromTables(docling.tables ?? [], moduleType);
  allWarnings.push(...tableResult.warnings);

  const tableFieldCount = tableResult.records.reduce(
    (sum, r) => sum + Object.keys(r.fields).length, 0,
  );
  console.log(`[extraction-pipeline] Step 2 complete: ${tableFieldCount} fields from ${tableResult.records.length} records`);

  // ── Step 3: LLM Extraction (only missing fields) ────────────────────────
  let llmResult = { records: [], warnings: [] as string[] };
  let llmFieldCount = 0;
  let chunksProcessed = 0;

  if (!skipLLM) {
    const missingFields = findMissingFields(ruleResult, tableResult, moduleType);
    console.log(`[extraction-pipeline] Step 3: LLM extraction for ${missingFields.length} missing fields: [${missingFields.join(", ")}]`);

    if (missingFields.length > 0) {
      // Merge existing records for context (so LLM knows how many rows to expect)
      const existingMerge = mergeResults(ruleResult, tableResult, { records: [], warnings: [] }, moduleType);

      llmResult = await extractWithLLM(
        docling,
        missingFields,
        moduleType,
        existingMerge.records,
        { maxChunks: maxLLMChunks, temperature: llmTemperature },
      );
      allWarnings.push(...llmResult.warnings);

      llmFieldCount = llmResult.records.reduce(
        (sum, r) => sum + Object.keys(r.fields).length, 0,
      );
    } else {
      console.log(`[extraction-pipeline] Step 3 skipped: all fields already extracted`);
    }
  } else {
    console.log(`[extraction-pipeline] Step 3 skipped: LLM disabled`);
    allWarnings.push("LLM extraction was skipped (disabled by options)");
  }
  console.log(`[extraction-pipeline] Step 3 complete: ${llmFieldCount} fields`);

  // ── Step 4: Merge Results ────────────────────────────────────────────────
  console.log(`[extraction-pipeline] Step 4: Merging results`);
  const merged = mergeResults(ruleResult, tableResult, llmResult, moduleType);
  allWarnings.push(...merged.warnings);
  console.log(`[extraction-pipeline] Step 4 complete: ${merged.records.length} merged records`);

  // ── Step 5: Validate ─────────────────────────────────────────────────────
  console.log(`[extraction-pipeline] Step 5: Validating`);
  const validated = validateRecords(merged.records, moduleType);
  console.log(`[extraction-pipeline] Step 5 complete: ${validated.errors.length} validation errors`);

  // ── Step 6: Calculate Derived Fields ─────────────────────────────────────
  console.log(`[extraction-pipeline] Step 6: Computing derived fields`);
  const flatRows = flattenRecords(validated.records, moduleType);
  computeDerivedFields(flatRows, moduleType);

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
  console.log(
    `[extraction-pipeline] Complete: ${flatRows.length} rows, method=${method}, ` +
    `confidence=${avgConfidence}%, time=${processingTimeMs}ms`,
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
      processingTimeMs,
    },
  };
}

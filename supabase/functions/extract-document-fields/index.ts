// @ts-nocheck
/**
 * extract-document-fields — Hybrid Extraction Edge Function (v2)
 *
 * Refactored extraction pipeline:
 *   Step 1: Rule-based extraction (regex / known patterns) — deterministic
 *   Step 2: Table-based extraction (from Docling tables) — deterministic
 *   Step 3: LLM extraction (Gemini) — ONLY for missing fields
 *   Step 4: Merge (rule > table > llm by confidence)
 *   Step 5: Validate (types, ranges, schema enforcement)
 *   Step 6: Calculate derived fields (deterministic code, never LLM)
 *
 * Architecture rules:
 *   - Docling is the ONLY parser — Gemini never re-parses raw documents
 *   - LLM extracts raw values only — no calculations, no totals
 *   - Fields extracted individually or in small groups
 *   - Strict JSON output, null for missing values
 *
 * Request:
 *   POST {
 *     moduleType: string,
 *     rawText?: string,              // backward compat — plain text
 *     doclingOutput?: DoclingOutput,  // preferred — structured Docling data
 *     fileName?: string,
 *     suggestCustomFields?: boolean,
 *     options?: ExtractionOptions
 *   }
 *
 * Response:
 *   {
 *     rows: object[],
 *     method: 'hybrid' | 'rule_only' | 'table_only' | 'llm_only' | 'fallback',
 *     warnings: string[],
 *     validationErrors: ValidationError[],
 *     metadata: { ... },
 *     customFieldSuggestions?: object[]
 *   }
 */

import { corsHeaders } from "../_shared/cors.ts";
import { runExtractionPipeline } from "../_shared/extraction/pipeline.ts";
import type { ExtractionInput, ExtractionOptions, ModuleType } from "../_shared/extraction/types.ts";

// ── Custom field suggestion analysis ─────────────────────────────────────────

function analyzeCustomFieldSuggestions(rows: Record<string, unknown>[]): Array<{
  field_name: string;
  field_label: string;
  field_type: string;
  sample_values: string[];
  confidence: number;
}> {
  const suggestions: Array<{
    field_name: string;
    field_label: string;
    field_type: string;
    sample_values: string[];
    confidence: number;
  }> = [];

  // Collect custom_fields from rows that LLM may have included
  const customFieldMap = new Map<string, string[]>();

  for (const row of rows) {
    if (row.custom_fields && typeof row.custom_fields === "object") {
      for (const [key, value] of Object.entries(row.custom_fields as Record<string, unknown>)) {
        if (!customFieldMap.has(key)) customFieldMap.set(key, []);
        customFieldMap.get(key)!.push(String(value));
      }
    }
  }

  for (const [fieldName, values] of customFieldMap.entries()) {
    const unique = [...new Set(values)];
    suggestions.push({
      field_name: fieldName,
      field_label: fieldName.replace(/_/g, " ").replace(/\b\w/g, (l) => l.toUpperCase()),
      field_type: inferSimpleType(unique),
      sample_values: unique.slice(0, 5),
      confidence: Math.min(95, 60 + values.length * 10),
    });
  }

  return suggestions;
}

function inferSimpleType(values: string[]): string {
  if (values.length === 0) return "text";
  const numCount = values.filter((v) => !isNaN(Number(v.replace(/[$,]/g, "")))).length;
  if (numCount / values.length > 0.8) return "number";
  const dateCount = values.filter((v) => /\d{4}-\d{2}-\d{2}/.test(v) || /\d{1,2}\/\d{1,2}\/\d{4}/.test(v)).length;
  if (dateCount / values.length > 0.6) return "date";
  const uniqueSet = new Set(values.map((v) => v.toLowerCase()));
  if (uniqueSet.size <= 10 && values.length > uniqueSet.size) return "select";
  return "text";
}

// ── Main HTTP handler ────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const respond = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body = await req.json().catch(() => ({}));
    const {
      moduleType = "property",
      rawText = "",
      fileBase64 = null,
      fileMimeType = null,
      doclingOutput,
      fileName = "document",
      suggestCustomFields = false,
      options = {},
    } = body;

    // ── Build extraction input ─────────────────────────────────────────────
    const input: ExtractionInput = {
      moduleType: moduleType as ModuleType,
      fileName,
      suggestCustomFields,
    };

    // Prefer structured DoclingOutput when available
    if (doclingOutput && typeof doclingOutput === "object") {
      input.docling = doclingOutput;
    } else {
      const hasRawText = rawText && typeof rawText === "string" && rawText.trim().length > 0;
      const hasFileBase64 = fileBase64 && typeof fileBase64 === "string";

      if (hasRawText) {
        input.rawText = rawText;
      }

      if (hasFileBase64) {
        input.fileBase64 = fileBase64;
        input.fileMimeType = fileMimeType || "application/pdf";
      }

      if (!hasRawText && !hasFileBase64) {
        return respond({
          error: "Either 'doclingOutput', 'rawText', or 'fileBase64' must be provided",
          rows: [],
        }, 400);
      }
    }

    const extractionOptions: ExtractionOptions = {
      maxLLMChunks: options.maxLLMChunks ?? 6,
      chunkSize: options.chunkSize ?? 1500,
      llmTemperature: options.llmTemperature ?? 0,
      skipLLM: options.skipLLM ?? false,
      confidenceThreshold: options.confidenceThreshold ?? 0.4,
    };

    console.log(
      `[extract-document-fields] ${moduleType} | "${fileName}" | ` +
      `docling=${!!doclingOutput} | rawText=${rawText.length} chars | fileBase64=${!!fileBase64} | ` +
      `suggestCustomFields=${suggestCustomFields}`,
    );

    // ── Run the pipeline ───────────────────────────────────────────────────
    const result = await runExtractionPipeline(input, extractionOptions);

    // ── Custom field suggestions ───────────────────────────────────────────
    let customFieldSuggestions = undefined;
    if (suggestCustomFields) {
      customFieldSuggestions = analyzeCustomFieldSuggestions(result.rows);
      if (customFieldSuggestions.length > 0) {
        console.log(`[extract-document-fields] ${customFieldSuggestions.length} custom field suggestions`);
      }
    }

    console.log(
      `[extract-document-fields] Complete: ${result.rows.length} rows, ` +
      `method=${result.method}, confidence=${result.metadata.avgConfidence}%, ` +
      `time=${result.metadata.processingTimeMs}ms`,
    );

    return respond({
      rows: result.rows,
      method: result.method,
      parsing_method: result.metadata.parsingMethod || "text",
      model: "gemini-1.5-pro-002",
      charCount: result.metadata.charCount || rawText.length || 0,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
      validationErrors: result.validationErrors.length > 0 ? result.validationErrors : undefined,
      customFieldSuggestions: customFieldSuggestions?.length ? customFieldSuggestions : undefined,
      metadata: result.metadata,
      extraction_summary: {
        total_rows: result.metadata.totalRecords,
        avg_confidence: result.metadata.avgConfidence,
        rule_fields: result.metadata.ruleFieldsExtracted,
        table_fields: result.metadata.tableFieldsExtracted,
        llm_fields: result.metadata.llmFieldsExtracted,
        has_custom_fields: (customFieldSuggestions?.length ?? 0) > 0,
        processing_time_ms: result.metadata.processingTimeMs,
      },
    });
  } catch (err) {
    console.error("[extract-document-fields] Unexpected error:", err?.message ?? err, err?.stack);
    return respond(
      {
        error: `Extraction failed: ${String(err?.message ?? err)}`,
        rows: [],
        method: "error",
      },
      500,
    );
  }
});

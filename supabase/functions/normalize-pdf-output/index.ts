// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { normalizeExtractedData } from "../_shared/normalizer.ts";
import { callVertexAIJSON } from "../_shared/vertex-ai.ts";
import { parseLeases } from "../_shared/parsers/lease-parser.ts";
import { parseExpenses } from "../_shared/parsers/expense-parser.ts";
import { parseProperties } from "../_shared/parsers/property-parser.ts";
import { parseRevenues } from "../_shared/parsers/revenue-parser.ts";
import type { ModuleType } from "../_shared/file-detector.ts";

/**
 * normalize-pdf-output — Step 3 of PDF ingestion
 *
 * Reads the raw Docling output stored in uploaded_files.docling_raw,
 * normalizes it into canonical rows, runs it through the existing module
 * parser, then writes parsed_data and sets status = 'parsed'.
 *
 * If VERTEX_PROJECT_ID is set and the Docling output is sparse (< 2 rows),
 * Vertex AI (Gemini) is used as a fallback to extract structured fields from the full text.
 *
 * Flow:
 *   parse-pdf-docling (status=pdf_parsed)
 *     → [this function]
 *     → status=parsed, parsed_data populated
 *     → validate-data (unchanged)
 *     → store-data (unchanged)
 *     → compute engines (unchanged)
 */

// ---------------------------------------------------------------------------
// Module parser dispatch
// ---------------------------------------------------------------------------

function applyModuleParser(
  rows: Array<Record<string, string | null>>,
  moduleType: ModuleType,
): { rows: unknown[]; errors: unknown[] } {
  switch (moduleType) {
    case "leases":
      return parseLeases(rows);
    case "expenses":
    case "cam":
      return parseExpenses(rows);
    case "properties":
      return parseProperties(rows);
    case "revenue":
    case "budgets":
      return parseRevenues(rows);
    default:
      return { rows, errors: [] };
  }
}

// ---------------------------------------------------------------------------
// Vertex AI extraction — converts full document text into canonical rows
// ---------------------------------------------------------------------------

const MODULE_PROMPTS: Record<string, string> = {
  leases: `Extract all lease records from the document. Return a JSON array where each element is one lease with these fields:
tenant_name, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), monthly_rent (number), square_footage (number),
lease_type (triple_net|gross|modified_gross), escalation_type (fixed|cpi|none), escalation_rate (number, e.g. 3 for 3%),
property_id (null if not found), unit_id (null if not found).
Set missing fields to null. Return ONLY a JSON array, no explanation.`,

  expenses: `Extract all expense records from the document. Return a JSON array where each element is one expense with these fields:
category, amount (number), date (YYYY-MM-DD), vendor, classification (recoverable|non_recoverable|conditional),
gl_code, fiscal_year (number), month (number 1-12), property_id (null if not found).
Set missing fields to null. Return ONLY a JSON array, no explanation.`,

  properties: `Extract all property records from the document. Return a JSON array where each element is one property with these fields:
name, address, city, state, zip_code, square_footage (number), property_type, year_built (number), number_of_units (number).
Set missing fields to null. Return ONLY a JSON array, no explanation.`,

  revenue: `Extract all revenue records from the document. Return a JSON array where each element is one revenue entry with these fields:
revenue_type, amount (number), period (YYYY-MM-DD), property_id (null if not found), lease_id (null if not found),
fiscal_year (number), month (number 1-12), notes.
Set missing fields to null. Return ONLY a JSON array, no explanation.`,
};

async function extractWithVertexAI(
  fullText: string,
  moduleType: ModuleType,
): Promise<Array<Record<string, unknown>>> {
  const modulePrompt = MODULE_PROMPTS[moduleType] ?? MODULE_PROMPTS.leases;

  const result = await callVertexAIJSON<Array<Record<string, unknown>>>({
    systemPrompt: "You are a commercial real estate data extraction specialist. Extract structured data from document text accurately. Return only valid JSON arrays.",
    userPrompt: `${modulePrompt}\n\nDOCUMENT TEXT:\n---\n${fullText.slice(0, 10000)}\n---`,
    maxOutputTokens: 2048,
    temperature: 0,
  });

  if (!Array.isArray(result)) {
    if (result && typeof result === "object") return [result as Record<string, unknown>];
    return [];
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    const body = await req.json();
    const { file_id } = body;

    if (!file_id) {
      return new Response(
        JSON.stringify({ error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Fetch file record (org_id isolation)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, module_type, status, docling_raw")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return new Response(
        JSON.stringify({
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id"}`,
          error_code: "FILE_NOT_FOUND",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Must be in pdf_parsed state
    if (fileRecord.status !== "pdf_parsed") {
      return new Response(
        JSON.stringify({
          error: true,
          message: `File status must be 'pdf_parsed'. Current: '${fileRecord.status}'`,
          error_code: "INVALID_STATUS",
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!fileRecord.docling_raw) {
      return new Response(
        JSON.stringify({
          error: true,
          message: "No Docling output found. Run parse-pdf-docling first.",
          error_code: "NO_DOCLING_OUTPUT",
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const moduleType = (fileRecord.module_type ?? "unknown") as ModuleType;

    // Update status to 'parsing' while we work
    await supabaseAdmin
      .from("uploaded_files")
      .update({ status: "parsing", updated_at: new Date().toISOString() })
      .eq("id", file_id);

    try {
      // Step 1: Normalize Docling output → canonical rows
      const normResult = normalizeExtractedData(
        { doclingOutput: fileRecord.docling_raw },
        moduleType,
      );

      // Step 1b: Vertex AI fallback — if Docling produced sparse results and
      // VERTEX_PROJECT_ID + GOOGLE_SERVICE_ACCOUNT_KEY are available, use Gemini to extract from full_text
      let finalRows = normResult.rows;
      let normSource = normResult.source;
      const warnings = [...normResult.warnings];

      if (normResult.rowCount < 2 && Deno.env.get("VERTEX_PROJECT_ID") && Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY")) {
        const fullText = fileRecord.docling_raw?.full_text ?? "";
        if (fullText.length > 100) {
          console.log(`[normalize-pdf-output] Docling sparse (${normResult.rowCount} rows) — trying Vertex AI`);
          try {
            const vertexRows = await extractWithVertexAI(fullText, moduleType);
            if (vertexRows && vertexRows.length > 0) {
              finalRows = vertexRows;
              normSource = "vertex_ai";
              warnings.push("Vertex AI (Gemini) used for extraction (Docling output was sparse)");
              console.log(`[normalize-pdf-output] Vertex AI extracted ${vertexRows.length} rows`);
            }
          } catch (vertexErr) {
            warnings.push(`Vertex AI extraction failed: ${vertexErr.message}`);
            console.error("[normalize-pdf-output] Vertex AI error:", vertexErr.message);
          }
        }
      }

      if (finalRows.length === 0) {
        throw new Error(
          `Normalization produced 0 rows. Warnings: ${warnings.join("; ")}`,
        );
      }

      // Step 2: Run through the existing module parser
      // (handles date normalization, currency stripping, column mapping)
      const parseResult = applyModuleParser(finalRows, moduleType);

      // Step 3: Write parsed_data and set status = 'parsed'
      // From here the file is identical to a parsed CSV — same pipeline continues.
      const { error: updateError } = await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "parsed",
          parsed_data: parseResult.rows,
          row_count: parseResult.rows.length,
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      if (updateError) {
        throw new Error(`Failed to save parsed data: ${updateError.message}`);
      }

      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          processing_status: "parsed",
          module_type: moduleType,
          normalization_source: normSource,
          row_count: parseResult.rows.length,
          warnings,
          parser_errors: parseResult.errors,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );

    } catch (normError) {
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "failed",
          error_message: normError.message,
          processing_completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      throw normError;
    }

  } catch (err) {
    console.error("[normalize-pdf-output] Error:", err.message);
    return new Response(
      JSON.stringify({
        error: true,
        message: err.message,
        error_code: "NORMALIZATION_FAILED",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

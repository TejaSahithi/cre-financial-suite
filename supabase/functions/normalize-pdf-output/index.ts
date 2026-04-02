// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { normalizeExtractedData } from "../_shared/normalizer.ts";
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
 * After this function completes, the file is in the same state as a
 * successfully parsed CSV — ready for validate-data → store-data → compute.
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
      // Unknown module — return rows as-is, let validation catch issues
      return { rows, errors: [] };
  }
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

      if (normResult.rowCount === 0) {
        throw new Error(
          `Normalization produced 0 rows. Warnings: ${normResult.warnings.join("; ")}`,
        );
      }

      // Step 2: Run through the existing module parser
      // (handles date normalization, currency stripping, column mapping)
      const parseResult = applyModuleParser(normResult.rows, moduleType);

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
          normalization_source: normResult.source,
          row_count: parseResult.rows.length,
          warnings: normResult.warnings,
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

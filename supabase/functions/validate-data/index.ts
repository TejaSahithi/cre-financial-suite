// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { setStatus, setFailed, STATUS_PROGRESS } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";

/**
 * Validate Data Edge Function
 * Validates parsed JSON against schema, returns errors or marks valid
 * Pipeline: Upload → Parse → **Validate** → Store → Compute → Export
 *
 * Requirements: 3.1, 3.2, 3.4, 3.5, 3.6, 3.7, 3.8, 15.2
 * Task: 5.1
 */

// ---------------------------------------------------------------------------
// Schema definitions: required fields per module_type
// ---------------------------------------------------------------------------
const REQUIRED_FIELDS: Record<string, string[]> = {
  leases: ["tenant_name", "start_date", "end_date", "monthly_rent"],
  expenses: ["category", "amount", "date"],
  properties: ["name"],
  revenue: ["revenue_type", "amount"],
};

// Fields that must be valid dates
const DATE_FIELDS: Record<string, string[]> = {
  leases: ["start_date", "end_date"],
  expenses: ["date"],
  properties: [],
  revenue: [],
};

// Fields that must be numeric
const NUMERIC_FIELDS: Record<string, string[]> = {
  leases: ["monthly_rent", "square_footage"],
  expenses: ["amount"],
  properties: ["square_footage"],
  revenue: ["amount"],
};

// Fields that must be non-empty strings (beyond required check)
const STRING_FIELDS: Record<string, string[]> = {
  leases: ["tenant_name"],
  expenses: ["category"],
  properties: ["name"],
  revenue: ["revenue_type"],
};

// ---------------------------------------------------------------------------
// Validation error interface
// ---------------------------------------------------------------------------
interface ValidationError {
  row: number;
  field: string;
  message: string;
  type: "required" | "type" | "format" | "referential";
}

// ---------------------------------------------------------------------------
// Normalisation helpers
// ---------------------------------------------------------------------------

/** ISO 8601 date pattern: YYYY-MM-DD */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** US-style date patterns: MM/DD/YYYY or M/D/YYYY */
const US_DATE_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * Attempt to normalise a value to ISO 8601 date (YYYY-MM-DD).
 * Returns the normalised string, or null if the value cannot be parsed.
 */
function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "") return null;

  // Already ISO 8601
  if (ISO_DATE_RE.test(str)) {
    // Quick sanity: ensure the date itself is valid
    const d = new Date(str + "T00:00:00Z");
    return isNaN(d.getTime()) ? null : str;
  }

  // US-style MM/DD/YYYY or M/D/YYYY
  const usMatch = str.match(US_DATE_RE);
  if (usMatch) {
    const month = usMatch[1].padStart(2, "0");
    const day = usMatch[2].padStart(2, "0");
    const year = usMatch[3];
    const iso = `${year}-${month}-${day}`;
    const d = new Date(iso + "T00:00:00Z");
    return isNaN(d.getTime()) ? null : iso;
  }

  return null;
}

/**
 * Normalise a currency / numeric value.
 * Strips currency symbols ($, €, £), commas, and spaces then converts to number.
 * Returns the number, or null if conversion fails.
 */
function normalizeCurrency(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  // Already a number
  if (typeof value === "number") return isNaN(value) ? null : value;

  const str = String(value).trim();
  if (str === "") return null;

  // Strip currency symbols, commas, spaces
  const cleaned = str.replace(/[$€£,\s]/g, "");

  // Handle parentheses for negative amounts e.g. (100.00)
  const negMatch = cleaned.match(/^\((.+)\)$/);
  const numStr = negMatch ? `-${negMatch[1]}` : cleaned;

  const num = Number(numStr);
  return isNaN(num) ? null : num;
}

/**
 * Check whether a value is considered "present" (non-null, non-empty string after trim).
 */
function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string" && value.trim() === "") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Row validator
// ---------------------------------------------------------------------------

interface RowValidationResult {
  valid: boolean;
  errors: ValidationError[];
  normalizedRow: Record<string, unknown>;
}

function validateRow(
  row: Record<string, unknown>,
  rowIndex: number,
  moduleType: string,
): RowValidationResult {
  const errors: ValidationError[] = [];
  const normalizedRow = { ...row };

  const requiredFields = REQUIRED_FIELDS[moduleType] || [];
  const dateFields = DATE_FIELDS[moduleType] || [];
  const numericFields = NUMERIC_FIELDS[moduleType] || [];
  const stringFields = STRING_FIELDS[moduleType] || [];

  // 1. Required field validation
  for (const field of requiredFields) {
    if (!isPresent(row[field])) {
      errors.push({
        row: rowIndex,
        field,
        message: "Required field is missing",
        type: "required",
      });
    }
  }

  // 2. Date validation & normalisation
  for (const field of dateFields) {
    const value = row[field];
    if (!isPresent(value)) continue; // already caught by required check if applicable

    const normalized = normalizeDate(value);
    if (normalized === null) {
      errors.push({
        row: rowIndex,
        field,
        message: "Invalid date format. Expected YYYY-MM-DD or MM/DD/YYYY",
        type: "format",
      });
    } else {
      normalizedRow[field] = normalized;
    }
  }

  // 3. Numeric / currency validation & normalisation
  for (const field of numericFields) {
    const value = row[field];
    if (!isPresent(value)) continue; // already caught by required check if applicable

    const normalized = normalizeCurrency(value);
    if (normalized === null) {
      errors.push({
        row: rowIndex,
        field,
        message: "Invalid numeric value",
        type: "type",
      });
    } else {
      normalizedRow[field] = normalized;
    }
  }

  // 4. String validation (non-empty after trim)
  for (const field of stringFields) {
    const value = row[field];
    if (!isPresent(value)) continue; // already caught by required check if applicable

    if (typeof value === "string" && value.trim() === "") {
      errors.push({
        row: rowIndex,
        field,
        message: "Field must be a non-empty string",
        type: "type",
      });
    } else if (typeof value === "string") {
      normalizedRow[field] = value.trim();
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    normalizedRow,
  };
}

// ---------------------------------------------------------------------------
// Referential integrity check for property_id
// ---------------------------------------------------------------------------

async function checkPropertyReferences(
  rows: Record<string, unknown>[],
  rowIndices: number[],
  orgId: string,
  supabaseAdmin: any,
): Promise<ValidationError[]> {
  const errors: ValidationError[] = [];

  // Collect unique property_ids that need checking
  const propertyIdMap = new Map<string, number[]>(); // property_id -> list of row indices
  for (let i = 0; i < rows.length; i++) {
    const propertyId = rows[i].property_id;
    if (isPresent(propertyId)) {
      const pid = String(propertyId).trim();
      if (!propertyIdMap.has(pid)) {
        propertyIdMap.set(pid, []);
      }
      propertyIdMap.get(pid)!.push(rowIndices[i]);
    }
  }

  if (propertyIdMap.size === 0) return errors;

  // Query properties table for all referenced IDs at once
  const propertyIds = Array.from(propertyIdMap.keys());
  const { data: existingProperties, error } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("org_id", orgId)
    .in("id", propertyIds);

  if (error) {
    console.error("[validate-data] Property lookup error:", error.message);
    // Don't fail the whole validation; just skip referential checks
    return errors;
  }

  const existingIds = new Set(
    (existingProperties || []).map((p: { id: string }) => p.id),
  );

  // Flag rows whose property_id doesn't exist
  for (const [pid, rowIdxList] of propertyIdMap.entries()) {
    if (!existingIds.has(pid)) {
      for (const rowIdx of rowIdxList) {
        errors.push({
          row: rowIdx,
          field: "property_id",
          message: `Referenced property '${pid}' does not exist`,
          type: "referential",
        });
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Authenticate
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    // Parse request body
    const body = await req.json();
    const { file_id } = body;

    if (!file_id) {
      throw new Error("file_id is required");
    }

    // Fetch the uploaded_files record (scoped to org)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("*")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      throw new Error(
        `File not found: ${fetchError?.message || "Invalid file_id"}`,
      );
    }

    const moduleType: string = fileRecord.module_type;
    if (!REQUIRED_FIELDS[moduleType]) {
      throw new Error(`Unsupported module_type: ${moduleType}`);
    }

    // Update status to 'validating'
    await setStatus(supabaseAdmin, file_id, "validating", {
      processing_started_at: new Date().toISOString(),
    });

    const log = createLogger(supabaseAdmin, file_id, orgId);
    await log.info("validate", `Validating ${fileRecord.row_count ?? 0} rows for module: ${fileRecord.module_type}`);

    try {
      // Read parsed data
      const parsedData: Record<string, unknown>[] = fileRecord.parsed_data || [];

      if (parsedData.length === 0) {
        throw new Error("No parsed data found for this file");
      }

      // -----------------------------------------------------------------------
      // Phase 1: Per-row field validation (required, type, format)
      // -----------------------------------------------------------------------
      const allErrors: ValidationError[] = [];
      const validRows: Record<string, unknown>[] = [];
      const validRowOriginalIndices: number[] = [];
      const rowErrorMap = new Map<number, boolean>(); // rowIndex -> has errors?

      for (let i = 0; i < parsedData.length; i++) {
        const rowNumber = i + 2; // Row 1 is header; data starts at row 2
        const result = validateRow(parsedData[i], rowNumber, moduleType);
        allErrors.push(...result.errors);

        if (result.valid) {
          validRows.push(result.normalizedRow);
          validRowOriginalIndices.push(i);
          rowErrorMap.set(i, false);
        } else {
          rowErrorMap.set(i, true);
        }
      }

      // -----------------------------------------------------------------------
      // Phase 2: Referential integrity (property_id) on valid rows only
      // -----------------------------------------------------------------------
      const refErrors = await checkPropertyReferences(
        validRows,
        validRowOriginalIndices.map((idx) => idx + 2), // convert to row numbers
        orgId,
        supabaseAdmin,
      );

      if (refErrors.length > 0) {
        allErrors.push(...refErrors);

        // Remove rows that failed referential integrity from validRows
        const failedRefRows = new Set(refErrors.map((e) => e.row));
        const finalValidRows: Record<string, unknown>[] = [];
        for (let i = 0; i < validRows.length; i++) {
          const rowNumber = validRowOriginalIndices[i] + 2;
          if (!failedRefRows.has(rowNumber)) {
            finalValidRows.push(validRows[i]);
          }
        }
        validRows.length = 0;
        validRows.push(...finalValidRows);
      }

      // -----------------------------------------------------------------------
      // Determine final status
      // -----------------------------------------------------------------------
      const validCount = validRows.length;
      const errorCount = allErrors.length;
      // 'validated' if at least one row is valid; 'failed' if ALL rows fail
      const finalStatus = validCount > 0 ? "validated" : "failed";

      // -----------------------------------------------------------------------
      // Persist results
      // -----------------------------------------------------------------------
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          valid_data: validRows,
          validation_errors: allErrors,
          valid_count: validCount,
          error_count: errorCount,
          error_message: finalStatus === "failed" ? "All rows failed validation" : null,
        })
        .eq("id", file_id);

      if (finalStatus === "failed") {
        await log.error("validate", "All rows failed validation", { error_count: errorCount });
        await setFailed(supabaseAdmin, file_id, "All rows failed validation", "validating", STATUS_PROGRESS.validating);
      } else {
        await log.info("validate", `Validation complete: ${validCount} valid, ${errorCount} errors`, { valid_count: validCount, error_count: errorCount });
        await setStatus(supabaseAdmin, file_id, "validated", {
          processing_completed_at: new Date().toISOString(),
        });
      }

      return new Response(
        JSON.stringify({
          error: false,
          file_id,
          processing_status: finalStatus,
          valid_count: validCount,
          error_count: errorCount,
          validation_errors: allErrors,
        }),
        {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    } catch (validationError) {
      await log.error("validate", validationError.message);
      await setFailed(supabaseAdmin, file_id, validationError.message, "validating", STATUS_PROGRESS.validating);
      throw validationError;
    }
  } catch (err) {
    console.error("[validate-data] Error:", err.message);
    return new Response(
      JSON.stringify({
        error: true,
        message: err.message,
        error_code: "VALIDATION_FAILED",
      }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

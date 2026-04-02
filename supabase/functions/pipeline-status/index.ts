// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";

/**
 * Pipeline Status Tracking Edge Function
 * Query pipeline processing status for uploaded files.
 * Supports single file lookup by file_id and listing all files for an org.
 *
 * Methods: GET (query params) or POST (JSON body)
 */

// ---------------------------------------------------------------------------
// Progress percentage mapping based on pipeline status
// ---------------------------------------------------------------------------
const STATUS_PROGRESS: Record<string, number> = {
  uploaded: 10,
  parsing: 30,
  parsed: 40,
  pdf_parsed: 45,   // PDF extraction done, normalisation pending
  validating: 50,
  validated: 60,
  storing: 80,
  stored: 90,
  processed: 100,
};

/**
 * Calculate progress_percentage for a file record.
 * For "failed" status, the progress stays at whatever stage it reached before
 * failing. For known statuses, return the mapped value. Default to 0.
 */
function getProgressPercentage(record: Record<string, any>): number {
  const status: string = record.status;

  if (status === "failed") {
    // Use progress_percentage already stored on the record if available,
    // otherwise fall back to 0.
    return typeof record.progress_percentage === "number"
      ? record.progress_percentage
      : 0;
  }

  return STATUS_PROGRESS[status] ?? 0;
}

/**
 * Shape a raw uploaded_files row into the response payload.
 */
function formatFileRecord(record: Record<string, any>) {
  return {
    file_id: record.id,
    file_name: record.file_name,
    module_type: record.module_type,
    status: record.status,
    progress_percentage: getProgressPercentage(record),
    row_count: record.row_count ?? null,
    valid_count: record.valid_count ?? null,
    error_count: record.error_count ?? null,
    error_message: record.error_message ?? null,
    created_at: record.created_at,
    updated_at: record.updated_at,
    processing_started_at: record.processing_started_at ?? null,
    processing_completed_at: record.processing_completed_at ?? null,
  };
}

// ---------------------------------------------------------------------------
// Select columns — only fetch what we need
// ---------------------------------------------------------------------------
const SELECT_COLUMNS = [
  "id",
  "file_name",
  "module_type",
  "status",
  "progress_percentage",
  "error_message",
  "row_count",
  "valid_count",
  "error_count",
  "created_at",
  "updated_at",
  "processing_started_at",
  "processing_completed_at",
].join(",");

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // Authenticate
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    // -----------------------------------------------------------------------
    // Extract parameters from GET query string or POST JSON body
    // -----------------------------------------------------------------------
    let fileId: string | null = null;
    let offset = 0;
    let limit = 50;

    if (req.method === "GET") {
      const url = new URL(req.url);
      fileId = url.searchParams.get("file_id") || null;
      offset = parseInt(url.searchParams.get("offset") || "0", 10) || 0;
      limit = parseInt(url.searchParams.get("limit") || "50", 10) || 50;
    } else {
      // POST (or any other method) — read JSON body
      try {
        const body = await req.json();
        fileId = body.file_id || null;
        offset = typeof body.offset === "number" ? body.offset : 0;
        limit = typeof body.limit === "number" ? body.limit : 50;
      } catch {
        // Empty body is fine — treat as "list all"
      }
    }

    // Clamp limit to a reasonable maximum
    if (limit > 100) limit = 100;
    if (limit < 1) limit = 1;
    if (offset < 0) offset = 0;

    // -----------------------------------------------------------------------
    // Single file lookup
    // -----------------------------------------------------------------------
    if (fileId) {
      const { data: fileRecord, error: fetchError } = await supabaseAdmin
        .from("uploaded_files")
        .select(SELECT_COLUMNS)
        .eq("id", fileId)
        .eq("org_id", orgId)
        .single();

      if (fetchError || !fileRecord) {
        return new Response(
          JSON.stringify({
            error: true,
            message: `File not found: ${fetchError?.message || "Invalid file_id"}`,
          }),
          {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          },
        );
      }

      return new Response(
        JSON.stringify({
          error: false,
          ...formatFileRecord(fileRecord),
        }),
        {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // -----------------------------------------------------------------------
    // List all files for the organisation (paginated)
    // -----------------------------------------------------------------------

    // First, get total count
    const { count: totalCount, error: countError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);

    if (countError) {
      throw new Error(`Failed to count files: ${countError.message}`);
    }

    // Fetch the page of records
    const { data: files, error: listError } = await supabaseAdmin
      .from("uploaded_files")
      .select(SELECT_COLUMNS)
      .eq("org_id", orgId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (listError) {
      throw new Error(`Failed to list files: ${listError.message}`);
    }

    return new Response(
      JSON.stringify({
        error: false,
        files: (files || []).map(formatFileRecord),
        total: totalCount ?? 0,
        offset,
        limit,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("[pipeline-status] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});

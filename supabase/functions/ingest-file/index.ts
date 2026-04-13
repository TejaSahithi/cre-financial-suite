// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { detectFileType, type DetectionResult, type FileFormat, type ModuleType } from "../_shared/file-detector.ts";

/**
 * ingest-file — Unified File Ingestion Router
 *
 * This is the single entry point for ALL file formats (CSV, Excel, PDF, text).
 * It replaces the need to call parse-file or parse-pdf-docling directly.
 *
 * Flow:
 *   1. Accept { file_id, module_type? }
 *   2. Fetch the file record + download first bytes from storage
 *   3. Detect file format + module type (using file-detector)
 *   4. Route to the correct extraction function:
 *        csv / xls / xlsx / text  →  parse-file  (existing CSV pipeline)
 *        pdf                      →  parse-pdf-docling  (Docling OCR)
 *        unknown                  →  attempt text fallback, else fail
 *   5. Return detection result + routing decision to caller
 *
 * The downstream functions (parse-file, parse-pdf-docling) handle their own
 * status updates. This function only does detection + routing.
 *
 * RULES:
 *   - Does NOT modify compute engines
 *   - Does NOT bypass validation
 *   - Does NOT insert raw data into DB tables
 *   - All formats converge into the same validate-data → store-data pipeline
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Enhanced Edge Function caller with retry logic and better error handling */
async function callEdgeFunction(
  supabaseUrl: string,
  functionName: string,
  body: Record<string, unknown>,
  authToken: string,
  retries = 3,
): Promise<{ ok: boolean; status: number; data: unknown; error?: string }> {
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`[ingest-file] Calling ${functionName} (attempt ${attempt}/${retries})`);
      
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${authToken}`,
          "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000), // 30 second timeout
      });
      
      const data = await res.json().catch(() => ({}));
      
      if (res.ok) {
        console.log(`[ingest-file] ${functionName} succeeded on attempt ${attempt}`);
        return { ok: true, status: res.status, data };
      }
      
      // If it's a client error (4xx), don't retry
      if (res.status >= 400 && res.status < 500) {
        console.log(`[ingest-file] ${functionName} failed with client error ${res.status}, not retrying`);
        return { ok: false, status: res.status, data, error: `Client error: ${res.status}` };
      }
      
      // Server error (5xx) - retry with exponential backoff
      if (attempt < retries) {
        const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        console.log(`[ingest-file] ${functionName} failed with ${res.status}, retrying in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      return { ok: false, status: res.status, data, error: `Server error after ${retries} attempts` };
      
    } catch (err) {
      console.error(`[ingest-file] ${functionName} attempt ${attempt} failed:`, err.message);
      
      if (attempt < retries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        console.log(`[ingest-file] Retrying ${functionName} in ${delay}ms`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      return { 
        ok: false, 
        status: 500, 
        data: {}, 
        error: `Network error after ${retries} attempts: ${err.message}` 
      };
    }
  }
  
  return { ok: false, status: 500, data: {}, error: "Unexpected retry loop exit" };
}

/** Download the first N bytes of a file from storage for magic-byte detection */
async function downloadFilePreview(
  supabaseAdmin: any,
  storagePath: string,
  maxBytes = 8,
): Promise<Uint8Array> {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from("financial-uploads")
      .download(storagePath);
    if (error || !data) return new Uint8Array(0);
    const buf = await data.arrayBuffer();
    return new Uint8Array(buf.slice(0, maxBytes));
  } catch {
    return new Uint8Array(0);
  }
}

/** Download a small text preview (first 2KB) for content-keyword detection */
async function downloadTextPreview(
  supabaseAdmin: any,
  storagePath: string,
): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from("financial-uploads")
      .download(storagePath);
    if (error || !data) return "";
    const buf = await data.arrayBuffer();
    const bytes = new Uint8Array(buf.slice(0, 2048));
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

type RoutingDecision =
  | { route: "parse-file"; reason: string }
  | { route: "parse-pdf-docling"; reason: string }
  | { route: "unsupported"; reason: string };

/** Enhanced routing decision with better format support */
function decideRoute(detection: DetectionResult): RoutingDecision {
  const { fileFormat } = detection;

  switch (fileFormat) {
    case "csv":
    case "text":
      // Pure text/CSV — fast path through existing CSV parser
      return { route: "parse-file", reason: `${fileFormat} file → CSV parser` };

    case "xls":
    case "xlsx":
      // Excel — route through Docling which handles binary Excel natively
      return { route: "parse-pdf-docling", reason: `${fileFormat} file → Docling (handles Excel binary format)` };

    case "pdf":
      return { route: "parse-pdf-docling", reason: "PDF → Docling OCR extraction" };

    case "docx":
    case "doc":
      return { route: "parse-pdf-docling", reason: `${fileFormat} Word document → Docling extraction` };

    case "image":
      return { route: "parse-pdf-docling", reason: "Image → Docling OCR extraction" };

    case "unknown":
    default:
      // Enhanced unknown format handling - try Docling first with better error handling
      return { route: "parse-pdf-docling", reason: "Unknown format → Docling (multi-format extraction with fallback)" };
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
    // 1. Auth
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin);

    // 2. Parse request
    const body = await req.json();
    const { file_id, module_type: explicitModuleType } = body;

    if (!file_id) {
      return new Response(
        JSON.stringify({ error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Fetch file record (org_id isolation)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, file_name, file_url, mime_type, module_type, status")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return new Response(
        JSON.stringify({
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id or org mismatch"}`,
          error_code: "FILE_NOT_FOUND",
        }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 4. Derive storage path from file_url
    const storagePath = fileRecord.file_url.replace(
      /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
      "",
    );

    // 5. Download file preview for detection
    const [fileBytes, contentPreview] = await Promise.all([
      downloadFilePreview(supabaseAdmin, storagePath, 8),
      downloadTextPreview(supabaseAdmin, storagePath),
    ]);

    // 6. Detect file format + module type
    const detection = detectFileType({
      mimeType: fileRecord.mime_type ?? "",
      fileName: fileRecord.file_name ?? "",
      explicitModuleType: explicitModuleType ?? fileRecord.module_type ?? undefined,
      fileBytes,
      contentPreview,
    });

    // 7. If module_type was detected and differs from what's stored, update it
    if (
      detection.moduleType !== "unknown" &&
      detection.moduleType !== fileRecord.module_type &&
      detection.moduleSource !== "fallback"
    ) {
      await supabaseAdmin
        .from("uploaded_files")
        .update({ module_type: detection.moduleType, updated_at: new Date().toISOString() })
        .eq("id", file_id);
    }

    // 8. Decide routing with enhanced error handling
    const routing = decideRoute(detection);

    // Enhanced status tracking - update file status to processing
    await supabaseAdmin
      .from("uploaded_files")
      .update({
        status: "processing",
        updated_at: new Date().toISOString(),
      })
      .eq("id", file_id);

    if (routing.route === "unsupported") {
      // Mark as failed with detailed error information
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "failed",
          error_message: `Unsupported file format: ${detection.fileFormat}. Supported formats: PDF, DOC, DOCX, XLS, XLSX, CSV, TXT, Images (JPG, PNG, TIFF, etc.)`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      return new Response(
        JSON.stringify({
          error: true,
          message: `Unsupported file format: ${detection.fileFormat}`,
          error_code: "UNSUPPORTED_FORMAT",
          supported_formats: ["pdf", "doc", "docx", "xls", "xlsx", "csv", "txt", "jpg", "png", "tiff"],
          detection,
        }),
        { status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 9. Call the appropriate downstream function(s)
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    console.log(
      `[ingest-file] Routing file_id=${file_id} (${detection.fileFormat}/${detection.moduleType}) → ${routing.route}`,
    );

    const detectionSummary = {
      file_format: detection.fileFormat,
      module_type: detection.moduleType,
      format_source: detection.formatSource,
      module_source: detection.moduleSource,
      confidence: detection.confidence,
    };

    // PDF and document processing: enhanced two-step with better error handling
    if (routing.route === "parse-pdf-docling") {
      console.log(`[ingest-file] Starting PDF/document processing for ${detection.fileFormat} file`);
      
      // Step 1: Docling extraction with enhanced error handling
      const doclingResult = await callEdgeFunction(supabaseUrl, "parse-pdf-docling", { file_id }, serviceKey);
      
      if (!doclingResult.ok) {
        console.error(`[ingest-file] Docling extraction failed:`, doclingResult.error);
        
        // Update file status with detailed error
        await supabaseAdmin
          .from("uploaded_files")
          .update({
            status: "failed",
            error_message: `Document extraction failed: ${doclingResult.error || 'Unknown error'}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", file_id);
        
        return new Response(
          JSON.stringify({ 
            error: true, 
            file_id, 
            detection: detectionSummary, 
            routing: { routed_to: routing.route, reason: routing.reason }, 
            result: doclingResult.data,
            error_details: doclingResult.error,
            stage: "extraction"
          }),
          { status: doclingResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      
      console.log(`[ingest-file] Docling extraction succeeded, starting normalization`);
      
      // Step 2: Normalization with enhanced error handling
      const normalizeResult = await callEdgeFunction(supabaseUrl, "normalize-pdf-output", { file_id }, serviceKey);
      
      if (!normalizeResult.ok) {
        console.error(`[ingest-file] Normalization failed:`, normalizeResult.error);
        
        // Update file status with detailed error
        await supabaseAdmin
          .from("uploaded_files")
          .update({
            status: "failed", 
            error_message: `Document normalization failed: ${normalizeResult.error || 'Unknown error'}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", file_id);
      } else {
        console.log(`[ingest-file] Document processing completed successfully`);
        
        // Update file status to completed
        await supabaseAdmin
          .from("uploaded_files")
          .update({
            status: "completed",
            updated_at: new Date().toISOString(),
          })
          .eq("id", file_id);
      }
      
      return new Response(
        JSON.stringify({
          error: !normalizeResult.ok,
          file_id,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          steps: { 
            extraction: { 
              success: doclingResult.ok, 
              data: doclingResult.data,
              error: doclingResult.error 
            }, 
            normalization: { 
              success: normalizeResult.ok, 
              data: normalizeResult.data,
              error: normalizeResult.error 
            } 
          },
        }),
        { status: normalizeResult.ok ? 200 : normalizeResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // CSV / Excel / text: enhanced single step processing
    console.log(`[ingest-file] Starting structured data processing for ${detection.fileFormat} file`);
    
    const downstreamResult = await callEdgeFunction(supabaseUrl, routing.route, { file_id }, serviceKey);
    
    if (!downstreamResult.ok) {
      console.error(`[ingest-file] Structured data processing failed:`, downstreamResult.error);
      
      // Update file status with detailed error
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "failed",
          error_message: `Structured data processing failed: ${downstreamResult.error || 'Unknown error'}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);
    } else {
      console.log(`[ingest-file] Structured data processing completed successfully`);
      
      // Update file status to completed
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "completed",
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);
    }

    // 10. Return enhanced result with detailed status information
    return new Response(
      JSON.stringify({
        error: !downstreamResult.ok,
        file_id,
        detection: detectionSummary,
        routing: { routed_to: routing.route, reason: routing.reason },
        result: {
          success: downstreamResult.ok,
          data: downstreamResult.data,
          error: downstreamResult.error
        },
        processing_completed: downstreamResult.ok,
      }),
      {
        status: downstreamResult.ok ? 200 : downstreamResult.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );

  } catch (err) {
    console.error("[ingest-file] Unexpected error:", err.message, err.stack);
    
    // Try to update file status if we have the file_id
    try {
      const body = await req.clone().json();
      if (body.file_id) {
        const { user, supabaseAdmin } = await verifyUser(req);
        await supabaseAdmin
          .from("uploaded_files")
          .update({
            status: "failed",
            error_message: `Ingestion failed: ${err.message}`,
            updated_at: new Date().toISOString(),
          })
          .eq("id", body.file_id);
      }
    } catch (updateErr) {
      console.error("[ingest-file] Failed to update file status:", updateErr.message);
    }
    
    return new Response(
      JSON.stringify({
        error: true,
        message: `Ingestion failed: ${err.message}`,
        error_code: "INGESTION_FAILED",
        stack: err.stack,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

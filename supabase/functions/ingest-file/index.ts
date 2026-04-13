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

/** Calls another Edge Function in the same project via internal HTTP */
async function callEdgeFunction(
  supabaseUrl: string,
  functionName: string,
  body: Record<string, unknown>,
  authToken: string,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const url = `${supabaseUrl}/functions/v1/${functionName}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${authToken}`,
      "apikey": Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
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
      // (our CSV parser can't read binary .xlsx)
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
      // Unknown binary format — try Docling first; it handles many formats
      return { route: "parse-pdf-docling", reason: "Unknown format → Docling (best-effort extraction)" };
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

    // 8. Decide routing
    const routing = decideRoute(detection);

    if (routing.route === "unsupported") {
      // Mark as failed
      await supabaseAdmin
        .from("uploaded_files")
        .update({
          status: "failed",
          error_message: `Unsupported file format: ${detection.fileFormat}`,
          updated_at: new Date().toISOString(),
        })
        .eq("id", file_id);

      return new Response(
        JSON.stringify({
          error: true,
          message: `Unsupported file format: ${detection.fileFormat}`,
          error_code: "UNSUPPORTED_FORMAT",
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

    // PDF: two-step — Docling extraction then normalization
    if (routing.route === "parse-pdf-docling") {
      const doclingResult = await callEdgeFunction(supabaseUrl, "parse-pdf-docling", { file_id }, serviceKey);
      if (!doclingResult.ok) {
        return new Response(
          JSON.stringify({ error: true, file_id, detection: detectionSummary, routing: { routed_to: routing.route, reason: routing.reason }, result: doclingResult.data }),
          { status: doclingResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
      const normalizeResult = await callEdgeFunction(supabaseUrl, "normalize-pdf-output", { file_id }, serviceKey);
      return new Response(
        JSON.stringify({
          error: !normalizeResult.ok,
          file_id,
          detection: detectionSummary,
          routing: { routed_to: routing.route, reason: routing.reason },
          steps: { extraction: doclingResult.data, normalization: normalizeResult.data },
        }),
        { status: normalizeResult.ok ? 200 : normalizeResult.status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // CSV / Excel / text: single step
    const downstreamResult = await callEdgeFunction(supabaseUrl, routing.route, { file_id }, serviceKey);

    // 10. Return combined result
    return new Response(
      JSON.stringify({
        error: !downstreamResult.ok,
        file_id,
        detection: detectionSummary,
        routing: { routed_to: routing.route, reason: routing.reason },
        result: downstreamResult.data,
      }),
      {
        status: downstreamResult.ok ? 200 : downstreamResult.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );

  } catch (err) {
    console.error("[ingest-file] Error:", err.message);
    return new Response(
      JSON.stringify({
        error: true,
        message: err.message,
        error_code: "INGESTION_FAILED",
      }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

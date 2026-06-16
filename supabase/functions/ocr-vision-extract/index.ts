// @ts-nocheck
/**
 * Compatibility endpoint for older frontend bundles.
 *
 * The current lease pipeline must enter through ingest-file ->
 * parse-pdf-docling -> normalize-pdf-output. Older code called
 * `ocr-vision-extract` directly when an uploaded lease had no readable text.
 * Keep this thin shim so deployed bundles do not fail with CORS/404, while
 * delegating parser choice to `_shared/extraction/parser.ts`.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { isInternalCall } from "../_shared/internal-auth.ts";
import { parseDocument } from "../_shared/extraction/parser.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function extractStoragePath(fileUrl: string): string {
  const raw = String(fileUrl || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    const marker = "/financial-uploads/";
    const idx = url.pathname.indexOf(marker);
    if (idx >= 0) {
      return decodeURIComponent(url.pathname.slice(idx + marker.length));
    }
  } catch {
    // Fall through to string parsing for stored relative paths.
  }

  return raw
    .replace(/^.*\/storage\/v1\/object\/(?:public|sign)\/financial-uploads\//, "")
    .replace(/^financial-uploads\//, "")
    .replace(/\?.*$/, "");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    let supabaseAdmin: any;
    let orgId = "";

    if (isInternalCall(req)) {
      supabaseAdmin = createAdminClient();
      orgId = req.headers.get("x-internal-org-id")?.trim() ?? "";
    } else {
      const auth = await verifyUser(req);
      supabaseAdmin = auth.supabaseAdmin;
      orgId = await getUserOrgId(auth.user.id, supabaseAdmin, req);
    }

    const body = await req.json().catch(() => ({}));
    const fileId = body.file_id ?? body.fileId;
    if (!fileId) {
      return jsonResponse({ error: true, message: "file_id is required" }, 400);
    }

    let query = supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, file_name, file_url, mime_type, parsed_data, docling_raw")
      .eq("id", fileId);
    if (orgId) query = query.eq("org_id", orgId);

    const { data: fileRecord, error: fileError } = await query.maybeSingle();
    if (fileError || !fileRecord) {
      return jsonResponse(
        { error: true, message: `File not found: ${fileError?.message ?? "invalid file_id"}` },
        404,
      );
    }

    const storagePath = extractStoragePath(fileRecord.file_url);
    if (!storagePath) {
      return jsonResponse({ error: true, message: "Uploaded file has no storage path" }, 422);
    }

    const { data: fileBlob, error: downloadError } = await supabaseAdmin
      .storage
      .from("financial-uploads")
      .download(storagePath);
    if (downloadError || !fileBlob) {
      return jsonResponse(
        { error: true, message: `Failed to download source file: ${downloadError?.message ?? "missing blob"}` },
        422,
      );
    }

    const { data: signedUrlData } = await supabaseAdmin
      .storage
      .from("financial-uploads")
      .createSignedUrl(storagePath, 60 * 60);

    const fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
    const fileName = fileRecord.file_name ?? "document";
    const mimeType = fileRecord.mime_type ?? (fileBlob as any).type ?? "application/pdf";
    const doclingRaw = await parseDocument(fileBytes, fileName, mimeType, {
      fileUrl: signedUrlData?.signedUrl ?? fileRecord.file_url,
    });
    const text = String(doclingRaw?.full_text ?? "").trim();

    await supabaseAdmin
      .from("uploaded_files")
      .update({
        docling_raw: {
          ...(fileRecord.docling_raw || {}),
          ...doclingRaw,
          _metadata: {
            ...((fileRecord.docling_raw || {})._metadata || {}),
            ...((doclingRaw || {})._metadata || {}),
            compatibility_endpoint: "ocr-vision-extract",
            compatibility_extracted_at: new Date().toISOString(),
          },
        },
        parsed_data: {
          ...(fileRecord.parsed_data || {}),
          full_text: text,
          parser_source: doclingRaw?.extraction_method ?? "compatibility_parser",
        },
        extraction_method: doclingRaw?.extraction_method ?? "compatibility_parser",
      })
      .eq("id", fileId);

    return jsonResponse({
      ok: true,
      file_id: fileId,
      text,
      full_text_chars: text.length,
      parser_source: doclingRaw?.extraction_method ?? null,
      page_count: doclingRaw?.page_count ?? null,
    });
  } catch (error) {
    console.error("[ocr-vision-extract] Error:", error);
    return jsonResponse(
      { error: true, message: error?.message ?? "OCR compatibility extraction failed" },
      500,
    );
  }
});

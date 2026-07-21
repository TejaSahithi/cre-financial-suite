// @ts-nocheck
/**
 * Compatibility endpoint for older frontend bundles.
 *
 * The current lease pipeline must enter through ingest-file ->
 * parse-document-azure -> normalize-pdf-output. Older code called
 * `ocr-document-extract` directly when an uploaded lease had no readable text.
 * Keep this thin shim so deployed bundles do not fail with CORS/404, while
 * delegating parser choice to `_shared/extraction/parser.ts`.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { isInternalCall } from "../_shared/internal-auth.ts";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function firstText(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text.length > 0) return text;
  }
  return "";
}

function extractTextFromFileRecord(fileRecord: any): string {
  const normalized = fileRecord?.normalized_output ?? {};
  const reviewed = fileRecord?.reviewed_output ?? {};
  const uiPayload = fileRecord?.ui_review_payload ?? {};
  const parsed = fileRecord?.parsed_data ?? {};
  const docling = fileRecord?.docling_raw ?? {};

  return firstText(
    normalized.full_text,
    normalized.raw_text,
    normalized.text,
    reviewed.full_text,
    reviewed.raw_text,
    reviewed.text,
    uiPayload.full_text,
    uiPayload.raw_text,
    uiPayload.text,
    parsed.full_text,
    parsed.raw_text,
    parsed.text,
    docling.full_text,
    docling.text,
    Array.isArray(docling.text_blocks)
      ? docling.text_blocks.map((block: any) => block?.text).filter(Boolean).join("\n\n")
      : "",
  );
}

async function runCanonicalIngest(fileId: string, orgId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not configured");
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/ingest-file`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
      apikey: serviceKey,
      "x-internal-service-key": serviceKey,
      ...(orgId ? { "x-internal-org-id": orgId } : {}),
    },
    body: JSON.stringify({
      file_id: fileId,
      module_type: "leases",
      force_reextract: true,
      run_synchronously: true,
    }),
    signal: AbortSignal.timeout(55_000),
  });

  const text = await response.text().catch(() => "");
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw_response: text.slice(0, 500) };
  }

  if (!response.ok || payload?.error === true) {
    const message = payload?.message || payload?.error_details || payload?.error || `ingest-file failed with HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload ?? {};
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
      .select("id, org_id, file_name, file_url, mime_type, status, parsed_data, docling_raw, azure_raw_response, normalized_output, reviewed_output, ui_review_payload")
      .eq("id", fileId);
    if (orgId) query = query.eq("org_id", orgId);

    const { data: fileRecord, error: fileError } = await query.maybeSingle();
    if (fileError || !fileRecord) {
      return jsonResponse(
        { error: true, message: `File not found: ${fileError?.message ?? "invalid file_id"}` },
        404,
      );
    }
    fileRecord.docling_raw = fileRecord.azure_raw_response ?? fileRecord.docling_raw ?? null;

    const initialText = extractTextFromFileRecord(fileRecord);
    let ingestData: any = null;
    let ingestError = "";

    try {
      ingestData = await runCanonicalIngest(fileId, fileRecord.org_id || orgId);
    } catch (error) {
      ingestError = error?.message ?? "ingest-file failed";
      console.error("[ocr-document-extract] canonical ingest failed:", ingestError);
    }

    const { data: refreshedFile, error: refreshError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, file_name, file_url, mime_type, status, parsed_data, docling_raw, azure_raw_response, normalized_output, reviewed_output, ui_review_payload")
      .eq("id", fileId)
      .maybeSingle();

    if (refreshError) {
      throw new Error(`Failed to refresh parsed file: ${refreshError.message}`);
    }
    if (refreshedFile) refreshedFile.docling_raw = refreshedFile.azure_raw_response ?? refreshedFile.docling_raw ?? null;

    const outputFile = refreshedFile || fileRecord;
    const text = extractTextFromFileRecord(outputFile) || initialText;

    if (!text && ingestError) {
      return jsonResponse({
        error: true,
        message: ingestError,
        file_id: fileId,
        status: outputFile?.status ?? fileRecord.status ?? null,
        ingest: ingestData,
      }, 422);
    }

    return jsonResponse({
      ok: true,
      file_id: fileId,
      text,
      full_text_chars: text.length,
      parser_source:
        outputFile?.normalized_output?.parser_source ??
        outputFile?.parsed_data?.parser_source ??
        outputFile?.docling_raw?.extraction_method ??
        outputFile?.docling_raw?._metadata?.parser_source ??
        null,
      page_count:
        outputFile?.normalized_output?.page_count ??
        outputFile?.parsed_data?.page_count ??
        outputFile?.docling_raw?.page_count ??
        null,
      status: outputFile?.status ?? null,
      ingest: ingestData,
      compatibility_endpoint: "ocr-document-extract",
    });
  } catch (error) {
    console.error("[ocr-document-extract] Error:", error);
    return jsonResponse(
      { error: true, message: error?.message ?? "OCR compatibility extraction failed" },
      500,
    );
  }
});

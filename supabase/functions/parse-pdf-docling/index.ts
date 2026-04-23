// @ts-nocheck
/**
 * parse-pdf-docling — thin HTTP wrapper
 *
 * Single responsibility:
 *   1. Download the uploaded PDF/image/doc from storage.
 *   2. Delegate extraction to `_shared/extraction/parser.ts#parseDocument()`
 *      — the ONE canonical entry point for Docling + Gemini Vision.
 *   3. Persist the raw output onto `uploaded_files.docling_raw` and flip
 *      status → 'pdf_parsed' so `normalize-pdf-output` can pick it up.
 *
 * This function INTENTIONALLY does not contain any Docling or Gemini
 * call code of its own. All duplicate "callDoclingAPI / extractWithGeminiNative"
 * logic was removed on 2026-04-16 as part of the review-pipeline cleanup;
 * the shared parser is now the single source of truth.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { parseDocument } from "../_shared/extraction/parser.ts";
import { setStatus, setFailed } from "../_shared/pipeline-status.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    // 1. Auth + org isolation
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    // 2. Parse request body
    const body = await req.json().catch(() => ({}));
    const { file_id } = body;

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
    }

    // 3. Fetch file record (org_id scoped)
    const { data: fileRecord, error: fetchError } = await supabaseAdmin
      .from("uploaded_files")
      .select("*")
      .eq("id", file_id)
      .eq("org_id", orgId)
      .single();

    if (fetchError || !fileRecord) {
      return jsonResponse(
        {
          error: true,
          message: `File not found: ${fetchError?.message ?? "Invalid file_id or org mismatch"}`,
          error_code: "FILE_NOT_FOUND",
        },
        404,
      );
    }

    const fileName: string = fileRecord.file_name ?? "document";
    const mimeType: string = fileRecord.mime_type ?? "application/octet-stream";

    console.log(
      `[parse-pdf-docling] file_id=${file_id} name="${fileName}" mime=${mimeType} ` +
      `size=${fileRecord.file_size ?? "?"} bytes`,
    );

    // 4. Transition status → 'parsing'
    await setStatus(supabaseAdmin, file_id, "parsing");

    try {
      // 5. Download bytes from Supabase Storage
      const storagePath = fileRecord.file_url.replace(
        /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
        "",
      );

      const { data: fileBlob, error: downloadError } = await supabaseAdmin
        .storage
        .from("financial-uploads")
        .download(storagePath);

      if (downloadError || !fileBlob) {
        throw new Error(
          `Failed to download file from storage: ${downloadError?.message ?? "File not found"}`,
        );
      }

      const fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
      const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin
        .storage
        .from("financial-uploads")
        .createSignedUrl(storagePath, 60 * 60);

      if (signedUrlError) {
        console.warn(
          `[parse-pdf-docling] Could not create signed extraction URL for ${file_id}: ` +
          signedUrlError.message,
        );
      }

      // 6. Delegate to the canonical parser (Docling → Gemini Vision fallback)
      const doclingOutput = await parseDocument(fileBytes, fileName, mimeType, {
        fileUrl: signedUrlData?.signedUrl ?? fileRecord.file_url,
      });
      const extractionMethod = doclingOutput.extraction_method ?? "unknown";

      // 7. Persist raw output + metadata + transition to 'pdf_parsed'
      const extractionMetadata = {
        extraction_method: extractionMethod,
        file_format: mimeType,
        page_count: doclingOutput.page_count || 1,
        table_count: doclingOutput.tables?.length ?? 0,
        field_count: doclingOutput.fields?.length ?? 0,
        text_block_count: doclingOutput.text_blocks?.length ?? 0,
        has_content: !!(
          doclingOutput.full_text ||
          (doclingOutput.tables?.length ?? 0) > 0 ||
          (doclingOutput.fields?.length ?? 0) > 0
        ),
        extraction_timestamp: new Date().toISOString(),
      };

      const { error: updateError } = await setStatus(
        supabaseAdmin,
        file_id,
        "pdf_parsed",
        {
          docling_raw: { ...doclingOutput, _metadata: extractionMetadata },
          extraction_method: extractionMethod,
          parsed_data: [],
          row_count: (doclingOutput.tables ?? []).reduce(
            (n: number, t: any) => n + (t.rows?.length ?? 0),
            0,
          ),
          processing_completed_at: new Date().toISOString(),
        },
      );

      if (updateError) {
        throw new Error(`Failed to store extraction results: ${updateError.message}`);
      }

      console.log(
        `[parse-pdf-docling] OK file_id=${file_id} method=${extractionMethod} ` +
        `blocks=${extractionMetadata.text_block_count} tables=${extractionMetadata.table_count}`,
      );

      return jsonResponse({
        error: false,
        file_id,
        processing_status: "pdf_parsed",
        extraction_method: extractionMethod,
        file_format: mimeType,
        page_count: doclingOutput.page_count,
        table_count: extractionMetadata.table_count,
        field_count: extractionMetadata.field_count,
        text_block_count: extractionMetadata.text_block_count,
        has_content: extractionMetadata.has_content,
        content_summary: {
          text_length: doclingOutput.full_text?.length ?? 0,
          tables_found: extractionMetadata.table_count > 0,
          fields_found: extractionMetadata.field_count > 0,
          structured_data:
            extractionMetadata.table_count > 0 || extractionMetadata.field_count > 0,
        },
        docling_output: doclingOutput,
      });
    } catch (extractionError) {
      console.error(
        `[parse-pdf-docling] Extraction failed for ${file_id}:`,
        extractionError.message,
      );

      await setFailed(
        supabaseAdmin,
        file_id,
        `Document extraction failed: ${extractionError.message}`,
        "parsing",
        15,
      );

      throw extractionError;
    }
  } catch (err) {
    console.error("[parse-pdf-docling] Error:", err.message);
    return jsonResponse(
      {
        error: true,
        message: err.message,
        error_code: "PDF_PARSING_FAILED",
      },
      400,
    );
  }
});

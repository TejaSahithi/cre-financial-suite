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
import { createAdminClient, verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isInternalCall } from "../_shared/internal-auth.ts";
import { parseDocument } from "../_shared/extraction/parser.ts";
import { getAzureDocumentIntelligenceConfig } from "../_shared/azure/document-intelligence.ts";
import { resolveExtractionProvider, shouldUseAzureLayout } from "../_shared/extraction/extraction-provider.ts";
import { setStatus } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
import {
  buildBlockedReviewPayload,
  buildPipelineMetadata,
  countTextChars,
  mergePipelineIntoNormalizedOutput,
  MIN_LEASE_TEXT_CHARS,
  parserStatusForTextLength,
  PARSER_STATUSES,
  REVIEW_STATUSES,
} from "../_shared/extraction/pipeline-contract.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // ── Auth ─────────────────────────────────────────────────────────────────
  // Two caller modes:
  //   A. Internal worker  — x-worker-secret / x-internal-service-key / service-role Bearer
  //   B. User-facing call — normal user JWT forwarded by ingest-file
  //
  // For mode A, verifyUser() short-circuits on x-internal-service-key and
  // returns an admin client + synthetic internal user.  getUserOrgId() then
  // reads x-internal-org-id from the header (set by buildInternalFunctionHeaders).
  //
  // If neither mode applies we return a structured 401 immediately so the
  // worker can map it to DOWNSTREAM_AUTH_FAILED instead of a generic 400.
  const hasUserAuth = Boolean(
    req.headers.get("Authorization") ||
    req.headers.get("x-user-jwt") ||
    req.headers.get("x-supabase-auth"),
  );

  if (!isInternalCall(req) && !hasUserAuth) {
    return jsonResponse(
      { ok: false, error_code: "UNAUTHORIZED_INTERNAL_PARSE_CALL", message: "Unauthorized parse request" },
      401,
    );
  }

  try {
    const functionStartedAt = new Date().toISOString();
    // 1. Auth + org isolation
    let user: any;
    let supabaseAdmin: any;
    let orgId: string;

    if (isInternalCall(req)) {
      supabaseAdmin = createAdminClient();
      user = { id: "internal-compute", email: "internal-compute@system.local" };
      // orgId from x-internal-org-id header (set by lease-extraction-worker via
      // buildInternalFunctionHeaders).  If missing, fall back to DB lookup below.
      const headerOrgId = req.headers.get("x-internal-org-id")?.trim() ?? "";
      if (headerOrgId && /^[0-9a-f-]{36}$/i.test(headerOrgId)) {
        orgId = headerOrgId;
      } else {
        // Will be resolved after fetching the file record (see below).
        orgId = "";
      }
    } else {
      const authResult = await verifyUser(req);
      user = authResult.user;
      supabaseAdmin = authResult.supabaseAdmin;
      try {
        orgId = await getUserOrgId(user.id, supabaseAdmin, req);
      } catch (orgErr) {
        return jsonResponse(
          { ok: false, error_code: "UNAUTHORIZED_INTERNAL_PARSE_CALL", message: "Unauthorized parse request" },
          401,
        );
      }
    }

    // 2. Parse request body
    const body = await req.json().catch(() => ({}));
    const { file_id, dry_run, provider_override } = body;

    // dry_run=true: validate auth and config only — no file required, no DB writes.
    // Used by pipeline-health-check to verify internal worker auth is functional.
    if (dry_run === true) {
      const hasDocling = !!Deno.env.get("DOCLING_API_URL");
      const hasGeminiKey = !!(Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY"));
      const hasVision = !!(
        (
          (Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
          (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))
        ) ||
        hasGeminiKey
      );
      return jsonResponse({
        ok: true,
        dry_run: true,
        authenticated: true,
        extraction_provider: resolveExtractionProvider(provider_override).mode,
        extraction_provider_source: resolveExtractionProvider(provider_override).source,
        backends: {
          docling: hasDocling,
          vision: hasVision,
          gemini_api_key: hasGeminiKey,
          azure_document_intelligence: !!(getAzureDocumentIntelligenceConfig().endpoint && getAzureDocumentIntelligenceConfig().keyPresent),
        },
        azure: {
          endpoint: getAzureDocumentIntelligenceConfig().endpoint ? "present" : "missing",
          key: getAzureDocumentIntelligenceConfig().keyPresent ? "present" : "missing",
          api_version: getAzureDocumentIntelligenceConfig().apiVersion,
          model_id: getAzureDocumentIntelligenceConfig().modelId,
          output_format: getAzureDocumentIntelligenceConfig().outputFormat,
        },
        message: "Auth verified. dry_run=true — no file processed.",
      });
    }

    if (!file_id) {
      return jsonResponse(
        { error: true, message: "file_id is required", error_code: "MISSING_FILE_ID" },
        400,
      );
    }

    // 3. Fetch file record.
    // Internal calls may arrive without an org_id header when the worker
    // builds headers without an explicit org (shouldn't happen, but be safe).
    // In that case do an unscoped admin lookup so we can still resolve the org.
    let fileRecord: any;
    if (orgId) {
      const { data, error: fetchError } = await supabaseAdmin
        .from("uploaded_files")
        .select("*")
        .eq("id", file_id)
        .eq("org_id", orgId)
        .single();
      if (fetchError || !data) {
        return jsonResponse(
          { error: true, message: `File not found: ${fetchError?.message ?? "Invalid file_id or org mismatch"}`, error_code: "FILE_NOT_FOUND" },
          404,
        );
      }
      fileRecord = data;
    } else {
      // orgId missing — admin lookup without org scope (internal calls only)
      const { data, error: fetchError } = await supabaseAdmin
        .from("uploaded_files")
        .select("*")
        .eq("id", file_id)
        .maybeSingle();
      if (fetchError || !data) {
        return jsonResponse(
          { error: true, message: `File not found: ${fetchError?.message ?? "Invalid file_id"}`, error_code: "FILE_NOT_FOUND" },
          404,
        );
      }
      fileRecord = data;
      orgId = data.org_id ?? "";
    }

    const fileName: string = fileRecord.file_name ?? "document";
    const mimeType: string = fileRecord.mime_type ?? "application/octet-stream";
    const logger = createLogger(supabaseAdmin, file_id, orgId);

    const persistBlockedParse = async (args: {
      parserStatus: string;
      errorCode: string;
      message: string;
      fullTextChars?: number;
      pageCount?: number | null;
      providerUsed?: string | null;
      warnings?: string[];
      doclingRaw?: Record<string, unknown> | null;
    }) => {
      const pipeline = buildPipelineMetadata({
        parser_status: args.parserStatus,
        review_status: REVIEW_STATUSES.BLOCKED,
        error_code: args.errorCode,
        error_message: args.message,
        started_at: functionStartedAt,
        finished_at: new Date().toISOString(),
        full_text_chars: args.fullTextChars ?? 0,
        page_count: args.pageCount ?? null,
        provider_used: args.providerUsed ?? null,
        docling_raw_present: !!args.doclingRaw,
        warnings: args.warnings ?? [],
        stage: "parse",
      });
      const payload = buildBlockedReviewPayload({
        fileId: file_id,
        fileName,
        moduleType: fileRecord.module_type ?? "leases",
        documentSubtype: fileRecord.document_subtype ?? null,
        extractionMethod: args.providerUsed ?? null,
        message: "The document could not be parsed into readable lease text.",
        pipeline,
      });
      const doclingRaw = {
        ...(args.doclingRaw ?? {}),
        full_text: (args.doclingRaw as any)?.full_text ?? "",
        text_blocks: Array.isArray((args.doclingRaw as any)?.text_blocks) ? (args.doclingRaw as any).text_blocks : [],
        tables: Array.isArray((args.doclingRaw as any)?.tables) ? (args.doclingRaw as any).tables : [],
        fields: Array.isArray((args.doclingRaw as any)?.fields) ? (args.doclingRaw as any).fields : [],
        pages: Array.isArray((args.doclingRaw as any)?.pages) ? (args.doclingRaw as any).pages : [],
        page_count: args.pageCount ?? (args.doclingRaw as any)?.page_count ?? null,
        warnings: args.warnings ?? (args.doclingRaw as any)?.warnings ?? [],
        extraction_method: args.providerUsed ?? (args.doclingRaw as any)?.extraction_method ?? "none",
        _metadata: {
          ...(((args.doclingRaw as any)?._metadata ?? {}) as Record<string, unknown>),
          ...pipeline,
          pipeline,
        },
      };
      const { error } = await setStatus(supabaseAdmin, file_id, "failed", {
        processing_status: args.parserStatus,
        review_status: REVIEW_STATUSES.BLOCKED,
        review_required: false,
        error_message: args.message,
        failed_step: "parse",
        extraction_method: args.providerUsed ?? "none",
        docling_raw: doclingRaw,
        ui_review_payload: payload,
        normalized_output: mergePipelineIntoNormalizedOutput(null, pipeline, {
          method: "blocked_pipeline_failure",
          rows: [],
          warnings: payload.global_warnings,
          validationErrors: [],
        }),
        parsed_data: [],
        row_count: 0,
        valid_count: 0,
        error_count: 1,
      });
      if (error) {
        console.error(`[parse-pdf-docling] Failed to persist blocked parser state for ${file_id}:`, error);
      }
      await logger.event("parse", "blocked", {
        parser_status: args.parserStatus,
        error_code: args.errorCode,
        full_text_chars: args.fullTextChars ?? 0,
        page_count: args.pageCount ?? null,
        provider_used: args.providerUsed ?? null,
        duration_ms: pipeline.total_duration_ms,
      });
      return payload;
    };

    console.log(
      `[parse-pdf-docling] file_id=${file_id} name="${fileName}" mime=${mimeType} ` +
      `size=${fileRecord.file_size ?? "?"} bytes`,
    );

    // 4. Transition status → 'parsing'
    const { error: parsingStatusError } = await setStatus(supabaseAdmin, file_id, "parsing");
    if (parsingStatusError) {
      throw new Error(`Failed to transition file to parsing: ${parsingStatusError.message}`);
    }
    await logger.event("parse", "started", {
      file_size_bytes: Number(fileRecord.file_size || 0) || null,
      mime_type: mimeType,
    });

    try {
      // 5. Pre-flight: check whether any parser backend can handle this file.
      // Native PDF text extraction only handles ≤ 4 MB. Docling and Vision handle
      // larger files via external APIs. If the file is large and neither API is
      // configured, downloading it would waste memory and still return empty output.
      const MAX_NATIVE_BYTES = 10 * 1024 * 1024;
      const fileSizeBytes = Number(fileRecord.file_size || 0);
      const hasDocling = !!Deno.env.get("DOCLING_API_URL");
      const hasVision = !!(
        // Vertex AI service account path
        ((Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID")) &&
         (Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY") || Deno.env.get("GOOGLE_PRIVATE_KEY"))) ||
        // Gemini Developer API key path
        Deno.env.get("GEMINI_API_KEY") ||
        Deno.env.get("GOOGLE_API_KEY")
      );

      const providerSelection = resolveExtractionProvider(provider_override);
      const azureProviderEnabled = shouldUseAzureLayout(providerSelection.mode);
      const fileTooLargeForNative = fileSizeBytes > 0 && fileSizeBytes > MAX_NATIVE_BYTES;
      if (fileTooLargeForNative && !hasDocling && !hasVision && !azureProviderEnabled) {
        console.warn(
          `[parse-pdf-docling] file_id=${file_id} size=${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB — ` +
          `larger than native-text limit (${MAX_NATIVE_BYTES / 1024 / 1024} MB) and no Docling/Vision backend configured. ` +
          `Storing empty docling_raw and continuing so the reviewer can manually fill fields.`,
        );
        const reason =
          `File too large for native extraction (${(fileSizeBytes / 1024 / 1024).toFixed(1)} MB) and ` +
          `no DOCLING_API_URL or Vertex AI credentials are configured. ` +
          `Set one of these in Supabase Edge Function secrets to enable AI extraction.`;
        const payload = await persistBlockedParse({
          parserStatus: PARSER_STATUSES.OCR_REQUIRED,
          errorCode: "PARSER_PROVIDER_UNAVAILABLE",
          message: reason,
          fullTextChars: 0,
          pageCount: null,
          providerUsed: "none",
          warnings: [reason],
        });
        return jsonResponse({
          error: true,
          file_id,
          processing_status: "failed",
          extraction_method: "none",
          parser_status: PARSER_STATUSES.OCR_REQUIRED,
          error_code: "PARSER_PROVIDER_UNAVAILABLE",
          message: reason,
          ui_review_payload: payload,
        }, 422);
      }

      // 5b. Download bytes from Supabase Storage
      const storagePath = fileRecord.file_url.replace(
        /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
        "",
      );

      console.log(
        `[parse-pdf-docling] downloading file_id=${file_id} ` +
        `size=${fileSizeBytes > 0 ? (fileSizeBytes / 1024 / 1024).toFixed(2) + " MB" : "unknown"} ` +
        `hasDocling=${hasDocling} hasVision=${hasVision}`,
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
        providerOverride: provider_override,
      });
      const extractionMethod = doclingOutput.extraction_method ?? "unknown";

      // 7. Persist raw output + metadata + transition to 'pdf_parsed'
      //
      // Cap full_text and text_blocks before storing — for a long lease PDF the
      // raw Docling output can be 5–20 MB. The extraction pipeline only uses the
      // first ~30 K characters of text (via chunker.ts) and at most a few hundred
      // blocks, so trimming here saves significant heap during JSON serialization
      // and keeps the Supabase JSONB column within sensible limits.
      const MAX_STORED_TEXT_CHARS  = 80_000;
      const MAX_STORED_BLOCKS      = 1000;
      const MAX_STORED_TABLES      = 500;
      const MAX_STORED_PAGES       = 150;
      // Per-page and per-block text is capped at 3 K chars. For a dense
      // 4 K-char page this captures the first ~75 % of the text — more than
      // enough for field extraction and source-evidence matching in normalize.
      // Without this cap, buildPageTextCandidates / buildEvidenceSearchBlocks
      // allocate 3 string copies per page on every field iteration, which can
      // push normalize-pdf-output over the 256 MB Edge Function memory limit.
      const MAX_PAGE_TEXT_CHARS    = 3_000;
      const trimDocText = (text: unknown) =>
        typeof text === "string" && text.length > MAX_PAGE_TEXT_CHARS
          ? text.slice(0, MAX_PAGE_TEXT_CHARS)
          : text;
      const trimmedDoclingRaw: Record<string, unknown> = {
        ...doclingOutput,
        full_text: typeof doclingOutput.full_text === "string" && doclingOutput.full_text.length > MAX_STORED_TEXT_CHARS
          ? doclingOutput.full_text.slice(0, MAX_STORED_TEXT_CHARS) + "\n[truncated]"
          : doclingOutput.full_text,
        text_blocks: (Array.isArray(doclingOutput.text_blocks)
          ? doclingOutput.text_blocks.slice(0, MAX_STORED_BLOCKS)
          : []).map((b: any) => ({ ...b, text: trimDocText(b?.text) })),
        tables: Array.isArray(doclingOutput.tables) && doclingOutput.tables.length > MAX_STORED_TABLES
          ? doclingOutput.tables.slice(0, MAX_STORED_TABLES)
          : doclingOutput.tables,
        pages: (Array.isArray(doclingOutput.pages)
          ? doclingOutput.pages.slice(0, MAX_STORED_PAGES)
          : []).map((p: any) => ({ ...p, text: trimDocText(p?.text) })),
      };

      const parserOutputMetadata =
        (doclingOutput as any)?._metadata && typeof (doclingOutput as any)._metadata === "object"
          ? ((doclingOutput as any)._metadata as Record<string, unknown>)
          : {};
      const extractionMetadata = {
        ...parserOutputMetadata,
        extraction_method: extractionMethod,
        provider: parserOutputMetadata.provider ?? (extractionMethod === "azure_layout" ? "azure_document_intelligence" : null),
        file_format: mimeType,
        page_count: doclingOutput.page_count ?? null,
        table_count: doclingOutput.tables?.length ?? 0,
        field_count: doclingOutput.fields?.length ?? 0,
        text_block_count: doclingOutput.text_blocks?.length ?? 0,
        has_content: !!(
          doclingOutput.full_text ||
          (doclingOutput.tables?.length ?? 0) > 0 ||
          (doclingOutput.fields?.length ?? 0) > 0
        ),
        extraction_timestamp: new Date().toISOString(),
        text_truncated: typeof doclingOutput.full_text === "string" && doclingOutput.full_text.length > MAX_STORED_TEXT_CHARS,
        blocks_truncated: Array.isArray(doclingOutput.text_blocks) && doclingOutput.text_blocks.length > MAX_STORED_BLOCKS,
      };
      const fullTextChars = countTextChars(doclingOutput.full_text);
      const parserStatus = parserStatusForTextLength(fullTextChars);
      const parserPipeline = buildPipelineMetadata({
        parser_status: parserStatus,
        review_status: parserStatus === PARSER_STATUSES.COMPLETED ? null : REVIEW_STATUSES.BLOCKED,
        error_code: parserStatus === PARSER_STATUSES.COMPLETED ? null : (
          parserStatus === PARSER_STATUSES.EMPTY_TEXT ? "EMPTY_PARSE_TEXT" : "INSUFFICIENT_PARSE_TEXT"
        ),
        error_message: parserStatus === PARSER_STATUSES.COMPLETED ? null : "The document could not be parsed into readable lease text.",
        started_at: functionStartedAt,
        finished_at: new Date().toISOString(),
        full_text_chars: fullTextChars,
        page_count: doclingOutput.page_count ?? null,
        provider_used: extractionMethod,
        docling_raw_present: true,
        ocr_used: extractionMethod.includes("vision") || extractionMethod.includes("ocr"),
        warnings: Array.isArray((doclingOutput as any).warnings) ? (doclingOutput as any).warnings : [],
        stage: "parse",
      });

      if (parserStatus !== PARSER_STATUSES.COMPLETED) {
        const errorCode = parserStatus === PARSER_STATUSES.EMPTY_TEXT ? "EMPTY_PARSE_TEXT" : "INSUFFICIENT_PARSE_TEXT";
        const message = parserStatus === PARSER_STATUSES.EMPTY_TEXT
          ? "The document could not be parsed into readable lease text."
          : `The document parser returned only ${fullTextChars} readable characters; at least ${MIN_LEASE_TEXT_CHARS} are required for automatic lease extraction.`;
        const payload = await persistBlockedParse({
          parserStatus,
          errorCode,
          message,
          fullTextChars,
          pageCount: doclingOutput.page_count ?? null,
          providerUsed: extractionMethod,
          warnings: Array.isArray((doclingOutput as any).warnings) ? (doclingOutput as any).warnings : [],
          doclingRaw: { ...trimmedDoclingRaw, _metadata: { ...extractionMetadata, pipeline: parserPipeline } },
        });
        return jsonResponse({
          error: true,
          file_id,
          processing_status: "failed",
          parser_status: parserStatus,
          error_code: errorCode,
          message,
          full_text_chars: fullTextChars,
          page_count: doclingOutput.page_count ?? null,
          ui_review_payload: payload,
        }, 422);
      }

      const { error: updateError } = await setStatus(
        supabaseAdmin,
        file_id,
        "pdf_parsed",
        {
          docling_raw: { ...trimmedDoclingRaw, _metadata: { ...extractionMetadata, ...parserPipeline, pipeline: parserPipeline } },
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
      await logger.event("parse", "completed", {
        parser_status: parserStatus,
        full_text_chars: fullTextChars,
        page_count: doclingOutput.page_count ?? null,
        provider_used: extractionMethod,
        text_block_count: extractionMetadata.text_block_count,
        table_count: extractionMetadata.table_count,
        field_count: extractionMetadata.field_count,
        duration_ms: parserPipeline.total_duration_ms,
      });

      return jsonResponse({
        error: false,
        file_id,
        processing_status: "pdf_parsed",
        extraction_method: extractionMethod,
        file_format: mimeType,
        page_count: doclingOutput.page_count,
        parser_status: parserStatus,
        table_count: extractionMetadata.table_count,
        field_count: extractionMetadata.field_count,
        text_block_count: extractionMetadata.text_block_count,
        has_content: extractionMetadata.has_content,
        content_summary: {
          text_length: fullTextChars,
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

      const errMsg = String(extractionError.message ?? extractionError);
      const isOcrError = /vision ocr|gemini vision|vertex ai|ocr (failed|required)|No parser backend/i.test(errMsg);
      const isProviderMissing = /No parser backend|DOCLING_API_URL|VERTEX_PROJECT_ID|GOOGLE_SERVICE_ACCOUNT_KEY/i.test(errMsg);

      await persistBlockedParse({
        parserStatus: isOcrError ? PARSER_STATUSES.OCR_FAILED : PARSER_STATUSES.FAILED,
        errorCode: isProviderMissing ? "PARSER_PROVIDER_UNAVAILABLE" : (isOcrError ? "OCR_FAILED" : "PDF_PARSING_FAILED"),
        message: errMsg,
        fullTextChars: 0,
        pageCount: null,
        providerUsed: isOcrError ? "gemini_vision" : null,
        warnings: [errMsg],
      });

      throw extractionError;
    }
  } catch (err) {
    console.error("[parse-pdf-docling] Error:", err.message);
    const errMsg = String(err.message ?? "");
    // Auth failures get a clean 401 so the worker maps them to DOWNSTREAM_AUTH_FAILED
    // instead of the generic DOWNSTREAM_FUNCTION_FAILED (400).
    const isAuthError = /unauthorized|missing authorization|invalid token|auth failed/i.test(errMsg);
    const isOcrError = /vision ocr|gemini vision|vertex ai|ocr (failed|required)|No parser backend/i.test(errMsg);
    const isProviderMissing = /No parser backend|DOCLING_API_URL|VERTEX_PROJECT_ID|GOOGLE_SERVICE_ACCOUNT_KEY/i.test(errMsg);
    return jsonResponse(
      {
        ok: false,
        error: true,
        message: errMsg,
        error_code: isAuthError
          ? "UNAUTHORIZED_INTERNAL_PARSE_CALL"
          : isProviderMissing
            ? "PARSER_PROVIDER_UNAVAILABLE"
            : isOcrError
              ? "OCR_FAILED"
              : "PDF_PARSING_FAILED",
      },
      isAuthError ? 401 : 400,
    );
  }
});

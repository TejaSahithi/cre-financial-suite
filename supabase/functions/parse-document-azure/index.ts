// @ts-nocheck
/**
 * parse-document-azure — thin HTTP wrapper
 *
 * Single responsibility:
 *   1. Download the uploaded PDF/image/doc from storage.
 *   2. Delegate extraction to `_shared/extraction/parser.ts#parseDocument()`
 *      — the ONE canonical entry point for Azure Document Intelligence.
 *   3. Persist the raw output onto `uploaded_files.docling_raw` and flip
 *      status → 'pdf_parsed' so `normalize-pdf-output` can pick it up.
 *
 * This function INTENTIONALLY does not contain any legacy parser or LLM
 * call code of its own. Provider-specific parsing logic lives in the shared
 * parser; Azure Document Intelligence is now the parser backend.
 */

import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient, verifyUser, getUserOrgId } from "../_shared/supabase.ts";
import { isInternalCall } from "../_shared/internal-auth.ts";
import { parseDocument } from "../_shared/extraction/parser.ts";
import { getAzureDocumentIntelligenceConfig } from "../_shared/azure/document-intelligence.ts";
import { resolveExtractionProvider } from "../_shared/extraction/extraction-provider.ts";
import { setStatus } from "../_shared/pipeline-status.ts";
import { createLogger } from "../_shared/logger.ts";
import { shouldUseLocalAzureByteSource } from "./source-strategy.ts";
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
import { withExtractionStage } from "../_shared/extraction/provenance/recorder.ts";
import type { StageHandle } from "../_shared/extraction/provenance/types.ts";
import { extractPdfPageCountFromBytes } from "../_shared/extraction/pdf-metadata.ts";
import { isWholeDocumentLlmActive } from "../_shared/extraction/whole-document-llm/feature-mode.ts";
import {
  buildCompactLeaseDocument,
  PERSISTED_COMPACT_DOCUMENT_KEY,
} from "../_shared/extraction/whole-document-llm/compact-document.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  // P1.3: extraction-stage provenance. Declared here (outer scope) so the
  // `finally` block at the very end can always call ensureSettled(), even
  // if an error occurs before the stage is actually created below (e.g. an
  // auth failure) -- in that case it stays the inert no-op handle and
  // ensureSettled() is a true no-op.
  let stage: StageHandle | null = null;

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
    const {
      file_id, dry_run, provider_override,
      // P1.3: provenance identifiers, threaded through by the worker's
      // generation-scoped dispatch. NOT present on ingest-file's own direct
      // synchronous call (non-lease modules, or run_synchronously=true) --
      // that path has no P0 generation concept at all, so provenance simply
      // doesn't apply there. Presence of generation_id (not the global flag
      // alone) is what decides whether this request attempts to record a
      // stage run at all -- see withExtractionStage call below.
      pipeline_job_id, generation_id, extraction_run_id, worker_attempt,
    } = body;

    // dry_run=true: validate auth and config only — no file required, no DB writes.
    // Used by pipeline-health-check to verify internal worker auth is functional.
    if (dry_run === true) {
      const providerConfig = getAzureDocumentIntelligenceConfig();
      const providerSelection = resolveExtractionProvider(provider_override);
      return jsonResponse({
        ok: true,
        dry_run: true,
        authenticated: true,
        extraction_provider: providerSelection.mode,
        extraction_provider_source: providerSelection.source,
        backends: {
          azure_document_intelligence: !!(providerConfig.endpoint && providerConfig.keyPresent),
        },
        azure: {
          endpoint: providerConfig.endpoint ? "present" : "missing",
          key: providerConfig.keyPresent ? "present" : "missing",
          api_version: providerConfig.apiVersion,
          model_id: providerConfig.modelId,
          output_format: providerConfig.outputFormat,
        },
        message: "Auth verified. dry_run=true - no file processed.",
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

    // P1.3: only attempt to record a stage run when this request actually
    // carries a generation_id -- calls without one (non-lease modules, or
    // ingest-file's own synchronous path) are out of scope for extraction
    // provenance, exactly as they're out of scope for P0's generation/
    // readiness machinery. When generation_id IS present, withExtractionStage
    // itself still no-ops if the feature flag is off.
    if (generation_id) {
      stage = await withExtractionStage(supabaseAdmin, {
        orgId,
        uploadedFileId: file_id,
        generationId: generation_id,
        extractionRunId: extraction_run_id ?? null,
        pipelineJobId: pipeline_job_id,
        stage: "parse",
        attempt: Number(worker_attempt) || 1,
      });
    }

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
        azure_raw_response: doclingRaw,
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
        console.error(`[parse-document-azure] Failed to persist blocked parser state for ${file_id}:`, error);
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
      `[parse-document-azure] file_id=${file_id} name="${fileName}" mime=${mimeType} ` +
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
      // 5. Pre-flight: Azure Document Intelligence is the parser backend.
      const MAX_NATIVE_BYTES = 10 * 1024 * 1024;
      const fileSizeBytes = Number(fileRecord.file_size || 0);
      const providerSelection = resolveExtractionProvider(provider_override);
      const azureConfig = getAzureDocumentIntelligenceConfig();
      const azureConfigured = !!(azureConfig.endpoint && azureConfig.keyPresent);

      if (!azureConfigured) {
        const missing = [
          azureConfig.endpoint ? null : "AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT",
          azureConfig.keyPresent ? null : "AZURE_DOCUMENT_INTELLIGENCE_KEY",
        ].filter(Boolean).join(" and ");
        const reason =
          `Azure Document Intelligence is not configured. Set ${missing} in Supabase Edge Function secrets to enable document parsing.`;
        const payload = await persistBlockedParse({
          parserStatus: PARSER_STATUSES.OCR_REQUIRED,
          errorCode: "PARSER_PROVIDER_UNAVAILABLE",
          message: reason,
          fullTextChars: 0,
          pageCount: null,
          providerUsed: "azure_document_intelligence",
          warnings: [reason],
        });
        await stage?.fail("PARSER_PROVIDER_UNAVAILABLE", reason, { outcome: "terminal_failure" });
        return jsonResponse({
          error: true,
          file_id,
          processing_status: "failed",
          extraction_method: "azure_document_intelligence",
          parser_status: PARSER_STATUSES.OCR_REQUIRED,
          error_code: "PARSER_PROVIDER_UNAVAILABLE",
          message: reason,
          ui_review_payload: payload,
        }, 422);
      }

      // 5b. Resolve the document source.
      //
      // Azure mode is URL-first: Azure fetches the document itself via a signed
      // Supabase Storage URL, so downloading the file into Edge Function memory
      // only wastes heap except for local development fallbacks.
      // Prefer the canonical storage_path column (set directly by
      // upload-handler from the same variable it uploaded with -- no string
      // parsing); fall back to parsing file_url only for rows that predate
      // that column existing.
      const storagePath = fileRecord.storage_path || fileRecord.file_url.replace(
        /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
        "",
      );
      const strictAzureMode = providerSelection.mode === "azure_document_intelligence";

      // Confirm the source bytes actually exist in storage before asking
      // Azure to fetch them. Without this, a file whose upload never
      // durably landed (uploaded_files row created, but storage.objects
      // has no matching row) previously surfaced as a confusing
      // "document parser returned only N readable characters" error --
      // Azure OCR'ing a tiny storage-error response body instead of the
      // real PDF -- rather than a clear, immediate, actionable failure.
      const storagePathParts = storagePath.split("/");
      const storageFileName = storagePathParts.pop() ?? "";
      const storageDir = storagePathParts.join("/");
      const { data: storageListing, error: storageListError } = await supabaseAdmin
        .storage
        .from("financial-uploads")
        .list(storageDir, { search: storageFileName, limit: 1 });
      const storageObjectExists = !storageListError &&
        Array.isArray(storageListing) &&
        storageListing.some((entry: any) => entry?.name === storageFileName);
      if (!storageObjectExists) {
        const reason =
          `Source file is missing from storage (path="${storagePath}"). The upload did not durably ` +
          `complete, so there is nothing for Azure Document Intelligence to read.`;
        console.error(`[parse-document-azure] ${reason}`, storageListError ?? "");
        const payload = await persistBlockedParse({
          parserStatus: PARSER_STATUSES.OCR_REQUIRED,
          errorCode: "SOURCE_FILE_MISSING_FROM_STORAGE",
          message: reason,
          fullTextChars: 0,
          pageCount: null,
          providerUsed: "azure_document_intelligence",
          warnings: [reason],
        });
        await stage?.fail("SOURCE_FILE_MISSING_FROM_STORAGE", reason, { outcome: "terminal_failure" });
        return jsonResponse({
          error: true,
          file_id,
          processing_status: "failed",
          extraction_method: "azure_document_intelligence",
          parser_status: PARSER_STATUSES.OCR_REQUIRED,
          error_code: "SOURCE_FILE_MISSING_FROM_STORAGE",
          message: reason,
          ui_review_payload: payload,
        }, 422);
      }

      const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin
        .storage
        .from("financial-uploads")
        .createSignedUrl(storagePath, 60 * 60);

      if (signedUrlError) {
        if (strictAzureMode) {
          // Azure-only mode has no byte fallback by design — fail loudly
          // rather than handing Azure a public URL that may not be readable.
          throw new Error(
            `Failed to create signed extraction URL for Azure Document Intelligence: ${signedUrlError.message}`,
          );
        }
        console.warn(
          `[parse-document-azure] Could not create signed extraction URL for ${file_id}: ` +
          signedUrlError.message,
        );
      }

      const signedOrStoredUrl = signedUrlData?.signedUrl ?? fileRecord.file_url;
      const sourceStrategy = shouldUseLocalAzureByteSource({
        strictAzureMode,
        localSupabaseRuntime: Deno.env.get("LOCAL_SUPABASE_RUNTIME")?.toLowerCase() === "true",
        sourceUrl: signedOrStoredUrl,
        fileSizeBytes,
        maxLocalAzureBytes: MAX_NATIVE_BYTES,
      });

      let fileBytes: Uint8Array | null = null;
      if (sourceStrategy.loadBytesFromStorage || !strictAzureMode) {
        const reason = sourceStrategy.loadBytesFromStorage
          ? `local Azure byte source (${sourceStrategy.category})`
          : "parser byte-source fallback";
        console.log(
          `[parse-document-azure] downloading file_id=${file_id} reason=${reason} ` +
          `size=${fileSizeBytes > 0 ? (fileSizeBytes / 1024 / 1024).toFixed(2) + " MB" : "unknown"} ` +
          `azure_configured=${azureConfigured}`,
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

        fileBytes = new Uint8Array(await fileBlob.arrayBuffer());
      } else {
        console.log(
          `[parse-document-azure] strict Azure mode for file_id=${file_id} - ` +
          `skipping byte download, sending signed URL to Azure ` +
          `(source_category=${sourceStrategy.category})`,
        );
      }

      const pdfMetadataPageCount = mimeType.toLowerCase().includes("pdf") && fileBytes
        ? extractPdfPageCountFromBytes(fileBytes)
        : null;

      // 6. Delegate to the canonical parser (Azure Document Intelligence).
      const doclingOutput = await parseDocument(fileBytes, fileName, mimeType, {
        fileUrl: sourceStrategy.sendUrlToAzure ? signedOrStoredUrl : undefined,
        providerOverride: provider_override,
        uploadedFileId: file_id,
        orgId,
        generationId: generation_id ?? fileRecord.active_generation_id ?? null,
        ...(stage?.stageRunId
          ? {
            provenance: {
              supabaseAdmin,
              context: {
                orgId,
                uploadedFileId: file_id,
                generationId: generation_id ?? fileRecord.active_generation_id ?? null,
                extractionRunId: extraction_run_id ?? null,
                stageRunId: stage.stageRunId,
                stageAttempt: Number(worker_attempt) || 1,
                operation: "azure_layout_analyze",
              },
            },
          }
          : {}),
      });
      const extractionMethod = doclingOutput.extraction_method ?? "unknown";
      const canonicalLayoutV3 = (doclingOutput as any)._canonical_layout_v3;
      const canonicalLayoutV3Update = canonicalLayoutV3 !== undefined
        ? {
          canonical_layout_v3: canonicalLayoutV3 ?? null,
          canonical_layout_v3_hash: (doclingOutput as any)._canonical_layout_v3_hash ?? null,
          canonical_layout_v3_schema_version: (doclingOutput as any)._canonical_layout_v3_schema_version ?? null,
          canonical_layout_v3_adapter_version: (doclingOutput as any)._canonical_layout_v3_adapter_version ?? null,
        }
        : {};

      // 7. Persist raw output + metadata + transition to 'pdf_parsed'
      //
      // Cap full_text and text_blocks before storing — for a long lease PDF the
      // raw parser output can be 5-20 MB. The extraction pipeline only uses the
      // first ~30 K characters of text (via chunker.ts) and at most a few hundred
      // blocks, so trimming here saves significant heap during JSON serialization
      // and keeps the Supabase JSONB column within sensible limits.
      const MAX_STORED_TEXT_CHARS  = 80_000;
      const MAX_STORED_BLOCKS      = 1000;
      const MAX_STORED_TABLES     = 500;
      const MAX_STORED_PAGES       = 150;
      const MAX_STORED_FIELDS      = 500;
      const MAX_STORED_WARNINGS    = 50;
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
      const capLongText = (text: unknown) =>
        typeof text === "string" && text.length > MAX_STORED_TEXT_CHARS
          ? text.slice(0, MAX_STORED_TEXT_CHARS) + "\n[truncated]"
          : text;

      // Counts computed from the raw parser output BEFORE building the capped
      // persistence object, so truncation never skews the recorded totals.
      const fullTextChars = countTextChars(doclingOutput.full_text);
      const rawBlockCount = Array.isArray(doclingOutput.text_blocks) ? doclingOutput.text_blocks.length : 0;
      const rawTableCount = Array.isArray(doclingOutput.tables) ? doclingOutput.tables.length : 0;
      const rawFieldCount = Array.isArray(doclingOutput.fields) ? doclingOutput.fields.length : 0;
      // Build this BEFORE any persistence caps. It contains complete page
      // text/tables/key-values without Azure geometry or duplicated markdown,
      // and is the reading surface for LEASE_WHOLE_DOCUMENT_LLM_V1.
      const wholeDocumentLlmActive = isWholeDocumentLlmActive();
      const wholeDocumentCompact = wholeDocumentLlmActive
        ? buildCompactLeaseDocument(doclingOutput, "azure_full_layout")
        : null;

      const cappedFullText = capLongText(doclingOutput.full_text);
      const cappedMarkdown = capLongText((doclingOutput as any).markdown);
      const cappedPages = (Array.isArray(doclingOutput.pages)
        ? doclingOutput.pages.slice(0, MAX_STORED_PAGES)
        : []).map((p: any) => ({ ...p, text: trimDocText(p?.text) }));
      const cappedBlocks = (Array.isArray(doclingOutput.text_blocks)
        ? doclingOutput.text_blocks.slice(0, MAX_STORED_BLOCKS)
        : []).map((b: any) => ({ ...b, text: trimDocText(b?.text) }));
      const cappedTables = (Array.isArray(doclingOutput.tables)
        ? doclingOutput.tables.slice(0, MAX_STORED_TABLES)
        : []).map((t: any) => ({
          ...t,
          rows: Array.isArray(t?.rows)
            ? t.rows.map((row: any) => Array.isArray(row) ? row.map((cell: any) => trimDocText(cell)) : row)
            : t?.rows,
        }));
      const cappedFields = Array.isArray(doclingOutput.fields)
        ? doclingOutput.fields.slice(0, MAX_STORED_FIELDS)
        : [];
      const cappedWarnings = Array.isArray((doclingOutput as any).warnings)
        ? (doclingOutput as any).warnings.slice(0, MAX_STORED_WARNINGS)
        : [];

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
        table_count: rawTableCount,
        field_count: rawFieldCount,
        text_block_count: rawBlockCount,
        pdf_metadata_page_count: pdfMetadataPageCount,
        has_content: !!(
          doclingOutput.full_text ||
          rawTableCount > 0 ||
          rawFieldCount > 0
        ),
        extraction_timestamp: new Date().toISOString(),
        text_truncated: typeof doclingOutput.full_text === "string" && doclingOutput.full_text.length > MAX_STORED_TEXT_CHARS,
        blocks_truncated: rawBlockCount > MAX_STORED_BLOCKS,
        whole_document_llm_compact_present: wholeDocumentCompact != null,
      };
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
        warnings: cappedWarnings,
        stage: "parse",
      });

      // Persistence object built explicitly from capped fields — never by
      // spreading doclingOutput, which silently carries unknown heavy arrays
      // (and an uncapped `markdown` duplicate of full_text) into JSONB and
      // forces a second full serialization of the parser output.
      // `raw_response` is only kept when the adapter explicitly recorded that
      // STORE_FULL_AZURE_RAW_RESPONSE was enabled.
      const shouldPersistFullRaw =
        parserOutputMetadata.raw_response_stored === true &&
        (doclingOutput as any).raw_response != null;
      const persistedLayout: Record<string, unknown> = {
        extraction_method: extractionMethod,
        full_text: cappedFullText,
        markdown: cappedMarkdown,
        page_count: doclingOutput.page_count ?? null,
        pages: cappedPages,
        text_blocks: cappedBlocks,
        tables: cappedTables,
        fields: cappedFields,
        warnings: cappedWarnings,
        raw_response: shouldPersistFullRaw ? (doclingOutput as any).raw_response : null,
        raw_response_summary: (doclingOutput as any).raw_response_summary ?? null,
        ...(wholeDocumentCompact
          ? { [PERSISTED_COMPACT_DOCUMENT_KEY]: wholeDocumentCompact }
          : {}),
        _metadata: {
          ...extractionMetadata,
          ...parserPipeline,
          pipeline: parserPipeline,
          full_text_chars: fullTextChars,
          text_block_count: rawBlockCount,
          table_count: rawTableCount,
          page_count: doclingOutput.page_count ?? cappedPages.length,
          persisted_at: new Date().toISOString(),
        },
      };

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
          warnings: cappedWarnings,
          doclingRaw: persistedLayout,
        });
        await stage?.fail(errorCode, message, { outcome: "terminal_failure", pageCount: doclingOutput.page_count ?? undefined });
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
          docling_raw: persistedLayout,
          azure_raw_response: persistedLayout,
          extraction_method: extractionMethod,
          parsed_data: [],
          row_count: (doclingOutput.tables ?? []).reduce(
            (n: number, t: any) => n + (t.rows?.length ?? 0),
            0,
          ),
          processing_completed_at: new Date().toISOString(),
          ...canonicalLayoutV3Update,
        },
      );

      if (updateError) {
        throw new Error(`Failed to store extraction results: ${updateError.message}`);
      }

      console.log(
        `[parse-document-azure] OK file_id=${file_id} method=${extractionMethod} ` +
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

      await stage?.complete({
        outcome: "completed",
        pageCount: doclingOutput.page_count ?? undefined,
        providerCalls: 1,
      });

      // Deliberately small response: the full layout is already persisted in
      // uploaded_files.docling_raw. Returning it here forced a second multi-MB
      // JSON serialization after the DB write had succeeded — the final
      // allocation that pushed large leases over the Edge Function memory
      // limit (546) and made the worker believe a successful parse failed.
      return jsonResponse({
        ok: true,
        error: false,
        file_id,
        processing_status: "pdf_parsed",
        extraction_method: extractionMethod,
        file_format: mimeType,
        page_count: doclingOutput.page_count,
        parser_status: parserStatus,
        full_text_chars: fullTextChars,
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
      });
    } catch (extractionError) {
      console.error(
        `[parse-document-azure] Extraction failed for ${file_id}:`,
        extractionError.message,
      );

      const errMsg = String(extractionError.message ?? extractionError);
      const isOcrError = /azure document intelligence|document intelligence|ocr (failed|required)|No parser backend/i.test(errMsg);
      const isProviderMissing = /No parser backend|AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT|AZURE_DOCUMENT_INTELLIGENCE_KEY/i.test(errMsg);

      const parseErrorCode = isProviderMissing ? "PARSER_PROVIDER_UNAVAILABLE" : (isOcrError ? "OCR_FAILED" : "PDF_PARSING_FAILED");
      await persistBlockedParse({
        parserStatus: isOcrError ? PARSER_STATUSES.OCR_FAILED : PARSER_STATUSES.FAILED,
        errorCode: parseErrorCode,
        message: errMsg,
        fullTextChars: 0,
        pageCount: null,
        providerUsed: isOcrError ? "azure_document_intelligence" : null,
        warnings: [errMsg],
      });
      await stage?.fail(parseErrorCode, errMsg, { outcome: "terminal_failure" });

      throw extractionError;
    }
  } catch (err) {
    console.error("[parse-document-azure] Error:", err.message);
    const errMsg = String(err.message ?? "");
    // Auth failures get a clean 401 so the worker maps them to DOWNSTREAM_AUTH_FAILED
    // instead of the generic DOWNSTREAM_FUNCTION_FAILED (400).
    const isAuthError = /unauthorized|missing authorization|invalid token|auth failed/i.test(errMsg);
    const isOcrError = /azure document intelligence|document intelligence|ocr (failed|required)|No parser backend/i.test(errMsg);
    const isProviderMissing = /No parser backend|AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT|AZURE_DOCUMENT_INTELLIGENCE_KEY/i.test(errMsg);
    const isUnsupportedProvider = /Unsupported extraction provider/i.test(errMsg);
    const outerErrorCode = isAuthError
      ? "UNAUTHORIZED_INTERNAL_PARSE_CALL"
      : isUnsupportedProvider
        ? "UNSUPPORTED_EXTRACTION_PROVIDER"
        : isProviderMissing
          ? "PARSER_PROVIDER_UNAVAILABLE"
          : isOcrError
            ? "OCR_FAILED"
            : "PDF_PARSING_FAILED";
    // Idempotent with the inner catch's stage.fail() above when this error
    // was re-thrown from there (same status "failed" -> safe no-op); this
    // is the only path for errors that occur BEFORE the inner try (auth,
    // status-transition failures) or truly unexpected exceptions.
    await stage?.fail(outerErrorCode, errMsg, { outcome: "terminal_failure" });
    return jsonResponse(
      {
        ok: false,
        error: true,
        message: errMsg,
        error_code: outerErrorCode,
      },
      isAuthError ? 401 : 400,
    );
  } finally {
    await stage?.ensureSettled();
  }
});

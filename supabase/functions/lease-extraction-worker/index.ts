// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";
import { setFailed, setStatus } from "../_shared/pipeline-status.ts";
import { MIN_LEASE_TEXT_CHARS } from "../_shared/extraction/pipeline-contract.ts";
import { uploadedFileRowHasMeaningfulValues } from "../_shared/extraction/payload-guard.ts";
import { enqueueEnrichmentJob } from "../_shared/extraction/enrichment-dispatch.ts";
import { getEnrichBoundedStageMode } from "../_shared/extraction/enrich-bounded-stage/feature-mode.ts";
import { enqueueBoundedEnrichStage } from "../_shared/extraction/enrich-bounded-stage/dispatch.ts";
import { completeBoundedEnrichStage } from "../_shared/extraction/enrich-bounded-stage/completion.ts";
import { firstEnrichBoundedStage, isEnrichBoundedStageName } from "../_shared/extraction/enrich-bounded-stage/stage-sequence.ts";
import {
  monolithicEnrichGuardReasons,
  normalizeEnrichInputSize,
  shouldUseBoundedEnrich,
} from "../_shared/extraction/enrich-monolithic-guard.ts";
import { resolveExtractionRunId } from "../_shared/extraction/provenance/recorder.ts";
import { getLeaseDocumentPackageMode } from "../_shared/extraction/document-package/feature-mode.ts";
import { getLeaseFinancialScheduleMode } from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";
import { classifyEnrichmentFailure, persistEnrichmentTerminalState } from "../_shared/extraction/enrichment-terminal-state.ts";
import {
  buildInternalFunctionHeaders,
  classifyDownstreamError,
  getMissingWorkerConfig,
  isAuthorizedWorkerCall,
  UNAUTHORIZED_WORKER_RESPONSE,
} from "./auth.ts";
import { parseDocument } from "../_shared/extraction/parser.ts";
import {
  buildPipelineMetadata,
  buildBlockedReviewPayload,
  PARSER_STATUSES,
  REVIEW_STATUSES,
  parserStatusForTextLength,
  countTextChars,
  mergePipelineIntoNormalizedOutput,
} from "../_shared/extraction/pipeline-contract.ts";
import { withExtractionStage } from "../_shared/extraction/provenance/recorder.ts";
import { isLeaseModuleType } from "../_shared/extraction/lease-module.ts";
import {
  LEASE_WORKER_BOUNDED_ENRICH_STAGE_TIMEOUT_MS,
  LEASE_WORKER_CHAINED_NORMALIZE_TIMEOUT_MS,
  LEASE_WORKER_ENRICH_TIMEOUT_MS,
  LEASE_WORKER_NORMALIZE_ACTIVE_GRACE_MS,
  LEASE_WORKER_NORMALIZE_RETRY_DELAY_MS,
  LEASE_WORKER_NORMALIZE_TIMEOUT_MS,
  LEASE_WORKER_PARSE_TIMEOUT_MS,
} from "../_shared/extraction/edge-runtime-budgets.ts";

const WORKER_NAME = "lease-extraction-worker";

async function readDurableEnrichInputSize(supabaseAdmin: any, fileId: string) {
  const projected = await supabaseAdmin
    .from("uploaded_files")
    .select(
      "metadata_full_text_chars:docling_raw->_metadata->>full_text_chars, " +
      "metadata_page_count:docling_raw->_metadata->>page_count, " +
      "metadata_text_block_count:docling_raw->_metadata->>text_block_count, " +
      "raw_page_count:docling_raw->>page_count",
    )
    .eq("id", fileId)
    .maybeSingle();

  let fullTextChars = Number(projected.data?.metadata_full_text_chars ?? 0) || 0;
  if (!fullTextChars) {
    const textOnly = await supabaseAdmin
      .from("uploaded_files")
      .select("raw_full_text:docling_raw->>full_text")
      .eq("id", fileId)
      .maybeSingle();
    fullTextChars = String(textOnly.data?.raw_full_text || "").length;
  }

  return normalizeEnrichInputSize({
    fullTextChars,
    pageCount: Number(projected.data?.metadata_page_count ?? projected.data?.raw_page_count ?? 0) || 0,
    textBlockCount: Number(projected.data?.metadata_text_block_count ?? 0) || 0,
  });
}

async function runParseStageInline(
  supabaseAdmin: any,
  fileId: string,
  orgId: string,
  jobId: string,
  generationId: string | null,
  extractionRunId: string | null,
  attempt: number,
  fileRecord: any,
  logger: any,
): Promise<{ ok: boolean; error?: string; error_code?: string; data?: any; status?: number }> {
  const functionStartedAt = new Date().toISOString();
  let stage: any = null;

  if (generationId) {
    stage = await withExtractionStage(supabaseAdmin, {
      orgId,
      uploadedFileId: fileId,
      generationId: generationId,
      extractionRunId: extractionRunId ?? null,
      pipelineJobId: jobId,
      stage: "parse",
      attempt: Number(attempt) || 1,
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
      fileId,
      fileName: fileRecord.file_name ?? "document",
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
    const { error: blockedStatusError } = await setStatus(supabaseAdmin, fileId, "failed", {
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
    // The caller (parserFailureAlreadyPersisted) assumes this write already
    // landed and only fails the pipeline_jobs row, not uploaded_files -- an
    // unchecked failure here previously left the file stuck showing its
    // pre-failure status (e.g. "parsing") with no error_message while the
    // job was correctly marked failed. Fall back to the FSM-bypassing
    // setFailed(), same idiom already used by parkLeaseForManualReview below.
    if (blockedStatusError) {
      console.error(`[${WORKER_NAME}] persistBlockedParse: setStatus(failed) rejected for file_id=${fileId}:`, blockedStatusError.message ?? blockedStatusError);
      await setFailed(supabaseAdmin, fileId, args.message, "parse", 15);
    }
    return payload;
  };

  // Transition status → 'parsing'
  const { error: parsingStatusError } = await setStatus(supabaseAdmin, fileId, "parsing");
  if (parsingStatusError) {
    const errMsg = `Failed to transition file to parsing: ${parsingStatusError.message}`;
    if (stage) await stage.fail("PDF_PARSING_FAILED", errMsg, { outcome: "terminal_failure" });
    return { ok: false, error: errMsg, error_code: "PDF_PARSING_FAILED" };
  }
  await logger.event("parse", "started", {
    file_size_bytes: Number(fileRecord.file_size || 0) || null,
    mime_type: fileRecord.mime_type || "application/octet-stream",
  });

  try {
    // Prefer the canonical storage_path column (set directly by
    // upload-handler from the same variable it uploaded with -- no string
    // parsing); fall back to parsing file_url only for rows that predate
    // that column existing. Mirrors parse-document-azure/index.ts, which
    // this inline path duplicates rather than calls.
    const storagePath = fileRecord.storage_path || fileRecord.file_url.replace(
      /^.*\/storage\/v1\/object\/public\/financial-uploads\//,
      "",
    );

    // Confirm the source bytes actually exist in storage before asking
    // Azure to fetch them -- otherwise a file whose upload never durably
    // landed surfaces as a confusing "document parser returned only N
    // readable characters" error (Azure OCR'ing a tiny storage-error
    // response body instead of the real PDF) rather than a clear,
    // immediate, actionable failure. Same guard as parse-document-azure/
    // index.ts; this inline path is a separate implementation and does not
    // inherit that fix automatically.
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
      const errMsg =
        `Source file is missing from storage (path="${storagePath}"). The upload did not durably ` +
        `complete, so there is nothing for Azure Document Intelligence to read.`;
      console.error(`[${WORKER_NAME}] ${errMsg}`, storageListError ?? "");
      const payload = await persistBlockedParse({
        parserStatus: PARSER_STATUSES.FAILED,
        errorCode: "SOURCE_FILE_MISSING_FROM_STORAGE",
        message: errMsg,
        fullTextChars: 0,
        pageCount: null,
        providerUsed: "azure_document_intelligence",
        warnings: [errMsg],
      });
      if (stage) await stage.fail("SOURCE_FILE_MISSING_FROM_STORAGE", errMsg, { outcome: "terminal_failure" });
      return {
        ok: false,
        error: errMsg,
        error_code: "SOURCE_FILE_MISSING_FROM_STORAGE",
        data: { parser_status: PARSER_STATUSES.FAILED, processing_status: "failed", ui_review_payload: payload },
      };
    }

    const { data: signedUrlData, error: signedUrlError } = await supabaseAdmin
      .storage
      .from("financial-uploads")
      .createSignedUrl(storagePath, 60 * 60);

    if (signedUrlError) {
      const errMsg = `Failed to sign URL: ${signedUrlError.message}`;
      await persistBlockedParse({
        parserStatus: PARSER_STATUSES.FAILED,
        errorCode: "PDF_PARSING_FAILED",
        message: errMsg,
        warnings: [errMsg],
      });
      if (stage) await stage.fail("PDF_PARSING_FAILED", errMsg, { outcome: "terminal_failure" });
      return { ok: false, error: errMsg, error_code: "PDF_PARSING_FAILED" };
    }

    // Call parser directly
    const doclingOutput = await parseDocument(null, fileRecord.file_name ?? "document", fileRecord.mime_type ?? "application/pdf", {
      fileUrl: signedUrlData.signedUrl,
      providerOverride: "azure_document_intelligence", // Force Azure Document Intelligence
    });

    const fullTextChars = countTextChars(doclingOutput.full_text);
    const parserStatus = parserStatusForTextLength(fullTextChars);

    const extractionMethod = doclingOutput.extraction_method || "azure_layout";

    const extractionMetadata = {
      text_block_count: (doclingOutput.text_blocks ?? []).length,
      table_count: (doclingOutput.tables ?? []).length,
      field_count: (doclingOutput.fields ?? []).length,
      has_content: fullTextChars > 0,
    };

    const parserPipeline = buildPipelineMetadata({
      parser_status: parserStatus,
      review_status: parserStatus === PARSER_STATUSES.COMPLETED ? REVIEW_STATUSES.UNREVIEWED : REVIEW_STATUSES.BLOCKED,
      started_at: functionStartedAt,
      finished_at: new Date().toISOString(),
      full_text_chars: fullTextChars,
      page_count: doclingOutput.page_count ?? null,
      provider_used: extractionMethod,
      docling_raw_present: true,
      warnings: doclingOutput.warnings ?? [],
      stage: "parse",
    });

    const persistedLayout: Record<string, unknown> = {
      extraction_method: extractionMethod,
      full_text: doclingOutput.full_text ?? "",
      markdown: doclingOutput.markdown ?? "",
      page_count: doclingOutput.page_count ?? null,
      pages: doclingOutput.pages ?? [],
      text_blocks: doclingOutput.text_blocks ?? [],
      tables: doclingOutput.tables ?? [],
      fields: doclingOutput.fields ?? [],
      warnings: doclingOutput.warnings ?? [],
      raw_response: (doclingOutput as any).raw_response ?? null,
      raw_response_summary: (doclingOutput as any).raw_response_summary ?? null,
      _metadata: {
        ...extractionMetadata,
        ...parserPipeline,
        pipeline: parserPipeline,
        full_text_chars: fullTextChars,
        text_block_count: extractionMetadata.text_block_count,
        table_count: extractionMetadata.table_count,
        page_count: doclingOutput.page_count ?? (doclingOutput.pages ?? []).length,
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
        warnings: doclingOutput.warnings ?? [],
        doclingRaw: persistedLayout,
      });
      if (stage) await stage.fail(errorCode, message, { outcome: "terminal_failure", pageCount: doclingOutput.page_count ?? undefined });
      return {
        ok: false,
        error: message,
        error_code: errorCode,
        data: {
          parser_status: parserStatus,
          processing_status: "failed",
          ui_review_payload: payload,
        }
      };
    }

    const { error: updateError } = await setStatus(
      supabaseAdmin,
      fileId,
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
      },
    );

    if (updateError) {
      throw new Error(`Failed to store extraction results: ${updateError.message}`);
    }

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

    if (stage) {
      await stage.complete({
        outcome: "completed",
        pageCount: doclingOutput.page_count ?? undefined,
        providerCalls: 1,
      });
    }

    return {
      ok: true,
      error: false,
      file_id: fileId,
      processing_status: "pdf_parsed",
      extraction_method: extractionMethod,
      page_count: doclingOutput.page_count,
      parser_status: parserStatus,
      full_text_chars: fullTextChars,
    };
  } catch (extractionError: any) {
    const errMsg = String(extractionError.message ?? extractionError);
    await persistBlockedParse({
      parserStatus: PARSER_STATUSES.FAILED,
      errorCode: "PDF_PARSING_FAILED",
      message: errMsg,
      fullTextChars: 0,
      pageCount: null,
      providerUsed: "azure_document_intelligence",
      warnings: [errMsg],
    });
    if (stage) await stage.fail("PDF_PARSING_FAILED", errMsg, { outcome: "terminal_failure" });
    return { ok: false, error: errMsg, error_code: "PDF_PARSING_FAILED" };
  } finally {
    if (stage) await stage.ensureSettled();
  }
}

const PARSE_TIMEOUT_MS = LEASE_WORKER_PARSE_TIMEOUT_MS;
// Supabase Edge Functions have a 150s hard wall (see ingest-file/index.ts's
// callEdgeFunction doc comment) -- when this worker runs parse and normalize
// sequentially in the SAME invocation, the chained normalize timeout must leave
// enough budget for parse + response overhead so this client-side AbortSignal
// fires before the platform hard-kills the invocation.
const CHAINED_NORMALIZE_TIMEOUT_MS = LEASE_WORKER_CHAINED_NORMALIZE_TIMEOUT_MS;
// Jobs that start directly at normalize get a fresh invocation budget.
const NORMALIZE_TIMEOUT_MS = LEASE_WORKER_NORMALIZE_TIMEOUT_MS;
const NORMALIZE_RETRY_DELAY_MS = LEASE_WORKER_NORMALIZE_RETRY_DELAY_MS;
const NORMALIZE_ACTIVE_GRACE_MS = LEASE_WORKER_NORMALIZE_ACTIVE_GRACE_MS;
// The enrich stage is dispatched as its own separate pipeline job / worker
// invocation, so it gets its own fresh invocation budget.
const ENRICH_TIMEOUT_MS = LEASE_WORKER_ENRICH_TIMEOUT_MS;
// Bounded Per-Domain Enrich Refactor: each of the 10 bounded stages does a
// deliberately small SLICE of what the monolithic "enrich" stage above did
// all at once (that's the whole point -- see docs/lease-extraction-architecture-audit-2026-07-29.md
// and the plan), so none of them should need anywhere near ENRICH_TIMEOUT_MS's
// budget. One shared constant for all 10 stages, not 10 separate ones --
// nothing yet distinguishes their real costs (that's what the telemetry this
// refactor adds is for); split further once real numbers justify it.
const BOUNDED_ENRICH_STAGE_TIMEOUT_MS = LEASE_WORKER_BOUNDED_ENRICH_STAGE_TIMEOUT_MS;

// Azure staging P0: durable-state reconciliation must distinguish "confirmed
// absent" from "couldn't determine" — a reconciliation read failing under the
// same resource pressure that caused the original transport failure must
// never be silently treated as proof the durable data is missing. Every
// caller below switches on this exhaustively; there is no boolean collapse.
type DurabilityState = "durable" | "not_durable" | "unknown";

/**
 * Run a Supabase query once; on a query-level error, run it exactly once
 * more before giving up. A single retry is enough to distinguish "the read
 * itself is failing under resource pressure" (→ unknown, bounded) from a
 * durable, repeatable error — it is not a general-purpose retry policy.
 */
async function selectWithRetry<T extends { data: any; error: any }>(queryFn: () => Promise<T>): Promise<T> {
  const first = await queryFn();
  if (!first.error) return first;
  return await queryFn();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/**
 * Fresh read of pipeline_jobs.cancel_requested_at — never trust a
 * previously-fetched `job` object for this check once any long-running call
 * (parse can take up to 140s, normalize up to 240s) may have happened since
 * it was read; cancel-upload can set the flag at any point mid-flight.
 */
async function isCancelRequested(supabaseAdmin: any, jobId: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("pipeline_jobs")
    .select("cancel_requested_at")
    .eq("id", jobId)
    .maybeSingle();
  return !!data?.cancel_requested_at;
}

/**
 * Stop the job in response to a soft-cancel request: mark both
 * pipeline_jobs and uploaded_files 'cancelled' (the FSM allows this edge
 * from every non-terminal status, mirroring 'failed'), log it, and never
 * dispatch the next stage. docling_raw/normalized_output/ui_review_payload
 * are left exactly as they were — nothing is deleted, preserving the audit
 * trail for a post-confirmation cancel.
 */
async function stopForCancellation(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  logger: any,
  checkpoint: string,
): Promise<Response> {
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("pipeline_jobs")
    .update({ status: "cancelled", completed_at: now, updated_at: now })
    .eq("id", job.id);

  const { error: cancelStatusError } = await setStatus(supabaseAdmin, fileId, "cancelled", {
    processing_status: "cancelled",
  });
  if (cancelStatusError) {
    console.warn(
      `[${WORKER_NAME}] could not transition uploaded_files to cancelled for file_id=${fileId}:`,
      cancelStatusError.message,
    );
  }

  console.log(`[${WORKER_NAME}] job=${job.id} file_id=${fileId} cancelled at checkpoint=${checkpoint}`);
  await logger.event("cancel", "stopped", {
    provider: "lease-extraction-worker",
    metadata: { job_id: job.id, checkpoint },
  });

  return jsonResponse({
    error: false,
    job_id: job.id,
    file_id: fileId,
    status: "cancelled",
    stage: job.stage,
    cancelled: true,
    checkpoint,
  });
}

async function callInternalFunction(functionName: string, body: Record<string, unknown>, orgId: string, timeoutMs: number) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  let response: Response;
  try {
    response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: buildInternalFunctionHeaders(orgId),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (fetchErr: any) {
    const isTimeout =
      fetchErr?.name === "TimeoutError" ||
      fetchErr?.name === "AbortError" ||
      String(fetchErr?.message ?? "").toLowerCase().includes("timeout");
    console.error(
      `[${WORKER_NAME}] ${functionName} ${isTimeout ? "timed out" : "network error"}: ${fetchErr?.message}`,
    );
    return {
      ok: false,
      status: isTimeout ? 504 : 500,
      data: {},
      error_code: isTimeout ? "STAGE_TIMEOUT" : "NETWORK_ERROR",
      retryable: isTimeout,
      error: isTimeout
        ? `${functionName} timed out after ${timeoutMs / 1000}s — document may be too large or the parsing service is slow`
        : `Network error calling ${functionName}: ${fetchErr?.message}`,
    };
  }

  const text = await response.text().catch(() => "");
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw_response: text.slice(0, 500) };
  }

  if (!response.ok) {
    const classified = classifyDownstreamError(response.status);
    const safeError =
      classified.error_code === "DOWNSTREAM_AUTH_FAILED"
        ? `${functionName} returned ${response.status}`
        : data?.message || data?.error_details || data?.error_code || text.slice(0, 500) || `HTTP ${response.status}`;
    // The downstream function (normalize-pdf-output, parse-document-azure,
    // etc.) already returns its own specific error_code in the JSON body
    // (e.g. NO_NORMALIZED_OUTPUT, INVALID_STATUS_FOR_ENRICH, FILE_NOT_FOUND).
    // Previously this was always discarded in favor of the coarse
    // HTTP-status-based classification below, so every real failure surfaced
    // to pipeline_jobs/uploaded_files/the UI as an undifferentiated
    // DOWNSTREAM_FUNCTION_FAILED regardless of cause. Prefer the specific
    // code when the downstream function supplied one; the coarse
    // classification remains the fallback for transport-level failures
    // (auth, timeouts, unparseable responses) that have no such code.
    const downstreamErrorCode = typeof data?.error_code === "string" && data.error_code ? data.error_code : null;

    return {
      ok: false,
      status: response.status,
      data,
      error_code: downstreamErrorCode ?? classified.error_code,
      retryable: classified.retryable,
      error: safeError,
    };
  }

  return { ok: true, status: response.status, data, error: "" };
}


async function failJob(supabaseAdmin: any, job: any, errorCode: string, errorMessage: string) {
  await supabaseAdmin
    .from("pipeline_jobs")
    .update({
      status: "failed",
      error_code: errorCode,
      error_message: String(errorMessage || "Lease extraction job failed").slice(0, 1000),
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", job.id);
}

function isReviewReadyEnrichmentTransportFailure(errorCode: string, message: string, status?: number | null): boolean {
  const code = String(errorCode || "").toUpperCase();
  const text = String(message || "").toLowerCase();
  // DOWNSTREAM_FUNCTION_FAILED (and its "not enough compute resources"
  // wording, e.g. HTTP 546) used to be included here, on the theory that
  // enrichment is a "nice to have" pass over an already-good minimal
  // payload. In practice, DOWNSTREAM_FUNCTION_FAILED means the downstream
  // normalize-pdf-output invocation was killed/crashed before it could run
  // at all -- the rich enrichment build (Lease Truth Assembly reconciliation,
  // workflow abstraction, evidence resolution) never happened, not just one
  // optional sub-step of it. Treating that as a "review ready, minor warning"
  // outcome let review_status silently show completed_with_warnings with a
  // fabricated "some source page references could not be linked" message on
  // a document that was still missing many core fields (e.g. Craven Wings,
  // 2026-07-26: monthly_rent, commencement_date, and others never resolved).
  // A genuine, incomplete resource/process crash must reach the real
  // enrichment-failure path below (failJob + enrichment_status: "failed"),
  // which is what evaluate_lease_extraction_readiness()'s ENRICHMENT_FAILED
  // check actually looks for. STAGE_TIMEOUT/504/"timed out" are left as
  // review-ready transport hiccups -- no incident evidence implicates them.
  return (
    code === "STAGE_TIMEOUT" ||
    Number(status) === 504 ||
    text.includes("timed out")
  );
}

async function completeEnrichmentWithWarning(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  orgId: string,
  errorCode: string,
  message: string,
  status?: number | null,
  originalMessage?: string | null,
) {
  await supabaseAdmin
    .from("pipeline_jobs")
    .update({
      status: "completed",
      error_code: null,
      error_message: null,
      completed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      metadata: {
        ...(job.metadata || {}),
        enrich_completed_with_warning: true,
        enrich_warning_code: errorCode,
        enrich_warning_message: String(message || "Evidence enrichment did not complete").slice(0, 1000),
        enrich_warning_status: status ?? null,
        // The reviewer-facing `message` above may be a friendlier summary of
        // `originalMessage` -- never let the real downstream error body be
        // discarded outright; a future root-cause pass must be able to read
        // exactly what the downstream call actually returned.
        enrich_original_error: String(originalMessage ?? message ?? "").slice(0, 1000),
      },
    })
    .eq("id", job.id);

  // Reliability Phase R1: a single generation-fenced compare-and-set
  // replaces the old re-fetch + conditional update + silent no-op-on-
  // mismatch. Real column lands as "completed" (this path is always
  // review-ready); the friendlier "completed_with_warnings" string is
  // preserved exactly as before, but only in the ui_review_payload mirror.
  const persistResult = await persistEnrichmentTerminalState({
    supabaseAdmin,
    organizationId: orgId,
    fileId,
    generationId: job.generation_id,
    status: "completed",
    uiReviewPayloadStatus: "completed_with_warnings",
    errorCode,
    errorMessage: String(message || "Evidence enrichment did not complete").slice(0, 1000),
    classification: "transport_error",
    retryable: true,
    stage: "enrich",
    logger: createLogger(supabaseAdmin, fileId, orgId),
  });

  if (persistResult.persisted) {
    try {
      const { error: finalizeRpcError } = await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
        p_org_id: orgId,
        p_uploaded_file_id: fileId,
        p_generation_id: job.generation_id,
        p_package_mode: getLeaseDocumentPackageMode(),
        p_financial_mode: getLeaseFinancialScheduleMode(),
      });
      // supabase-js resolves an RPC-level error (e.g. a parameter mismatch
      // against the currently-deployed function signature) as {error} rather
      // than throwing -- this used to be silently discarded, which is
      // exactly why review_readiness/review_handoff can go stale and stay
      // stale with no visible trace anywhere. Log it loudly; this does not
      // by itself fix a schema/migration mismatch, but it makes one
      // immediately diagnosable instead of requiring forensic reconstruction.
      if (finalizeRpcError) {
        console.error(`[${WORKER_NAME}] finalize_lease_extraction_for_review RPC returned an error (review_readiness NOT updated) file_id=${fileId}:`, finalizeRpcError.message);
      }
    } catch (finalizeError: any) {
      console.error(`[${WORKER_NAME}] finalize_lease_extraction_for_review call threw file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
    }
  }
}

const LEASE_MANUAL_REVIEW_FIELDS = [
  "tenant_name", "landlord_name", "property_name", "property_address", "unit_number",
  "start_date", "end_date", "monthly_rent", "annual_rent", "lease_term_months",
  "square_footage", "lease_type", "security_deposit", "escalation_rate",
  "renewal_options", "ti_allowance", "free_rent_months", "notes",
];

/**
 * Reset a job back to a genuinely retryable state after reconciliation is
 * inconclusive or a transport/runtime failure confirms no durable output yet.
 * Never touches uploaded_files and never counts as a terminal outcome. `attempt`
 * was already incremented for this invocation at claim time, so leaving it alone
 * correctly consumes one unit of the existing max_attempts budget.
 */
async function resetJobForRetryableReconciliation(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  reason: string,
  opts: { delayMs?: number; metadata?: Record<string, unknown> } = {},
) {
  const now = new Date();
  const patch: Record<string, unknown> = {
    status: "queued",
    error_code: null,
    error_message: null,
    updated_at: now.toISOString(),
  };
  if (opts.delayMs && opts.delayMs > 0) {
    patch.available_at = new Date(now.getTime() + opts.delayMs).toISOString();
  }
  if (opts.metadata) {
    patch.metadata = {
      ...(job.metadata || {}),
      ...opts.metadata,
      retry_requeue_reason: reason,
      retry_requeued_at: now.toISOString(),
    };
  }

  await supabaseAdmin
    .from("pipeline_jobs")
    .update(patch)
    .eq("id", job.id);
  console.warn(
    `[${WORKER_NAME}] retryable_requeue file_id=${fileId} job=${job.id} ` +
    `requeueing without touching uploaded_files (${reason})`,
  );
}

async function queueNormalizeTransportRetry(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  logger: any,
  normalizeResult: any,
  reason: string,
): Promise<Response> {
  await markNormalizePending(supabaseAdmin, fileId, job.org_id || job.input?.org_id, normalizeResult, reason);
  await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, reason, {
    delayMs: NORMALIZE_RETRY_DELAY_MS,
    metadata: {
      normalize_pending: true,
      normalize_transport_outcome: "unknown",
      retry_stage: "normalize",
      retry_transport_status: normalizeResult?.status ?? null,
      retry_transport_error_code: normalizeResult?.error_code ?? normalizeResult?.data?.error_code ?? null,
      retry_transport_message: String(normalizeResult?.error || "").slice(0, 500),
      retry_delay_ms: NORMALIZE_RETRY_DELAY_MS,
    },
  });
  await logger.event("normalize", "retry_queued", {
    provider: "lease-extraction-worker",
    metadata: {
      job_id: job.id,
      reason,
      transport_status: normalizeResult?.status ?? null,
      retry_delay_ms: NORMALIZE_RETRY_DELAY_MS,
    },
  });
  return jsonResponse({
    error: true,
    error_code: "NORMALIZE_RETRY_QUEUED",
    job_id: job.id,
    stage: "normalize",
    retryable: true,
    retry_delay_ms: NORMALIZE_RETRY_DELAY_MS,
    message: "Normalization hit a transport/runtime timeout before durable output was confirmed; job requeued for retry.",
  }, 200);
}

async function markNormalizePending(
  supabaseAdmin: any,
  fileId: string,
  orgId: string,
  normalizeResult: any,
  reason: string,
) {
  await supabaseAdmin
    .from("uploaded_files")
    .update({
      processing_status: "normalize_pending",
      failed_step: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", fileId)
    .eq("org_id", orgId);
}

function isPendingNormalizeReconciliation(metadata: any): boolean {
  return Boolean(metadata?.normalize_pending === true || metadata?.retry_stage === "normalize");
}

function buildFactLedgerResumeFromMetadata(metadata: any): Record<string, unknown> | null {
  const progress = metadata?.openai_fact_ledger_progress;
  if (!progress || typeof progress !== "object") return null;
  const nextChunkIndex = Number(progress.nextChunkIndex ?? progress.next_chunk_index ?? progress.chunksProcessed ?? 0);
  const partialFacts = Array.isArray(progress.partialFacts) ? progress.partialFacts : [];
  if ((!Number.isFinite(nextChunkIndex) || nextChunkIndex <= 0) && partialFacts.length === 0) return null;
  return {
    startChunkIndex: Number.isFinite(nextChunkIndex) && nextChunkIndex > 0 ? Math.floor(nextChunkIndex) : 0,
    priorFacts: partialFacts,
    chunksProcessed: progress.chunksProcessed,
    chunksSucceeded: progress.chunksSucceeded,
    chunksFailed: progress.chunksFailed,
    failedChunkIndexes: progress.failedChunkIndexes,
  };
}

function timestampIsFresh(value: unknown, graceMs = NORMALIZE_ACTIVE_GRACE_MS): boolean {
  const ts = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ts) && Date.now() - ts < graceMs;
}

async function readNormalizeActivity(supabaseAdmin: any, fileId: string, orgId: string, job: any) {
  const { data: fileRow } = await supabaseAdmin
    .from("uploaded_files")
    .select("status, processing_status, updated_at")
    .eq("id", fileId)
    .eq("org_id", orgId)
    .maybeSingle();
  const progress = job?.metadata?.openai_fact_ledger_progress;
  const latestProgressAt = progress && typeof progress === "object" ? (progress as any).updated_at : null;
  const latestActivityAt = timestampIsFresh(latestProgressAt) ? latestProgressAt : fileRow?.updated_at;
  return {
    fileStatus: fileRow?.status ?? null,
    processingStatus: fileRow?.processing_status ?? null,
    latestActivityAt,
    active: fileRow?.status === "validating" && timestampIsFresh(latestActivityAt),
  };
}

async function resolvePendingNormalizeBeforeRun(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  orgId: string,
  logger: any,
): Promise<{ response: Response | null; factLedgerResume: Record<string, unknown> | null }> {
  if (!isPendingNormalizeReconciliation(job?.metadata)) {
    return { response: null, factLedgerResume: null };
  }

  const reconciled = await reconcileDurableNormalize(supabaseAdmin, fileId, orgId);
  if (reconciled.state === "durable") {
    await repairStaleReconciledState(
      supabaseAdmin,
      fileId,
      orgId,
      String(reconciled.status ?? "review_required"),
      String(reconciled.status ?? "review_required"),
    );
    await supabaseAdmin
      .from("pipeline_jobs")
      .update({
        status: "completed",
        error_code: null,
        error_message: null,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: {
          ...(job.metadata || {}),
          normalize_reconciled_from_pending: true,
          normalize_reconciled_at: new Date().toISOString(),
          reconciled_durable_status: reconciled.status,
        },
      })
      .eq("id", job.id);
    await logger.event("normalize", "reconciled", {
      provider: "lease-extraction-worker",
      metadata: { job_id: job.id, reason: "pending_timeout_durable_output_found", durable_status: reconciled.status },
    });
    return {
      response: jsonResponse({
        error: false,
        job_id: job.id,
        stage: "normalize",
        status: "completed",
        reconciled: true,
        durable_status: reconciled.status,
      }),
      factLedgerResume: null,
    };
  }

  if (reconciled.state === "unknown") {
    await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, "normalize_pending_reconciliation_unknown", {
      delayMs: NORMALIZE_RETRY_DELAY_MS,
      metadata: { normalize_pending: true, retry_stage: "normalize" },
    });
    await logger.event("normalize", "reconciliation_unknown", {
      provider: "lease-extraction-worker",
      metadata: { job_id: job.id, reason: "pending_timeout_reconciliation_unknown" },
    });
    return {
      response: jsonResponse({
        error: true,
        error_code: "RECONCILIATION_INCONCLUSIVE",
        job_id: job.id,
        stage: "normalize",
        retryable: true,
        message: "Could not determine durable normalize state after a pending timeout; reconciliation requeued.",
      }, 200),
      factLedgerResume: null,
    };
  }

  const activity = await readNormalizeActivity(supabaseAdmin, fileId, orgId, job);
  if (activity.active) {
    await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, "normalize_still_active", {
      delayMs: NORMALIZE_RETRY_DELAY_MS,
      metadata: { normalize_pending: true, retry_stage: "normalize", normalize_active_observed_at: activity.latestActivityAt },
    });
    await logger.event("normalize", "pending", {
      provider: "lease-extraction-worker",
      metadata: { job_id: job.id, reason: "normalize_still_active", latest_activity_at: activity.latestActivityAt },
    });
    return {
      response: jsonResponse({
        error: false,
        error_code: "NORMALIZE_PENDING",
        job_id: job.id,
        stage: "normalize",
        retryable: true,
        message: "Normalization is still active; reconciliation requeued without starting duplicate work.",
      }, 200),
      factLedgerResume: null,
    };
  }

  return { response: null, factLedgerResume: buildFactLedgerResumeFromMetadata(job.metadata) };
}
/**
 * Repair a row that reconciliation has just confirmed holds durable, valid
 * data but whose status/processing_status/failed_step/error_message were
 * left stale or contradictory by an earlier failed attempt (the exact
 * incident shape this patch fixes). This is a genuine repair, not merely
 * "avoid writing something worse" — it actively clears prior corruption.
 *
 * Prefers the existing setStatus() transition machinery (review_required →
 * pdf_parsed and failed → review_required/parsing are both already legal
 * transitions in ALLOWED_TRANSITIONS, so the common repair path needs no
 * FSM bypass). If the row's `status` already equals the target (a same-state
 * "transition" setStatus's FSM does not model), setStatus is skipped and a
 * direct, tenant-scoped update repairs only the sibling fields — status
 * itself is never written outside the FSM.
 */
async function repairStaleReconciledState(
  supabaseAdmin: any,
  fileId: string,
  orgId: string,
  targetStatus: string,
  targetProcessingStatus: string,
) {
  const { data: currentRow } = await supabaseAdmin
    .from("uploaded_files")
    .select("status")
    .eq("id", fileId)
    .eq("org_id", orgId)
    .maybeSingle();

  const currentStatus = currentRow?.status ?? null;

  if (currentStatus && currentStatus !== targetStatus) {
    const { error } = await setStatus(supabaseAdmin, fileId, targetStatus as any, {
      processing_status: targetProcessingStatus,
      failed_step: null,
      error_message: null,
    });
    if (!error) return;
    console.warn(
      `[${WORKER_NAME}] repairStaleReconciledState: setStatus(${currentStatus} -> ${targetStatus}) rejected for ` +
      `file_id=${fileId} (${error.message}); falling back to a direct sibling-field repair without changing status`,
    );
  }

  // Same-state (or setStatus rejected the transition): repair only the
  // sibling fields, scoped by both id and org_id, never touching `status`
  // outside setStatus's own FSM.
  await supabaseAdmin
    .from("uploaded_files")
    .update({
      processing_status: targetProcessingStatus,
      failed_step: null,
      error_message: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", fileId)
    .eq("org_id", orgId);
}

async function parkLeaseForManualReview(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  orgId: string,
  fileName: string,
  moduleType: string,
  documentSubtype: string,
  errorCode: string,
  reason: string,
  failedStage: "parse" | "normalize" = "parse",
): Promise<{ outcome: "resume_from_durable_parse" | "resume_from_durable_normalize" | "parked" | "reconciliation_unknown" }> {
  // Stage-aware, tri-state-aware guard. Checking reconcileDurableNormalize
  // for a PARSE-stage failure is the wrong signal (normalize hasn't run
  // yet) — this is the structural gap the Azure staging P0 incident traced
  // back to. On durable discovery this never fails the job: it repairs the
  // stale fields and signals the caller to resume the pipeline instead of
  // parking a genuinely successful parse/normalize as manual-review.
  const check = failedStage === "parse"
    ? await reconcileDurableParse(supabaseAdmin, fileId, orgId)
    : await reconcileDurableNormalize(supabaseAdmin, fileId, orgId);

  if (check.state === "durable") {
    console.log(
      `[${WORKER_NAME}] resume_from_durable_${failedStage} file_id=${fileId} status=${check.status} — ` +
      `repairing stale state and resuming instead of parking for manual review`,
    );
    const targetStatus = failedStage === "parse" ? "pdf_parsed" : (check.status ?? "review_required");
    const targetProcessingStatus = failedStage === "parse" ? "pdf_parsed" : String(check.status ?? "review_required");
    await repairStaleReconciledState(supabaseAdmin, fileId, orgId, targetStatus, targetProcessingStatus);
    return { outcome: failedStage === "parse" ? "resume_from_durable_parse" : "resume_from_durable_normalize" };
  }

  if (check.state === "unknown") {
    await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, `${failedStage}_guard`);
    return { outcome: "reconciliation_unknown" };
  }

  // state === "not_durable": genuinely nothing durable exists yet — proceed
  // with the existing fallback-write behavior below.
  await failJob(supabaseAdmin, job, errorCode, reason);

  // normalize-pdf-output may have already written rich provider-failure
  // diagnostics (failure_classification / failure_http_status /
  // failure_provider_error_code / failure_request_id / failure_request_url —
  // see business-extraction-acceptance's evaluateExtractionAcceptance and
  // openai-fact-ledger/orchestrator.ts) into normalized_output BEFORE
  // returning its error response to this worker. The generic fallback
  // payload built below replaces normalized_output wholesale, which would
  // silently discard that diagnostic data at the exact moment it's most
  // needed (a genuinely failed extraction). Read it back and carry it
  // forward — a targeted JSON-path select, not the whole (potentially
  // multi-MB) normalized_output blob.
  let preservedOpenAIDiagnostics: Record<string, unknown> | null = null;
  try {
    const { data: diagRow } = await supabaseAdmin
      .from("uploaded_files")
      .select("diag:normalized_output->metadata->extractionDebug->openai_fact_ledger")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (diagRow?.diag && typeof diagRow.diag === "object") {
      preservedOpenAIDiagnostics = diagRow.diag as Record<string, unknown>;
    }
  } catch (diagReadError: any) {
    console.warn(
      `[${WORKER_NAME}] could not read prior openai_fact_ledger diagnostics before parking file_id=${fileId}:`,
      diagReadError?.message ?? diagReadError,
    );
  }

  const standardFields = LEASE_MANUAL_REVIEW_FIELDS.map((fieldKey) => ({
    id: `0:standard:${fieldKey}`,
    field_key: fieldKey,
    label: fieldKey.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
    value: null,
    original_value: null,
    field_type: fieldKey.includes("date") ? "date"
      : ["monthly_rent", "annual_rent", "square_footage", "lease_term_months", "ti_allowance", "free_rent_months"].includes(fieldKey) ? "number"
      : "string",
    required: ["tenant_name", "start_date", "end_date", "monthly_rent"].includes(fieldKey),
    is_standard: true,
    confidence: 0,
    source: "system",
    evidence: null,
    status: "missing",
    accepted: false,
    rejected: false,
    user_edit: null,
  }));

  const failureStatus = failedStage === "normalize" ? "normalize_failed_manual_review" : "parse_failed_manual_review";
  const payload = {
    schema_version: 2,
    file_id: fileId,
    file_name: fileName,
    module_type: moduleType,
    document_subtype: documentSubtype || "base_lease",
    extraction_method: "manual_review_fallback",
    pipeline_method: failureStatus,
    avg_confidence: 0,
    review_required: true,
    review_status: "pending",
    records: [{
      record_index: 0,
      row_index: 0,
      values: Object.fromEntries(standardFields.map((f) => [f.field_key, null])),
      fields: Object.fromEntries(standardFields.map((f) => [
        f.field_key,
        { value: null, confidence: 0, source: "system", evidence: null, status: "missing" },
      ])),
      standard_fields: standardFields,
      custom_fields: [],
      rejected_fields: [],
      missing_required: standardFields.filter((f) => f.required).map((f) => f.field_key),
      warnings: [reason],
      confidence: 0,
      notes: reason,
    }],
    global_warnings: [
      "Automatic document parsing failed. You can enter lease fields manually in Lease Review.",
      reason,
    ],
    warnings: [
      "Automatic document parsing failed. You can enter lease fields manually in Lease Review.",
      reason,
    ],
    validation_errors: [],
    metadata: {
      totalRecords: 1,
      avgConfidence: 0,
      manualReviewFallback: true,
      parse_failed: failedStage === "parse",
      normalize_failed: failedStage === "normalize",
      error_code: errorCode,
      error_message: reason,
      ...(preservedOpenAIDiagnostics ? { openai_fact_ledger_diagnostics: preservedOpenAIDiagnostics } : {}),
    },
    built_at: new Date().toISOString(),
  };

  const { error } = await setStatus(supabaseAdmin, fileId, "review_required", {
    review_required: true,
    review_status: "pending",
    processing_status: failureStatus,
    extraction_method: "manual_review_fallback",
    ui_review_payload: payload,
    normalized_output: {
      method: failureStatus,
      rows: [{}],
      warnings: payload.global_warnings,
      validationErrors: [],
      metadata: {
        ...payload.metadata,
        // Preserved verbatim, nested under metadata (matching the path
        // normalize-pdf-output itself writes to —
        // normalized_output.metadata.extractionDebug.openai_fact_ledger —
        // not a sibling of metadata) so a caller reading the normal path
        // finds these even though this fallback overwrote the row. See the
        // read above for why this can be non-null here.
        ...(preservedOpenAIDiagnostics
          ? { extractionDebug: { openai_fact_ledger: preservedOpenAIDiagnostics } }
          : {}),
      },
    },
    parsed_data: [{}],
    row_count: 1,
    valid_count: 0,
    error_count: 1,
    error_message: reason,
    failed_step: failedStage,
    processing_completed_at: new Date().toISOString(),
  });

  if (error && error.code !== "NO_ROW_UPDATED") {
    console.error(`[${WORKER_NAME}] parkLeaseForManualReview setStatus error:`, error.message);
    await setFailed(supabaseAdmin, fileId, reason, failedStage, failedStage === "normalize" ? 45 : 15);
  }

  return { outcome: "parked" };
}

async function failJobAndUpload(
  supabaseAdmin: any,
  job: any,
  fileId: string,
  errorCode: string,
  errorMessage: string,
  stage: string,
  progress: number,
) {
  await failJob(supabaseAdmin, job, errorCode, errorMessage);

  const { data: latestFile } = await supabaseAdmin
    .from("uploaded_files")
    .select("status")
    .eq("id", fileId)
    .maybeSingle();

  if (latestFile?.status !== "failed") {
    await setFailed(supabaseAdmin, fileId, errorMessage, stage, progress);
  }
}

// Parser methods that prove a real (non-fallback) parse was durably persisted.
const VALID_DURABLE_PARSER_METHODS = new Set([
  "azure_layout",
  "docling",
  "gemini_vision",
  "pdf_text",
  "openxml",
  "hybrid",
]);

// Statuses through which a durably-parsed file legitimately progresses after
// parse-document-azure persisted its output.
const POST_PARSE_STATUSES = new Set(["pdf_parsed", "validating", "validated", "review_required"]);

/**
 * A "transport-shaped" failure means the HTTP call to parse-document-azure or
 * normalize-pdf-output died (timeout, connection loss, Edge Function
 * compute/memory kill, gateway 5xx) — it says nothing about whether the
 * stage itself succeeded before dying. 4xx contract errors are real
 * failures and never reconciled.
 */
function isTransportShapedFailure(stageResult: any): boolean {
  const status = Number(stageResult?.status || 0);
  const errorCode = String(stageResult?.error_code || "");
  const message = String(stageResult?.error || stageResult?.data?.message || "");
  return (
    status === 408 ||
    status >= 500 ||
    ["STAGE_TIMEOUT", "NETWORK_ERROR"].includes(errorCode) ||
    /compute resources|WORKER_LIMIT/i.test(message)
  );
}

// Azure staging P0: the provider value parse-document-azure/azure-layout-adapter
// write into docling_raw._metadata.provider for a genuine Azure Document
// Intelligence parse (confirmed against the observed incident row).
const EXPECTED_AZURE_PROVIDER_METADATA = "azure_document_intelligence";

/**
 * Durable-state reconciliation: the database, not the HTTP response, is the
 * authority on whether parsing succeeded. parse-document-azure persists
 * docling_raw and flips status to pdf_parsed BEFORE serializing its HTTP
 * response, so a transport failure can arrive after a fully successful parse.
 *
 * Returns a tri-state `state`, never a boolean: "unknown" means the
 * reconciliation reads themselves failed (even after one retry) and must
 * never be treated as proof the durable data is absent — the Azure staging
 * P0 incident traced back to exactly this collapse. Reads only lightweight
 * JSON-path projections — never the whole docling_raw.
 *
 * Structural criteria (Correction round 2, item 2): text length alone is
 * insufficient. When rawMethod is Azure specifically, provider metadata and
 * page_count > 0 are also required — kept Azure-specific deliberately (item
 * 5): other recognized methods (docling, gemini_vision, pdf_text, openxml,
 * hybrid) are not known to share Azure's corruption mode and keep the
 * existing method+text-length criteria unchanged.
 */
async function reconcileDurableParse(supabaseAdmin: any, fileId: string, orgId: string): Promise<{
  state: DurabilityState;
  status: string | null;
  rawMethod: string;
  fullTextChars: number;
  pageCount: number;
}> {
  const unknown = { state: "unknown" as DurabilityState, status: null, rawMethod: "", fullTextChars: 0, pageCount: 0 };

  let status: string | null = null;
  let rawMethod = "";
  let rawProvider = "";
  let fullTextChars = 0;
  let pageCount = 0;

  const projected = await selectWithRetry(() =>
    supabaseAdmin
      .from("uploaded_files")
      .select(
        "id, status, processing_status, extraction_method, " +
        "raw_extraction_method:docling_raw->>extraction_method, " +
        "raw_provider:docling_raw->_metadata->>provider, " +
        "metadata_full_text_chars:docling_raw->_metadata->>full_text_chars, " +
        "raw_page_count:docling_raw->>page_count",
      )
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle(),
  );

  if (!projected.error && projected.data) {
    status = projected.data.status ?? null;
    rawMethod = String(projected.data.raw_extraction_method || "");
    rawProvider = String(projected.data.raw_provider || "");
    fullTextChars = Number(projected.data.metadata_full_text_chars || 0);
    pageCount = Number(projected.data.raw_page_count || 0);
  } else {
    // Aliased JSON-path projection unsupported or failed even after retry —
    // fall back to plain columns plus a non-aliased JSON-path query (also
    // retried once). Still never the full JSONB. If even the fallback
    // fails, this is genuinely "unknown", not "not durable".
    console.warn(
      `[${WORKER_NAME}] aliased JSON-path reconciliation select failed even after retry ` +
      `(${projected.error?.message ?? "no row"}); using fallback projection`,
    );
    const basic = await selectWithRetry(() =>
      supabaseAdmin
        .from("uploaded_files")
        .select("id, status, processing_status, extraction_method")
        .eq("id", fileId)
        .eq("org_id", orgId)
        .maybeSingle(),
    );
    if (basic.error || !basic.data) return unknown;
    status = basic.data.status ?? null;

    const jsonPaths = await selectWithRetry(() =>
      supabaseAdmin
        .from("uploaded_files")
        .select("docling_raw->>extraction_method, docling_raw->_metadata->>provider, docling_raw->>full_text, docling_raw->>page_count")
        .eq("id", fileId)
        .eq("org_id", orgId)
        .maybeSingle(),
    );
    if (jsonPaths.error || !jsonPaths.data) return unknown;
    rawMethod = String(jsonPaths.data.extraction_method || "");
    rawProvider = String(jsonPaths.data.provider || "");
    fullTextChars = String(jsonPaths.data.full_text || "").length;
    pageCount = Number(jsonPaths.data.page_count || 0);
  }

  // Older rows may lack _metadata.full_text_chars — measure the text string
  // itself (a string projection, not the whole docling_raw object).
  if (!fullTextChars && VALID_DURABLE_PARSER_METHODS.has(rawMethod)) {
    const textOnly = await selectWithRetry(() =>
      supabaseAdmin
        .from("uploaded_files")
        .select("docling_raw->>full_text")
        .eq("id", fileId)
        .eq("org_id", orgId)
        .maybeSingle(),
    );
    if (textOnly.error) return unknown;
    if (textOnly.data) {
      fullTextChars = String(textOnly.data.full_text || "").length;
    }
  }

  const isRecognizedMethod = VALID_DURABLE_PARSER_METHODS.has(rawMethod) && rawMethod !== "manual_review_fallback";
  const hasSufficientText = fullTextChars >= MIN_LEASE_TEXT_CHARS;
  const isAzure = rawMethod === "azure_layout";
  const azureStructureValid = !isAzure || (rawProvider === EXPECTED_AZURE_PROVIDER_METADATA && pageCount > 0);

  const contentBasedDurable = isRecognizedMethod && hasSufficientText && azureStructureValid;
  const statusBasedDurable = isRecognizedMethod && hasSufficientText && POST_PARSE_STATUSES.has(String(status));

  const state: DurabilityState = (contentBasedDurable || statusBasedDurable) ? "durable" : "not_durable";

  return { state, status, rawMethod, fullTextChars, pageCount };
}

// Statuses through which a file legitimately holds a durably-persisted
// ui_review_payload after normalize-pdf-output ran — either the C1.4 minimal
// fast-path payload or the fully enriched one.
const POST_NORMALIZE_STATUSES = new Set(["review_required", "validated", "approved"]);

/**
 * Check whether uploaded_files currently holds a real, non-fallback
 * ui_review_payload. Used two ways:
 *   1. To reconcile a transport-shaped normalize failure — if the minimal
 *      or full payload already made it to the database before the process
 *      died, the job is done; do not park for manual review.
 *   2. As a guard inside parkLeaseForManualReview so a transport failure on
 *      ANY stage can never stomp a payload that was already durably saved
 *      (e.g. normalize's minimal early persist landing, then a later
 *      transport failure on the same request or a retry).
 *
 * P0.3: content-based, not status-based. The prior version required
 * status ∈ POST_NORMALIZE_STATUSES, which the retry/re-dispatch machinery
 * resets to "parsing"/"pdf_parsed" BEFORE re-running normalize
 * (enqueueLeaseExtractionJob, and the "fast re-extraction" pdf_parsed
 * transition below) — so a retry's failure could see status outside that
 * set even though real data from a prior run was still sitting untouched in
 * the row, and incorrectly report not-durable. Checking parsed_data /
 * normalized_output / ui_review_payload for actual meaningful values
 * directly (guarantees 1-3) is independent of whatever status the retry
 * machinery left behind.
 *
 * Correction round 2, item 4: durability requires actual meaningful content,
 * not merely an extraction_method string that isn't literally
 * "manual_review_fallback". `uploadedFileRowHasMeaningfulValues()` (and the
 * functions it composes — normalizedOutputHasMeaningfulValues /
 * parsedDataHasMeaningfulValues) already check structural shape directly:
 * a fallback-shaped `rows: [{}]` row has zero own keys, so
 * `Object.values(row).some(isMeaningfulFieldValue)` is false regardless of
 * what extraction_method says. The `isFallback` string check below is kept
 * as an additional, explicit, non-load-bearing safety net (defense in
 * depth) — it is not the sole mechanism protecting against empty artifacts,
 * and this function correctly rejects a structurally-empty payload even if
 * a future fallback writer used a different method string.
 *
 * Returns a tri-state `state`: "unknown" means the read itself failed (even
 * after one retry) and must never be treated as proof durable data is
 * absent.
 */
async function reconcileDurableNormalize(supabaseAdmin: any, fileId: string, orgId: string): Promise<{
  state: DurabilityState;
  status: string | null;
  extractionMethod: string;
  hasRecords: boolean;
  enrichmentStatus: string | null;
}> {
  const unknown = { state: "unknown" as DurabilityState, status: null, extractionMethod: "", hasRecords: false, enrichmentStatus: null };

  const { data, error } = await selectWithRetry(() =>
    supabaseAdmin
      .from("uploaded_files")
      .select("id, status, extraction_method, ui_review_payload, parsed_data, normalized_output")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle(),
  );

  if (error || !data) return unknown;

  const status: string | null = data.status ?? null;
  const payload = data.ui_review_payload || {};
  const extractionMethod = String(payload.extraction_method || data.extraction_method || "");
  const hasRecords = Array.isArray(payload.records) && payload.records.length > 0;
  const isFallback = !extractionMethod || extractionMethod === "manual_review_fallback";
  const enrichmentStatus = payload.enrichment_status ?? null;

  const hasMeaningfulContent = uploadedFileRowHasMeaningfulValues({
    ui_review_payload: data.ui_review_payload,
    parsed_data: data.parsed_data,
    normalized_output: data.normalized_output,
  });

  const statusBasedDurable = POST_NORMALIZE_STATUSES.has(String(status)) && hasRecords && !isFallback && hasMeaningfulContent;
  const contentBasedDurable = hasMeaningfulContent && !isFallback;

  const state: DurabilityState = (statusBasedDurable || contentBasedDurable) ? "durable" : "not_durable";

  return { state, status, extractionMethod, hasRecords, enrichmentStatus };
}

// Test hook (same pattern as _shared/extraction/parser.ts).
export const __test__ = {
  isTransportShapedFailure,
  reconcileDurableParse,
  reconcileDurableNormalize,
  parkLeaseForManualReview,
  repairStaleReconciledState,
  resetJobForRetryableReconciliation,
  queueNormalizeTransportRetry,
  markNormalizePending,
  buildFactLedgerResumeFromMetadata,
  readNormalizeActivity,
  resolvePendingNormalizeBeforeRun,
  selectWithRetry,
  isCancelRequested,
  stopForCancellation,
  isReviewReadyEnrichmentTransportFailure,
  completeEnrichmentWithWarning,
  normalizeFailureAlreadyPersisted,
};

function parserFailureAlreadyPersisted(parseResult: any): boolean {
  const parserErrorCode = String(parseResult?.data?.error_code || parseResult?.error_code || "");
  const parserStatus = String(parseResult?.data?.parser_status || parseResult?.data?.processing_status || "");
  const message = String(parseResult?.data?.message || parseResult?.error || "");

  return (
    [
      "OCR_FAILED",
      "PARSER_PROVIDER_UNAVAILABLE",
      "EMPTY_PARSE_TEXT",
      "INSUFFICIENT_PARSE_TEXT",
      "PDF_PARSING_FAILED",
    ].includes(parserErrorCode) ||
    /parse_(ocr_failed|empty_text|insufficient_text|failed)|blocked_pipeline_failure/i.test(parserStatus) ||
    /invalid_grant|account not found|Failed to get Google access token/i.test(message)
  );
}
function normalizeFailureAlreadyPersisted(normalizeResult: any): boolean {
  const errorCode = String(normalizeResult?.data?.error_code || normalizeResult?.error_code || "");
  const processingStatus = String(normalizeResult?.data?.processing_status || normalizeResult?.data?.normalize_status || "");
  const hasBlockedPayload = normalizeResult?.data?.ui_review_payload &&
    typeof normalizeResult.data.ui_review_payload === "object";
  return Boolean(
    [
      "AI_EMPTY_EXTRACTION",
      "FIELD_MAPPING_FAILED",
      "WHOLE_DOCUMENT_LLM_FAILED",
    ].includes(errorCode) ||
      /failed_empty_extraction|blocked_pipeline_failure/i.test(processingStatus) ||
      hasBlockedPayload
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!isAuthorizedWorkerCall(req)) {
      return jsonResponse(UNAUTHORIZED_WORKER_RESPONSE, 401);
    }

    const body = await req.json().catch(() => ({}));
    const jobId = body.job_id;

    if (!jobId) {
      return jsonResponse({ error: true, error_code: "MISSING_JOB_INPUT", message: "job_id is required" }, 400);
    }

    const missingConfig = getMissingWorkerConfig();
    if (missingConfig.length > 0) {
      const message = `Worker configuration missing: ${missingConfig.join(", ")}`;
      const canPersistConfigFailure =
        !missingConfig.includes("SUPABASE_URL") &&
        !missingConfig.includes("SUPABASE_SERVICE_ROLE_KEY");

      if (canPersistConfigFailure) {
        try {
          const adminForConfigFailure = createAdminClient();
          const { data: configJob } = await adminForConfigFailure
            .from("pipeline_jobs")
            .select("*")
            .eq("id", jobId)
            .maybeSingle();
          if (configJob?.id) {
            await failJob(adminForConfigFailure, configJob, "WORKER_CONFIG_MISSING", message);
          }
        } catch (configPersistError) {
          console.warn(`[${WORKER_NAME}] could not persist WORKER_CONFIG_MISSING:`, configPersistError?.message || configPersistError);
        }
      }

      return jsonResponse(
        {
          error: true,
          error_code: "WORKER_CONFIG_MISSING",
          message,
        },
        500,
      );
    }

    const supabaseAdmin = createAdminClient();

    const { data: job, error: jobError } = await supabaseAdmin
      .from("pipeline_jobs")
      .select("*")
      .eq("id", jobId)
      .maybeSingle();

    if (jobError || !job) {
      return jsonResponse({ error: true, error_code: "JOB_NOT_FOUND", message: jobError?.message || "Pipeline job not found" }, 404);
    }

    const orgId = job.org_id || job.input?.org_id;
    const fileId = job.uploaded_file_id || job.input?.uploaded_file_id || body.file_id;

    if (!orgId || !fileId) {
      await failJob(supabaseAdmin, job, "MISSING_JOB_CONTEXT", "Pipeline job is missing org_id or uploaded_file_id");
      return jsonResponse(
        { error: true, error_code: "MISSING_JOB_CONTEXT", message: "Pipeline job is missing org_id or uploaded_file_id" },
        400,
      );
    }

    if (["completed", "failed", "cancelled", "superseded"].includes(job.status)) {
      return jsonResponse({ error: false, job_id: job.id, status: job.status, stage: job.stage });
    }

    // Guard against running a job that has already exceeded its attempt budget.
    // max_attempts defaults to 3 (set at job creation in ingest-file).
    const currentAttempt = Number(job.attempt || 0);
    const maxAttempts = Number(job.max_attempts || 3);
    if (currentAttempt >= maxAttempts) {
      const message = `Job exceeded max_attempts (${currentAttempt}/${maxAttempts})`;
      if (job.stage === "enrich") {
        // Guarantee 7: a maxed-out enrich job must never call
        // failJobAndUpload()/setFailed() — that would clobber the good core
        // payload with uploaded_files.status="failed". Only fail the job row
        // and patch enrichment_status.
        await failJob(supabaseAdmin, job, "MAX_ATTEMPTS_EXCEEDED", message);
        // Reliability Phase R1: classify using the LAST ATTEMPT's error
        // code/message (already on this in-memory `job` row, fetched
        // before failJob's own DB-level overwrite above) rather than the
        // literal "MAX_ATTEMPTS_EXCEEDED" string -- a run of repeated 546
        // resource-exhaustion crashes hitting the attempt budget is
        // plausibly the single most common real path to this branch, and
        // only the underlying per-attempt error code can reveal that.
        const { classification, retryable } = classifyEnrichmentFailure(job.error_code, job.error_message, null);
        const terminalStatus = classification === "resource_exhausted" ? "partial" : "failed";
        const persistResult = await persistEnrichmentTerminalState({
          supabaseAdmin,
          organizationId: orgId,
          fileId,
          generationId: job.generation_id,
          status: terminalStatus,
          errorCode: job.error_code ?? "MAX_ATTEMPTS_EXCEEDED",
          errorMessage: message,
          classification,
          retryable,
          stage: "enrich",
          completedStages: ["parse", "normalize"],
          logger: createLogger(supabaseAdmin, fileId, orgId),
        });
        if (persistResult.persisted) {
          console.log(`[${WORKER_NAME}] enrichment_${terminalStatus}_preserved_core_payload file_id=${fileId} reason=max_attempts_exceeded`);
          // P0.5: terminal enrichment outcome — re-evaluate readiness.
          try {
            const { error: finalizeRpcError } = await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
              p_org_id: orgId,
              p_uploaded_file_id: fileId,
              p_generation_id: job.generation_id,
              p_package_mode: getLeaseDocumentPackageMode(),
              p_financial_mode: getLeaseFinancialScheduleMode(),
            });
            if (finalizeRpcError) {
              console.error(`[${WORKER_NAME}] finalize_lease_extraction_for_review RPC returned an error (review_readiness NOT updated) file_id=${fileId}:`, finalizeRpcError.message);
            }
          } catch (finalizeError: any) {
            console.error(`[${WORKER_NAME}] finalize_lease_extraction_for_review call threw file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
          }
        }
      } else {
        await failJobAndUpload(supabaseAdmin, job, fileId, "MAX_ATTEMPTS_EXCEEDED", message, job.stage ?? "parse", 15);
      }
      return jsonResponse({ error: true, error_code: "MAX_ATTEMPTS_EXCEEDED", job_id: job.id, message }, 200);
    }

    const { data: fileRecord, error: fileError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, status, file_name, module_type, document_subtype, file_size, file_url, mime_type, storage_path")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();

    if (fileError || !fileRecord) {
      await failJob(supabaseAdmin, job, "FILE_NOT_FOUND", fileError?.message || "Uploaded file not found");
      return jsonResponse({ error: true, error_code: "FILE_NOT_FOUND", message: "Uploaded file not found" }, 404);
    }

    const logger = createLogger(supabaseAdmin, fileId, orgId);

    // Checkpoint 0: a cancel may have been requested before this invocation
    // even started (e.g. queued but not yet picked up). Stop here rather
    // than claiming the job into 'running' first.
    if (job.cancel_requested_at) {
      return await stopForCancellation(supabaseAdmin, job, fileId, logger, "before_claim");
    }

    // Atomic conditional claim — replaces the previous unconditional
    // `.update({status:"running",...}).eq("id", job.id)`, which had no
    // predicate beyond id and could "claim" a job already superseded or
    // cancelled between this invocation's initial fetch (above) and this
    // update. claim_pipeline_job only succeeds if the job is still queued,
    // available, not cancel-requested, and under its attempt budget — see
    // supabase/migrations/20260824000200_pipeline_jobs_generation_rpcs.sql.
    const { data: claimedJob, error: claimError } = await supabaseAdmin.rpc("claim_pipeline_job", {
      p_job_id: job.id,
      p_worker_name: WORKER_NAME,
    });

    if (claimError) {
      return jsonResponse({ error: true, error_code: "CLAIM_FAILED", message: claimError.message }, 500);
    }
    if (!claimedJob) {
      // Someone else claimed it first, it was superseded/cancelled between
      // fetch and claim, or its attempt budget is exhausted — stop here
      // rather than proceeding to run stale/duplicate work.
      return jsonResponse({ error: false, job_id: job.id, status: "not_claimed" });
    }
    const attempt = Number(claimedJob.attempt || 0);

    // Run parse and normalize sequentially in a single invocation.
    // The original two-stage self-dispatch pattern (dispatchSelf) was unreliable:
    // when EdgeRuntime.waitUntil is unavailable the fire-and-forget fetch is
    // cancelled before the TCP connection is established, so normalize never ran.
    let currentStage = job.stage;
    const normalizeChainedAfterParse = currentStage === "parse";

    if (currentStage === "parse") {
      // Checkpoint 1: cancel-upload may have flagged this job between the
      // initial fetch above and now. `job` was read moments ago in this same
      // invocation, so no extra query is needed here.
      if (job.cancel_requested_at) {
        return await stopForCancellation(supabaseAdmin, job, fileId, logger, "before_parse");
      }

      await logger.event("parse", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      let parseResult: any;
      try {
        const parseExtractionRunId = claimedJob.generation_id
          ? await resolveExtractionRunId(supabaseAdmin, orgId, claimedJob.generation_id)
          : null;
        parseResult = await runParseStageInline(
          supabaseAdmin,
          fileId,
          orgId,
          job.id,
          claimedJob.generation_id,
          parseExtractionRunId,
          attempt,
          fileRecord,
          logger,
        );
      } catch (transportErr: any) {
        parseResult = {
          ok: false,
          status: 500,
          data: {},
          error_code: "NETWORK_ERROR",
          retryable: true,
          error: transportErr?.message || "Inline parsing failure",
        };
      }

      // Durable-state reconciliation: a transport-shaped failure (timeout,
      // 546 compute kill, gateway 5xx) can arrive AFTER parse-document-azure
      // already persisted a successful parse. The database is authoritative —
      // re-read it before treating the parse as failed, and never overwrite a
      // durable success with manual_review_fallback.
      let parseReconciledToNormalize = false;
      if (!parseResult.ok && isTransportShapedFailure(parseResult)) {
        const reconciled = await reconcileDurableParse(supabaseAdmin, fileId, orgId);

        if (reconciled.state === "durable") {
          console.warn(
            `[${WORKER_NAME}] parse_transport_failed_but_persisted file_id=${fileId} ` +
            `durable_status=${reconciled.status} method=${reconciled.rawMethod} ` +
            `chars=${reconciled.fullTextChars} pages=${reconciled.pageCount} http_status=${parseResult.status}`,
          );
          await logger.event("parse", "reconciled", {
            provider: "lease-extraction-worker",
            metadata: {
              job_id: job.id,
              reason: "parse_transport_failed_but_persisted",
              durable_status: reconciled.status,
              parser_method: reconciled.rawMethod,
              full_text_chars: reconciled.fullTextChars,
              page_count: reconciled.pageCount,
              transport_status: parseResult.status,
              transport_error: String(parseResult.error || "").slice(0, 300),
            },
          });

          // Repair, not just "avoid overwriting" — a row already left with a
          // stale status/failed_step/error_message by an earlier failed
          // attempt gets actively corrected here, in addition to preventing
          // a fresh incident.
          await repairStaleReconciledState(
            supabaseAdmin,
            fileId,
            orgId,
            reconciled.status === "pdf_parsed" || !POST_PARSE_STATUSES.has(String(reconciled.status))
              ? "pdf_parsed"
              : String(reconciled.status),
            reconciled.status === "pdf_parsed" || !POST_PARSE_STATUSES.has(String(reconciled.status))
              ? "pdf_parsed"
              : String(reconciled.status),
          );

          if (reconciled.status === "validated" || reconciled.status === "review_required") {
            // The workflow already progressed past normalization (e.g. a
            // previous attempt completed it). Nothing left for this job.
            await supabaseAdmin
              .from("pipeline_jobs")
              .update({
                status: "completed",
                error_code: null,
                error_message: null,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                metadata: {
                  ...(job.metadata || {}),
                  reconciled_from: "parse_transport_failed_but_persisted",
                  reconciled_durable_status: reconciled.status,
                },
              })
              .eq("id", job.id);
            return jsonResponse({
              error: false,
              job_id: job.id,
              stage: job.stage,
              status: "completed",
              reconciled: true,
              durable_status: reconciled.status,
            });
          } else if (reconciled.status === "validating") {
            // Another invocation is normalizing right now — do not dispatch a
            // duplicate normalize call; the in-flight run owns job completion.
            console.warn(`[${WORKER_NAME}] parse_reconciled_normalize_in_flight file_id=${fileId}`);
            return jsonResponse({
              error: false,
              job_id: job.id,
              stage: "normalize",
              reconciled: true,
              normalize_in_flight: true,
              message: "Durable parse output found; normalization already in flight",
            });
          }
          // "pdf_parsed" (or any other durable status without a more specific
          // handler above): parse persisted; continue to normalize via the
          // guarded stage claim below (same path as a normal parse success).
          parseReconciledToNormalize = true;
        } else if (reconciled.state === "unknown") {
          // The reconciliation read itself failed even after a retry — this
          // must never be treated as proof the durable data is absent.
          // Requeue for a genuine retry instead of parking or failing.
          await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, "parse_call_site");
          await logger.event("parse", "reconciliation_unknown", {
            provider: "lease-extraction-worker",
            metadata: { job_id: job.id, transport_status: parseResult.status },
          });
          return jsonResponse({
            error: true,
            error_code: "RECONCILIATION_INCONCLUSIVE",
            job_id: job.id,
            stage: "parse",
            retryable: true,
            message: "Could not determine durable parse state after a transport failure; job requeued for retry.",
          }, 200);
        }
        // state === "not_durable": falls through to the normal failure path
        // below exactly as before.
      }

      if (!parseResult.ok && !parseReconciledToNormalize) {
        const message = parseResult.error || "Document parsing failed";
        const errorCode = parseResult.data?.error_code || parseResult.error_code || "PARSE_FAILED";
        const isLeaseModule = isLeaseModuleType(fileRecord.module_type);

        if (isLeaseModule && parserFailureAlreadyPersisted(parseResult)) {
          // parse-document-azure already persisted a blocked parser state with
          // docling_raw/_metadata and ui_review_payload. Do not overwrite that
          // failed state with review_required/manual_review_fallback; doing so
          // makes backend configuration failures look like successful extraction.
          await failJob(supabaseAdmin, job, errorCode, message);
          await logger.event("parse", "failed", {
            error_code: errorCode,
            error_message: message,
            metadata: {
              job_id: job.id,
              status: parseResult.status,
              blocked_pipeline_failure: true,
              parser_status: parseResult.data?.parser_status || parseResult.data?.processing_status || null,
            },
          });
          return jsonResponse({
            error: true,
            error_code: errorCode,
            job_id: job.id,
            stage: "parse",
            blocked_pipeline_failure: true,
            message,
          }, 200);
        }

        if (isLeaseModule) {
          // Stage-aware, tri-state-aware guard: on durable discovery this
          // resumes the pipeline instead of parking (and never fails the
          // job); on "unknown" it requeues for a genuine retry; only a true
          // "not_durable" result writes the manual-review fallback.
          const parkResult = await parkLeaseForManualReview(
            supabaseAdmin, job, fileId, orgId,
            fileRecord.file_name ?? "Lease document",
            fileRecord.module_type ?? "leases",
            fileRecord.document_subtype ?? "base_lease",
            errorCode, message, "parse",
          );

          if (parkResult.outcome === "resume_from_durable_parse") {
            await logger.event("parse", "reconciled", {
              provider: "lease-extraction-worker",
              metadata: { job_id: job.id, reason: "resume_from_durable_parse_guard", status: parseResult.status },
            });
            parseReconciledToNormalize = true;
            // Deliberately no return here — control falls through to the
            // stage-claim/normalize-dispatch code below, the same path a
            // normal parse success takes.
          } else if (parkResult.outcome === "reconciliation_unknown") {
            await logger.event("parse", "reconciliation_unknown", {
              provider: "lease-extraction-worker",
              metadata: { job_id: job.id, status: parseResult.status },
            });
            return jsonResponse({
              error: true,
              error_code: "RECONCILIATION_INCONCLUSIVE",
              job_id: job.id,
              stage: "parse",
              retryable: true,
              message: "Could not determine durable parse state after a transport failure; job requeued for retry.",
            }, 200);
          } else {
            // "parked": genuinely nothing durable exists yet.
            await logger.event("parse", "failed", {
              error_code: errorCode,
              error_message: message,
              metadata: { job_id: job.id, status: parseResult.status, parked_for_manual_review: true },
            });
            return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "parse", parked_for_manual_review: true, message }, 200);
          }
        } else {
          await failJobAndUpload(supabaseAdmin, job, fileId, errorCode, message, "parse", 15);
          await logger.event("parse", "failed", {
            error_code: errorCode,
            error_message: message,
            metadata: { job_id: job.id, status: parseResult.status, retryable: Boolean(parseResult.retryable) },
          });
          return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "parse", message }, 200);
        }
      }

      // Concurrency guard: only advance parse → normalize if no other worker
      // attempt already did. Without the stage predicate, two overlapping
      // attempts (e.g. a retry racing a reconciled run) would both dispatch
      // normalize-pdf-output.
      const { data: normalizeStageClaim, error: normalizeStageClaimError } = await supabaseAdmin
        .from("pipeline_jobs")
        .update({
          stage: "normalize",
          status: "running",
          error_code: null,
          error_message: null,
          updated_at: new Date().toISOString(),
          metadata: {
            ...(job.metadata || {}),
            parse_completed_at: new Date().toISOString(),
            ...(parseReconciledToNormalize
              ? { reconciled_from: "parse_transport_failed_but_persisted" }
              : {}),
          },
        })
        .eq("id", job.id)
        .eq("stage", "parse")
        .is("cancel_requested_at", null)
        .select("id")
        .maybeSingle();

      if (normalizeStageClaimError || !normalizeStageClaim) {
        const { data: latestJob } = await supabaseAdmin
          .from("pipeline_jobs")
          .select("id, stage, status, cancel_requested_at")
          .eq("id", job.id)
          .maybeSingle();

        // Checkpoint 2: the claim's `.is("cancel_requested_at", null)`
        // predicate makes a cancel requested mid-parse fail the claim the
        // same way a losing concurrency race would — distinguish the two so
        // a genuine cancel actually transitions to 'cancelled' instead of
        // silently looking like "another worker already handled it".
        if (latestJob?.cancel_requested_at) {
          return await stopForCancellation(supabaseAdmin, job, fileId, logger, "parse_to_normalize_claim");
        }

        console.warn(
          `[${WORKER_NAME}] normalize stage claim not acquired for job=${job.id} ` +
          `(stage=${latestJob?.stage ?? "?"} status=${latestJob?.status ?? "?"}); ` +
          `another worker attempt advanced it — not dispatching a duplicate normalize`,
        );
        return jsonResponse({
          error: false,
          job_id: job.id,
          stage: latestJob?.stage ?? "normalize",
          status: latestJob?.status ?? "running",
          stage_claim_lost: true,
        });
      }

      await logger.event("parse", "completed", {
        metadata: {
          job_id: job.id,
          next_stage: "normalize",
          reconciled: parseReconciledToNormalize,
        },
      });

      console.log(`[${WORKER_NAME}] parse done, proceeding directly to normalize for file_id=${fileId}`);
      currentStage = "normalize";
    }

    if (currentStage === "normalize") {
      // Checkpoint 3: fresh read, not the possibly-stale in-memory `job` —
      // parse can take up to 140s and a job can also be enqueued directly at
      // "normalize" (fast re-extraction path below), so cancel_requested_at
      // set at any point up to now must be observed here.
      if (await isCancelRequested(supabaseAdmin, job.id)) {
        return await stopForCancellation(supabaseAdmin, job, fileId, logger, "before_normalize");
      }

      const pendingNormalizeResolution = await resolvePendingNormalizeBeforeRun(
        supabaseAdmin,
        job,
        fileId,
        orgId,
        logger,
      );
      if (pendingNormalizeResolution.response) {
        return pendingNormalizeResolution.response;
      }
      const factLedgerResume = pendingNormalizeResolution.factLedgerResume;
      // Fast re-extraction path: when the job is enqueued directly at the
      // "normalize" stage (docling_raw already had usable text, so OCR was
      // skipped), the file status is still "parsing" from enqueueLeaseExtractionJob
      // — it never passed through parse-document-azure, which is what normally
      // transitions status to "pdf_parsed". Without this, normalize-pdf-output's
      // status guard rejects the call with "File status must be 'pdf_parsed'.
      // Current: 'parsing'". setStatus is a no-op when already "pdf_parsed"
      // (the path that came from the "parse" branch above).
      if (fileRecord.status !== "validating") {
        const pdfParsedTransition = await setStatus(supabaseAdmin, fileId, "pdf_parsed", {
          processing_status: "pdf_parsed",
        });
        if (pdfParsedTransition.error) {
          console.error(
            `[${WORKER_NAME}] Failed to transition to pdf_parsed before normalize stage:`,
            pdfParsedTransition.error.message,
          );
        }
      }
      await logger.event("normalize", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const normalizeExtractionRunId = claimedJob.generation_id
        ? await resolveExtractionRunId(supabaseAdmin, orgId, claimedJob.generation_id)
        : null;
      const normalizeResult = await callInternalFunction(
        "normalize-pdf-output",
        {
          file_id: fileId,
          pipeline_job_id: job.id,
          worker_attempt: attempt,
          generation_id: claimedJob.generation_id,
          extraction_run_id: normalizeExtractionRunId,
          ...(factLedgerResume ? { fact_ledger_resume: factLedgerResume } : {}),
        },
        orgId,
        normalizeChainedAfterParse ? CHAINED_NORMALIZE_TIMEOUT_MS : NORMALIZE_TIMEOUT_MS,
      );
      let normalizeReconciledToComplete = false;

      if (!normalizeResult.ok) {
        const message = normalizeResult.error || "Document normalization failed";
        const errorCode = normalizeResult.error_code || normalizeResult.data?.error_code || "NORMALIZE_FAILED";
        const isLeaseModule = isLeaseModuleType(fileRecord.module_type);

        // Durable-state reconciliation: normalize-pdf-output now persists a
        // minimal core-field payload BEFORE running its expensive
        // workflow/clause/evidence pass. A transport-shaped failure (OOM,
        // timeout, 546 compute kill) can arrive after that payload — or the
        // full enriched one — already landed. Re-read before parking.
        if (isTransportShapedFailure(normalizeResult)) {
          const reconciled = await reconcileDurableNormalize(supabaseAdmin, fileId, orgId);

          if (reconciled.state === "durable") {
            console.warn(
              `[${WORKER_NAME}] normalize_transport_failed_but_persisted file_id=${fileId} ` +
              `durable_status=${reconciled.status} method=${reconciled.extractionMethod} ` +
              `http_status=${normalizeResult.status}`,
            );
            await logger.event("normalize", "reconciled", {
              provider: "lease-extraction-worker",
              metadata: {
                job_id: job.id,
                reason: "normalize_transport_failed_but_persisted",
                durable_status: reconciled.status,
                extraction_method: reconciled.extractionMethod,
                transport_status: normalizeResult.status,
                transport_error: String(normalizeResult.error || "").slice(0, 300),
              },
            });
            await repairStaleReconciledState(
              supabaseAdmin,
              fileId,
              orgId,
              String(reconciled.status ?? "review_required"),
              String(reconciled.status ?? "review_required"),
            );
            await supabaseAdmin
              .from("pipeline_jobs")
              .update({
                status: "completed",
                error_code: null,
                error_message: null,
                completed_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                metadata: {
                  ...(job.metadata || {}),
                  reconciled_from: "normalize_transport_failed_but_persisted",
                  reconciled_durable_status: reconciled.status,
                },
              })
              .eq("id", job.id);
            return jsonResponse({
              error: false,
              job_id: job.id,
              stage: "normalize",
              status: "completed",
              reconciled: true,
              durable_status: reconciled.status,
            });
          }

          if (reconciled.state === "unknown") {
            await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, "normalize_call_site");
            await logger.event("normalize", "reconciliation_unknown", {
              provider: "lease-extraction-worker",
              metadata: { job_id: job.id, transport_status: normalizeResult.status },
            });
            return jsonResponse({
              error: true,
              error_code: "RECONCILIATION_INCONCLUSIVE",
              job_id: job.id,
              stage: "normalize",
              retryable: true,
              message: "Could not determine durable normalize state after a transport failure; job requeued for retry.",
            }, 200);
          }
          return await queueNormalizeTransportRetry(
            supabaseAdmin,
            job,
            fileId,
            logger,
            normalizeResult,
            "normalize_transport_not_durable",
          );
        }

        if (isLeaseModule && normalizeFailureAlreadyPersisted(normalizeResult)) {
          // normalize-pdf-output already persisted a structured blocked payload
          // with the real extraction diagnostics. Do not overwrite it with the
          // generic manual_review_fallback shell; that hides whether OpenAI ran
          // and why the current attempt failed.
          await failJob(supabaseAdmin, job, errorCode, message);
          await logger.event("normalize", "failed", {
            error_code: errorCode,
            error_message: message,
            metadata: {
              job_id: job.id,
              status: normalizeResult.status,
              blocked_pipeline_failure: true,
              preserved_normalize_payload: true,
            },
          });
          return jsonResponse({
            error: true,
            error_code: errorCode,
            job_id: job.id,
            stage: "normalize",
            blocked_pipeline_failure: true,
            message,
          }, 200);
        }

        if (isLeaseModule) {
          const parkResult = await parkLeaseForManualReview(
            supabaseAdmin, job, fileId, orgId,
            fileRecord.file_name ?? "Lease document",
            fileRecord.module_type ?? "leases",
            fileRecord.document_subtype ?? "base_lease",
            errorCode, message, "normalize",
          );

          if (parkResult.outcome === "resume_from_durable_normalize") {
            await logger.event("normalize", "reconciled", {
              provider: "lease-extraction-worker",
              metadata: { job_id: job.id, reason: "resume_from_durable_normalize_guard" },
            });
            normalizeReconciledToComplete = true;
            // No return — falls through to the "mark completed" block below,
            // the same path a normal normalize success takes.
          } else if (parkResult.outcome === "reconciliation_unknown") {
            await logger.event("normalize", "reconciliation_unknown", {
              provider: "lease-extraction-worker",
              metadata: { job_id: job.id, status: normalizeResult.status },
            });
            return jsonResponse({
              error: true,
              error_code: "RECONCILIATION_INCONCLUSIVE",
              job_id: job.id,
              stage: "normalize",
              retryable: true,
              message: "Could not determine durable normalize state after a transport failure; job requeued for retry.",
            }, 200);
          } else {
            // "parked": genuinely nothing durable exists yet.
            await logger.event("normalize", "failed", {
              error_code: errorCode,
              error_message: message,
              metadata: { job_id: job.id, status: normalizeResult.status, parked_for_manual_review: true },
            });
            return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "normalize", parked_for_manual_review: true, message }, 200);
          }
        } else {
          await failJobAndUpload(supabaseAdmin, job, fileId, errorCode, message, "normalize", 45);
          await logger.event("normalize", "failed", {
            error_code: errorCode,
            error_message: message,
            metadata: { job_id: job.id, status: normalizeResult.status, retryable: Boolean(normalizeResult.retryable) },
          });
          return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "normalize", message }, 200);
        }
      }

      await supabaseAdmin
        .from("pipeline_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: {
            ...(job.metadata || {}),
            normalize_completed_at: new Date().toISOString(),
            ...(normalizeReconciledToComplete ? { reconciled_from: "resume_from_durable_normalize_guard" } : {}),
          },
        })
        .eq("id", job.id);

      await logger.event("normalize", "completed", {
        metadata: { job_id: job.id, reconciled: normalizeReconciledToComplete },
      });

      // Defensive second dispatch path (P0.1/§3): normalize-pdf-output
      // enqueues its own "enrich" job internally right before it returns
      // success. If the process died between that enqueue call and this
      // worker observing the response, re-check and re-dispatch here so an
      // enrich job is never silently lost.
      const postNormalizeCheck = await reconcileDurableNormalize(supabaseAdmin, fileId, orgId);
      if (
        postNormalizeCheck.state === "durable" &&
        postNormalizeCheck.enrichmentStatus !== "completed" &&
        postNormalizeCheck.enrichmentStatus !== "running"
      ) {
        // Double-check pipeline_jobs to make sure an active bounded enrich stage isn't already running or queued
        const { data: existingEnrichJob } = await supabaseAdmin
          .from("pipeline_jobs")
          .select("id, status")
          .eq("uploaded_file_id", fileId)
          .in("stage", ["enrich_clauses", firstEnrichBoundedStage()])
          .in("status", ["queued", "running", "completed"])
          .maybeSingle();

        if (!existingEnrichJob) {
          if (getEnrichBoundedStageMode() === "active") {
            await enqueueBoundedEnrichStage({ supabaseAdmin, orgId, fileId, stage: firstEnrichBoundedStage(), generationId: job.generation_id ?? null, moduleType: fileRecord.module_type, logger });
          } else {
            await enqueueEnrichmentJob({ supabaseAdmin, orgId, fileId, moduleType: fileRecord.module_type, logger });
          }
        }
      }
      // state === "not_durable" or "unknown": safe default is to skip the
      // enrich dispatch rather than guess — an inconclusive determination
      // should not trigger new work.

      return jsonResponse({ error: false, job_id: job.id, stage: "normalize", status: "completed" });
    }

    // Bounded Per-Domain Enrich Refactor (see docs/lease-extraction-architecture-audit-2026-07-29.md
    // and the "Bounded Per-Domain Enrich Refactor" plan). One call per
    // invocation, exactly one stage -- this branch does NOT loop through the
    // whole sequence itself; it dispatches ONE stage to normalize-pdf-output,
    // then relies on completeBoundedEnrichStage() to enqueue the next stage
    // as its own fresh, independent invocation. The sequence is resumable
    // across invocations by construction: a crash here leaves the job row at
    // whatever pipeline_jobs status it was last set to, and a stale/duplicate
    // dispatch of the SAME stage is made safe by handleBoundedEnrichStage's
    // own idempotency check (isStageAlreadyCompleted), not by anything in
    // this branch. Bounded enrichment is mandatory for new lease extraction,
    // so the existing "enrich" branch below only remains as a compatibility
    // handler for already-queued legacy jobs.
    if (isEnrichBoundedStageName(currentStage)) {
      if (await isCancelRequested(supabaseAdmin, job.id)) {
        return await stopForCancellation(supabaseAdmin, job, fileId, logger, `before_${currentStage}`);
      }

      await logger.event(currentStage, "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const stageResult = await callInternalFunction(
        "normalize-pdf-output",
        { file_id: fileId, pipeline_job_id: job.id, generation_id: job.generation_id, worker_attempt: attempt, mode: currentStage },
        orgId,
        BOUNDED_ENRICH_STAGE_TIMEOUT_MS,
      );

      if (!stageResult.ok) {
        const message = stageResult.error || `Bounded enrich stage ${currentStage} failed`;
        const errorCode = stageResult.error_code || stageResult.data?.error_code || "ENRICH_STAGE_FAILED";
        const limitExceeded = errorCode === "BOUNDED_STAGE_LIMIT_EXCEEDED" || !!stageResult.data?.limit_exceeded;
        if (errorCode === "PRIOR_STAGE_MISSING" && stageResult.data?.retryable) {
          const missingSubstages = Array.isArray(stageResult.data?.missing_substages) ? stageResult.data.missing_substages : [];
          for (const missingStage of missingSubstages) {
            const { data: missingJob } = await supabaseAdmin
              .from("pipeline_jobs")
              .select("id, status, metadata")
              .eq("uploaded_file_id", fileId)
              .eq("job_type", "lease_extraction")
              .eq("stage", missingStage)
              .eq("generation_id", job.generation_id)
              .order("created_at", { ascending: false })
              .limit(1)
              .maybeSingle();
            if (missingJob?.status === "completed") {
              await supabaseAdmin.from("pipeline_jobs").update({
                status: "queued",
                error_code: null,
                error_message: null,
                updated_at: new Date().toISOString(),
                metadata: {
                  ...(missingJob.metadata || {}),
                  requeued_for_missing_bounded_result: true,
                  blocked_reducer_stage: currentStage,
                },
              }).eq("id", missingJob.id);
            }
            if (!missingJob || ["queued", "running", "completed"].includes(String(missingJob.status))) {
              await enqueueBoundedEnrichStage({
                supabaseAdmin, orgId, fileId, stage: missingStage,
                generationId: job.generation_id ?? null, moduleType: fileRecord.module_type, logger,
              });
            }
          }
          await resetJobForRetryableReconciliation(supabaseAdmin, job, fileId, "bounded_prior_stage_missing", {
            delayMs: NORMALIZE_RETRY_DELAY_MS,
            metadata: {
              bounded_stage_retry: true,
              blocked_stage: currentStage,
              missing_substages: missingSubstages,
            },
          });
          await logger.event(currentStage, "retry_queued", {
            error_code: errorCode,
            error_message: message,
            metadata: {
              job_id: job.id,
              missing_substages: missingSubstages,
            },
          });
          return jsonResponse({
            error: true,
            error_code: "BOUNDED_STAGE_RETRY_QUEUED",
            original_error_code: errorCode,
            retryable: true,
            job_id: job.id,
            stage: currentStage,
            missing_substages: missingSubstages,
            message,
          }, 200);
        }
        // Deliberately NOT routed through any "review-ready transport
        // failure" warning path the way the old monolithic "enrich" branch
        // below does -- per the explicit requirement, 546/DOWNSTREAM_FUNCTION_FAILED/
        // generation-fencing/schema/persistence failures must never become
        // completed_with_warnings here. Every bounded-stage failure is
        // terminal and visible.
        await completeBoundedEnrichStage({
          supabaseAdmin, job, fileId, orgId, moduleType: fileRecord.module_type, stage: currentStage,
          outcome: { ok: false, limitExceeded, errorCode, errorMessage: message },
          logger,
        });
        return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: currentStage, message }, 200);
      }

      if (stageResult.data?.stale_generation) {
        console.log(`[${WORKER_NAME}] ${currentStage}_stale_generation_skipped file_id=${fileId} job_id=${job.id}`);
      }

      const completion = await completeBoundedEnrichStage({
        supabaseAdmin, job, fileId, orgId, moduleType: fileRecord.module_type, stage: currentStage,
        outcome: { ok: true },
        logger,
      });

      return jsonResponse({
        error: false, job_id: job.id, stage: currentStage, status: "completed",
        chain_complete: !!(completion as any)?.chainComplete,
        next_stage: (completion as any)?.nextStage ?? null,
      }, 200);
    }

    if (currentStage === "enrich") {
      // Checkpoint: an enrich job can be cancelled the same way any other
      // stage can — never dispatch evidence resolution for a cancelled file.
      if (await isCancelRequested(supabaseAdmin, job.id)) {
        return await stopForCancellation(supabaseAdmin, job, fileId, logger, "before_enrich");
      }

      const boundedMode = getEnrichBoundedStageMode();
      const enrichInputSize = await readDurableEnrichInputSize(supabaseAdmin, fileId);
      const guardReasons = monolithicEnrichGuardReasons(enrichInputSize);
      if (shouldUseBoundedEnrich(boundedMode, enrichInputSize)) {
        const firstStage = firstEnrichBoundedStage();
        const boundedJob = await enqueueBoundedEnrichStage({
          supabaseAdmin,
          orgId,
          fileId,
          stage: firstStage,
          generationId: job.generation_id ?? null,
          moduleType: fileRecord.module_type,
          logger,
        });

        if (!boundedJob?.id) {
          const message = "Could not enqueue bounded enrichment stage; monolithic enrich was not run because it is unsafe for this document.";
          await failJob(supabaseAdmin, job, "BOUNDED_ENRICH_DISPATCH_FAILED", message);
          await persistEnrichmentTerminalState({
            supabaseAdmin,
            organizationId: orgId,
            fileId,
            generationId: job.generation_id,
            status: "partial",
            errorCode: "BOUNDED_ENRICH_DISPATCH_FAILED",
            errorMessage: message,
            classification: "transport_error",
            retryable: true,
            stage: "enrich",
            completedStages: ["parse", "normalize"],
            logger,
          });
          return jsonResponse({ error: true, error_code: "BOUNDED_ENRICH_DISPATCH_FAILED", job_id: job.id, stage: "enrich", message }, 200);
        }

        const now = new Date().toISOString();
        await supabaseAdmin
          .from("pipeline_jobs")
          .update({
            status: "superseded",
            completed_at: now,
            updated_at: now,
            metadata: {
              ...(job.metadata || {}),
              redirected_to_bounded_enrich: true,
              redirected_stage: firstStage,
              redirected_job_id: boundedJob.id,
              bounded_mode: boundedMode,
              monolithic_guard_reasons: guardReasons,
              enrich_input_size: enrichInputSize,
            },
          })
          .eq("id", job.id);

        await logger.event("enrich", "redirected_to_bounded_enrich", {
          provider: "lease-extraction-worker",
          metadata: {
            job_id: job.id,
            bounded_job_id: boundedJob.id,
            next_stage: firstStage,
            bounded_mode: boundedMode,
            input_size: enrichInputSize,
            guard_reasons: guardReasons,
          },
        });

        return jsonResponse({
          error: false,
          job_id: job.id,
          stage: "enrich",
          status: "superseded",
          redirected_to_bounded_enrich: true,
          bounded_job_id: boundedJob.id,
          next_stage: firstStage,
        }, 200);
      }

      await logger.event("enrich", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const enrichResult = await callInternalFunction(
        "normalize-pdf-output",
        { file_id: fileId, pipeline_job_id: job.id, worker_attempt: attempt, mode: "enrich" },
        orgId,
        ENRICH_TIMEOUT_MS,
      );

      if (!enrichResult.ok) {
        const message = enrichResult.error || "Evidence enrichment failed";
        const errorCode = enrichResult.error_code || enrichResult.data?.error_code || "ENRICHMENT_FAILED";

        if (isReviewReadyEnrichmentTransportFailure(errorCode, message, enrichResult.status)) {
          const friendlyMessage = "Optional enrichment warning: some source page references could not be linked, but all core lease terms were successfully extracted and are ready for review.";
          await completeEnrichmentWithWarning(supabaseAdmin, job, fileId, orgId, errorCode, friendlyMessage, enrichResult.status, message);
          console.log(`[${WORKER_NAME}] enrichment_completed_with_warning file_id=${fileId}: ${friendlyMessage} (original downstream error: ${message})`);
          await logger.event("enrich", "completed_with_warnings", {
            error_code: errorCode,
            error_message: friendlyMessage,
            // original_error preserves exactly what the downstream call
            // returned -- never overwrite/discard it in favor of the
            // friendlier reviewer-facing message above (see PR history for
            // the Craven Wings incident this fixed).
            metadata: { job_id: job.id, status: enrichResult.status, original_error: message },
          });
          return jsonResponse({
            error: false,
            warning: true,
            warning_code: errorCode,
            job_id: job.id,
            stage: "enrich",
            status: "completed_with_warnings",
            message: friendlyMessage,
          }, 200);
        }

        // Guarantee 7: never call parkLeaseForManualReview/failJobAndUpload
        // for an enrich failure — only fail the job row and mark
        // enrichment_status failed. The core minimal payload this job was
        // meant to enhance must remain exactly as it was.
        await failJob(supabaseAdmin, job, errorCode, message);

        // Defensive, best-effort only: never downgrade a row that a racing
        // completion already marked "completed" -- a failed read here must
        // not abandon the compare-and-set below (Reliability Phase R1,
        // point 4), it only skips this specific courtesy check.
        let alreadyCompleted = false;
        try {
          const { data: currentFile } = await supabaseAdmin
            .from("uploaded_files")
            .select("enrichment_status")
            .eq("id", fileId)
            .maybeSingle();
          alreadyCompleted = currentFile?.enrichment_status === "completed";
        } catch {
          // Unknown; proceed with the compare-and-set below.
        }

        if (!alreadyCompleted) {
          const { classification, retryable } = classifyEnrichmentFailure(errorCode, message, enrichResult.status);
          // Reaching this branch structurally requires normalize to have
          // already completed (the worker would not have dispatched an
          // enrich job otherwise) -- core fields already exist, so a
          // resource-exhaustion classification safely resolves to
          // "partial" rather than "failed" without needing a fresh
          // core-ready read.
          const terminalStatus = classification === "resource_exhausted" ? "partial" : "failed";
          const persistResult = await persistEnrichmentTerminalState({
            supabaseAdmin,
            organizationId: orgId,
            fileId,
            generationId: job.generation_id,
            status: terminalStatus,
            errorCode,
            errorMessage: message,
            classification,
            retryable,
            stage: "enrich",
            completedStages: ["parse", "normalize"],
            logger,
          });
          if (persistResult.persisted) {
            console.log(`[${WORKER_NAME}] enrichment_${terminalStatus}_preserved_core_payload file_id=${fileId}: ${message}`);
            // P0.5: terminal enrichment outcome — re-evaluate readiness.
            try {
              const { error: finalizeRpcError } = await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
                p_org_id: orgId,
                p_uploaded_file_id: fileId,
                p_generation_id: job.generation_id,
                p_package_mode: getLeaseDocumentPackageMode(),
                p_financial_mode: getLeaseFinancialScheduleMode(),
              });
              if (finalizeRpcError) {
                console.error(`[${WORKER_NAME}] finalize_lease_extraction_for_review RPC returned an error (review_readiness NOT updated) file_id=${fileId}:`, finalizeRpcError.message);
              }
            } catch (finalizeError: any) {
              console.error(`[${WORKER_NAME}] finalize_lease_extraction_for_review call threw file_id=${fileId}:`, finalizeError?.message ?? finalizeError);
            }
          }
        }
        return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "enrich", message }, 200);
      }

      await supabaseAdmin
        .from("pipeline_jobs")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          metadata: { ...(job.metadata || {}), enrich_completed_at: new Date().toISOString() },
        })
        .eq("id", job.id);

      await logger.event("enrich", "completed", { metadata: { job_id: job.id } });
      return jsonResponse({ error: false, job_id: job.id, stage: "enrich", status: "completed" });
    }

    await failJob(supabaseAdmin, job, "UNKNOWN_STAGE", `Unsupported job stage: ${job.stage}`);
    return jsonResponse({ error: true, error_code: "UNKNOWN_STAGE", message: `Unsupported job stage: ${job.stage}` }, 400);
  } catch (error) {
    console.error(`[${WORKER_NAME}] error:`, error?.message || error);
    return jsonResponse({ error: true, error_code: "WORKER_ERROR", message: error?.message || "Worker failed" }, 500);
  }
});

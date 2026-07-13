// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";
import { setFailed, setStatus } from "../_shared/pipeline-status.ts";
import { MIN_LEASE_TEXT_CHARS } from "../_shared/extraction/pipeline-contract.ts";
import {
  buildInternalFunctionHeaders,
  classifyDownstreamError,
  getMissingWorkerConfig,
  isAuthorizedWorkerCall,
  UNAUTHORIZED_WORKER_RESPONSE,
} from "./auth.ts";

const WORKER_NAME = "lease-extraction-worker";
const PARSE_TIMEOUT_MS = 140_000;
const NORMALIZE_TIMEOUT_MS = 240_000;

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

    return {
      ok: false,
      status: response.status,
      data,
      error_code: classified.error_code,
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

const LEASE_MANUAL_REVIEW_FIELDS = [
  "tenant_name", "landlord_name", "property_name", "property_address", "unit_number",
  "start_date", "end_date", "monthly_rent", "annual_rent", "lease_term_months",
  "square_footage", "lease_type", "security_deposit", "escalation_rate",
  "renewal_options", "ti_allowance", "free_rent_months", "notes",
];

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
) {
  // Never overwrite a valid, already-persisted non-fallback payload — e.g.
  // normalize-pdf-output's minimal early persist, or a fully enriched
  // payload from a prior successful run. A transport failure on THIS
  // attempt does not mean the durable data underneath it is gone.
  const existing = await reconcileDurableNormalize(supabaseAdmin, fileId, orgId);
  if (existing.durable) {
    console.warn(
      `[${WORKER_NAME}] parkLeaseForManualReview skipped for file_id=${fileId} — ` +
      `a valid non-fallback payload already exists (status=${existing.status}, ` +
      `method=${existing.extractionMethod}); failing job without touching ui_review_payload`,
    );
    await failJob(supabaseAdmin, job, errorCode, reason);
    return;
  }

  await failJob(supabaseAdmin, job, errorCode, reason);

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
      metadata: payload.metadata,
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
// parse-pdf-docling persisted its output.
const POST_PARSE_STATUSES = new Set(["pdf_parsed", "validating", "validated", "review_required"]);

/**
 * A "transport-shaped" failure means the HTTP call to parse-pdf-docling or
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

/**
 * Durable-state reconciliation: the database, not the HTTP response, is the
 * authority on whether parsing succeeded. parse-pdf-docling persists
 * docling_raw and flips status to pdf_parsed BEFORE serializing its HTTP
 * response, so a transport failure can arrive after a fully successful parse.
 *
 * Reads only lightweight JSON-path projections — never the whole docling_raw.
 */
async function reconcileDurableParse(supabaseAdmin: any, fileId: string, orgId: string): Promise<{
  durable: boolean;
  status: string | null;
  rawMethod: string;
  fullTextChars: number;
}> {
  const none = { durable: false, status: null, rawMethod: "", fullTextChars: 0 };

  let status: string | null = null;
  let rawMethod = "";
  let fullTextChars = 0;

  const projected = await supabaseAdmin
    .from("uploaded_files")
    .select(
      "id, status, processing_status, extraction_method, " +
      "raw_extraction_method:docling_raw->>extraction_method, " +
      "raw_provider:docling_raw->_metadata->>provider, " +
      "metadata_full_text_chars:docling_raw->_metadata->>full_text_chars",
    )
    .eq("id", fileId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!projected.error && projected.data) {
    status = projected.data.status ?? null;
    rawMethod = String(projected.data.raw_extraction_method || "");
    fullTextChars = Number(projected.data.metadata_full_text_chars || 0);
  } else {
    // Aliased JSON-path projection unsupported or failed — fall back to plain
    // columns plus a non-aliased JSON-path query. Still never the full JSONB.
    console.warn(
      `[${WORKER_NAME}] aliased JSON-path reconciliation select failed ` +
      `(${projected.error?.message ?? "no row"}); using fallback projection`,
    );
    const basic = await supabaseAdmin
      .from("uploaded_files")
      .select("id, status, processing_status, extraction_method")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (basic.error || !basic.data) return none;
    status = basic.data.status ?? null;

    const jsonPaths = await supabaseAdmin
      .from("uploaded_files")
      .select("docling_raw->>extraction_method, docling_raw->>full_text")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (jsonPaths.error || !jsonPaths.data) return none;
    rawMethod = String(jsonPaths.data.extraction_method || "");
    fullTextChars = String(jsonPaths.data.full_text || "").length;
  }

  // Older rows may lack _metadata.full_text_chars — measure the text string
  // itself (a string projection, not the whole docling_raw object).
  if (!fullTextChars && VALID_DURABLE_PARSER_METHODS.has(rawMethod)) {
    const textOnly = await supabaseAdmin
      .from("uploaded_files")
      .select("docling_raw->>full_text")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (!textOnly.error && textOnly.data) {
      fullTextChars = String(textOnly.data.full_text || "").length;
    }
  }

  const durable =
    VALID_DURABLE_PARSER_METHODS.has(rawMethod) &&
    fullTextChars >= MIN_LEASE_TEXT_CHARS &&
    POST_PARSE_STATUSES.has(String(status));

  return { durable, status, rawMethod, fullTextChars };
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
 * Reads only lightweight JSON-path projections — never the whole
 * ui_review_payload/normalized_output objects.
 */
async function reconcileDurableNormalize(supabaseAdmin: any, fileId: string, orgId: string): Promise<{
  durable: boolean;
  status: string | null;
  extractionMethod: string;
  hasRecords: boolean;
}> {
  const none = { durable: false, status: null, extractionMethod: "", hasRecords: false };

  let status: string | null = null;
  let extractionMethod = "";
  let hasRecords = false;

  const projected = await supabaseAdmin
    .from("uploaded_files")
    .select(
      "id, status, extraction_method, " +
      "payload_method:ui_review_payload->>extraction_method, " +
      "payload_records:ui_review_payload->records",
    )
    .eq("id", fileId)
    .eq("org_id", orgId)
    .maybeSingle();

  if (!projected.error && projected.data) {
    status = projected.data.status ?? null;
    extractionMethod = String(projected.data.payload_method || projected.data.extraction_method || "");
    hasRecords = Array.isArray(projected.data.payload_records) && projected.data.payload_records.length > 0;
  } else {
    console.warn(
      `[${WORKER_NAME}] aliased JSON-path normalize reconciliation select failed ` +
      `(${projected.error?.message ?? "no row"}); using fallback projection`,
    );
    const basic = await supabaseAdmin
      .from("uploaded_files")
      .select("id, status, extraction_method, ui_review_payload")
      .eq("id", fileId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (basic.error || !basic.data) return none;
    status = basic.data.status ?? null;
    const payload = basic.data.ui_review_payload || {};
    extractionMethod = String(payload.extraction_method || basic.data.extraction_method || "");
    hasRecords = Array.isArray(payload.records) && payload.records.length > 0;
  }

  const isFallback = !extractionMethod || extractionMethod === "manual_review_fallback";
  const durable = POST_NORMALIZE_STATUSES.has(String(status)) && hasRecords && !isFallback;

  return { durable, status, extractionMethod, hasRecords };
}

// Test hook (same pattern as _shared/extraction/parser.ts).
export const __test__ = {
  isTransportShapedFailure,
  reconcileDurableParse,
  reconcileDurableNormalize,
  parkLeaseForManualReview,
  isCancelRequested,
  stopForCancellation,
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

    if (["completed", "failed", "cancelled"].includes(job.status)) {
      return jsonResponse({ error: false, job_id: job.id, status: job.status, stage: job.stage });
    }

    // Guard against running a job that has already exceeded its attempt budget.
    // max_attempts defaults to 3 (set at job creation in ingest-file).
    const currentAttempt = Number(job.attempt || 0);
    const maxAttempts = Number(job.max_attempts || 3);
    if (currentAttempt >= maxAttempts) {
      const message = `Job exceeded max_attempts (${currentAttempt}/${maxAttempts})`;
      await failJobAndUpload(supabaseAdmin, job, fileId, "MAX_ATTEMPTS_EXCEEDED", message, job.stage ?? "parse", 15);
      return jsonResponse({ error: true, error_code: "MAX_ATTEMPTS_EXCEEDED", job_id: job.id, message }, 200);
    }

    const { data: fileRecord, error: fileError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, status, file_name, module_type, document_subtype")
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

    const attempt = Number(job.attempt || 0) + 1;
    await supabaseAdmin
      .from("pipeline_jobs")
      .update({
        status: "running",
        attempt,
        worker_name: WORKER_NAME,
        started_at: job.started_at ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    // Run parse and normalize sequentially in a single invocation.
    // The original two-stage self-dispatch pattern (dispatchSelf) was unreliable:
    // when EdgeRuntime.waitUntil is unavailable the fire-and-forget fetch is
    // cancelled before the TCP connection is established, so normalize never ran.
    let currentStage = job.stage;

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
        parseResult = await callInternalFunction("parse-pdf-docling", { file_id: fileId }, orgId, PARSE_TIMEOUT_MS);
      } catch (transportErr: any) {
        // callInternalFunction handles fetch/timeout errors internally today,
        // but keep this guard so a future refactor can never bypass the
        // durable-state reconciliation below by throwing instead.
        parseResult = {
          ok: false,
          status: 500,
          data: {},
          error_code: "NETWORK_ERROR",
          retryable: true,
          error: transportErr?.message || "parse-pdf-docling transport failure",
        };
      }

      // Durable-state reconciliation: a transport-shaped failure (timeout,
      // 546 compute kill, gateway 5xx) can arrive AFTER parse-pdf-docling
      // already persisted a successful parse. The database is authoritative —
      // re-read it before treating the parse as failed, and never overwrite a
      // durable success with manual_review_fallback.
      let parseReconciledToNormalize = false;
      if (!parseResult.ok && isTransportShapedFailure(parseResult)) {
        const reconciled = await reconcileDurableParse(supabaseAdmin, fileId, orgId);
        if (reconciled.durable) {
          console.warn(
            `[${WORKER_NAME}] parse_transport_failed_but_persisted file_id=${fileId} ` +
            `durable_status=${reconciled.status} method=${reconciled.rawMethod} ` +
            `chars=${reconciled.fullTextChars} http_status=${parseResult.status}`,
          );
          await logger.event("parse", "reconciled", {
            provider: "lease-extraction-worker",
            metadata: {
              job_id: job.id,
              reason: "parse_transport_failed_but_persisted",
              durable_status: reconciled.status,
              parser_method: reconciled.rawMethod,
              full_text_chars: reconciled.fullTextChars,
              transport_status: parseResult.status,
              transport_error: String(parseResult.error || "").slice(0, 300),
            },
          });

          if (reconciled.status === "pdf_parsed") {
            // Parse persisted; continue to normalize via the guarded stage
            // claim below (same path as a normal parse success).
            parseReconciledToNormalize = true;
          } else if (reconciled.status === "validated" || reconciled.status === "review_required") {
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
          // Any other durable status falls through to the normal failure path.
        }
      }

      if (!parseResult.ok && !parseReconciledToNormalize) {
        const message = parseResult.error || "Document parsing failed";
        const errorCode = parseResult.data?.error_code || parseResult.error_code || "PARSE_FAILED";
        const isLeaseModule = ["leases", "lease"].includes(fileRecord.module_type ?? "");

        if (isLeaseModule && parserFailureAlreadyPersisted(parseResult)) {
          // parse-pdf-docling already persisted a blocked parser state with
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
          // For lease files, park for manual review so users can enter fields
          // manually instead of showing a hard failure with no path forward.
          await parkLeaseForManualReview(
            supabaseAdmin, job, fileId, orgId,
            fileRecord.file_name ?? "Lease document",
            fileRecord.module_type ?? "leases",
            fileRecord.document_subtype ?? "base_lease",
            errorCode, message, "parse",
          );
          await logger.event("parse", "failed", {
            error_code: errorCode,
            error_message: message,
            metadata: { job_id: job.id, status: parseResult.status, parked_for_manual_review: true },
          });
          return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "parse", parked_for_manual_review: true, message }, 200);
        }

        await failJobAndUpload(supabaseAdmin, job, fileId, errorCode, message, "parse", 15);
        await logger.event("parse", "failed", {
          error_code: errorCode,
          error_message: message,
          metadata: { job_id: job.id, status: parseResult.status, retryable: Boolean(parseResult.retryable) },
        });
        return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "parse", message }, 200);
      }

      // Concurrency guard: only advance parse → normalize if no other worker
      // attempt already did. Without the stage predicate, two overlapping
      // attempts (e.g. a retry racing a reconciled run) would both dispatch
      // normalize-pdf-output.
      const { data: claimedJob, error: claimError } = await supabaseAdmin
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

      if (claimError || !claimedJob) {
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

      // Fast re-extraction path: when the job is enqueued directly at the
      // "normalize" stage (docling_raw already had usable text, so OCR was
      // skipped), the file status is still "parsing" from enqueueLeaseExtractionJob
      // — it never passed through parse-pdf-docling, which is what normally
      // transitions status to "pdf_parsed". Without this, normalize-pdf-output's
      // status guard rejects the call with "File status must be 'pdf_parsed'.
      // Current: 'parsing'". setStatus is a no-op when already "pdf_parsed"
      // (the path that came from the "parse" branch above).
      const pdfParsedTransition = await setStatus(supabaseAdmin, fileId, "pdf_parsed", {
        processing_status: "pdf_parsed",
      });
      if (pdfParsedTransition.error) {
        console.error(
          `[${WORKER_NAME}] Failed to transition to pdf_parsed before normalize stage:`,
          pdfParsedTransition.error.message,
        );
      }

      await logger.event("normalize", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const normalizeResult = await callInternalFunction("normalize-pdf-output", { file_id: fileId, pipeline_job_id: job.id, worker_attempt: attempt }, orgId, NORMALIZE_TIMEOUT_MS);
      if (!normalizeResult.ok) {
        const message = normalizeResult.error || "Document normalization failed";
        const errorCode = normalizeResult.error_code || normalizeResult.data?.error_code || "NORMALIZE_FAILED";
        const isLeaseModule = ["leases", "lease"].includes(fileRecord.module_type ?? "");

        // Durable-state reconciliation: normalize-pdf-output now persists a
        // minimal core-field payload BEFORE running its expensive
        // workflow/clause/evidence pass. A transport-shaped failure (OOM,
        // timeout, 546 compute kill) can arrive after that payload — or the
        // full enriched one — already landed. Re-read before parking.
        if (isTransportShapedFailure(normalizeResult)) {
          const reconciled = await reconcileDurableNormalize(supabaseAdmin, fileId, orgId);
          if (reconciled.durable) {
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
        }

        if (isLeaseModule) {
          await parkLeaseForManualReview(
            supabaseAdmin, job, fileId, orgId,
            fileRecord.file_name ?? "Lease document",
            fileRecord.module_type ?? "leases",
            fileRecord.document_subtype ?? "base_lease",
            errorCode, message, "normalize",
          );
          await logger.event("normalize", "failed", {
            error_code: errorCode,
            error_message: message,
            metadata: { job_id: job.id, status: normalizeResult.status, parked_for_manual_review: true },
          });
          return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "normalize", parked_for_manual_review: true, message }, 200);
        }

        await failJobAndUpload(supabaseAdmin, job, fileId, errorCode, message, "normalize", 45);
        await logger.event("normalize", "failed", {
          error_code: errorCode,
          error_message: message,
          metadata: { job_id: job.id, status: normalizeResult.status, retryable: Boolean(normalizeResult.retryable) },
        });
        return jsonResponse({ error: true, error_code: errorCode, job_id: job.id, stage: "normalize", message }, 200);
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
          },
        })
        .eq("id", job.id);

      await logger.event("normalize", "completed", {
        metadata: { job_id: job.id },
      });
      return jsonResponse({ error: false, job_id: job.id, stage: "normalize", status: "completed" });
    }

    await failJob(supabaseAdmin, job, "UNKNOWN_STAGE", `Unsupported job stage: ${job.stage}`);
    return jsonResponse({ error: true, error_code: "UNKNOWN_STAGE", message: `Unsupported job stage: ${job.stage}` }, 400);
  } catch (error) {
    console.error(`[${WORKER_NAME}] error:`, error?.message || error);
    return jsonResponse({ error: true, error_code: "WORKER_ERROR", message: error?.message || "Worker failed" }, 500);
  }
});

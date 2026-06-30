// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";
import { setFailed, setStatus } from "../_shared/pipeline-status.ts";
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
  fileName: string,
  moduleType: string,
  documentSubtype: string,
  errorCode: string,
  reason: string,
) {
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

  const payload = {
    schema_version: 2,
    file_id: fileId,
    file_name: fileName,
    module_type: moduleType,
    document_subtype: documentSubtype || "base_lease",
    extraction_method: "manual_review_fallback",
    pipeline_method: "parse_failed_manual_review",
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
      parse_failed: true,
      error_code: errorCode,
      error_message: reason,
    },
    built_at: new Date().toISOString(),
  };

  const { error } = await setStatus(supabaseAdmin, fileId, "review_required", {
    review_required: true,
    review_status: "pending",
    processing_status: "parse_failed_manual_review",
    extraction_method: "manual_review_fallback",
    ui_review_payload: payload,
    normalized_output: {
      method: "parse_failed_manual_review",
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
    failed_step: "parse",
    processing_completed_at: new Date().toISOString(),
  });

  if (error && error.code !== "NO_ROW_UPDATED") {
    console.error(`[${WORKER_NAME}] parkLeaseForManualReview setStatus error:`, error.message);
    await setFailed(supabaseAdmin, fileId, reason, "parse", 15);
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
      await logger.event("parse", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const parseResult = await callInternalFunction("parse-pdf-docling", { file_id: fileId }, orgId, PARSE_TIMEOUT_MS);
      if (!parseResult.ok) {
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
            supabaseAdmin, job, fileId,
            fileRecord.file_name ?? "Lease document",
            fileRecord.module_type ?? "leases",
            fileRecord.document_subtype ?? "base_lease",
            errorCode, message,
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

      await supabaseAdmin
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
          },
        })
        .eq("id", job.id);

      await logger.event("parse", "completed", {
        metadata: { job_id: job.id, next_stage: "normalize" },
      });

      console.log(`[${WORKER_NAME}] parse done, proceeding directly to normalize for file_id=${fileId}`);
      currentStage = "normalize";
    }

    if (currentStage === "normalize") {
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

        if (isLeaseModule) {
          await parkLeaseForManualReview(
            supabaseAdmin, job, fileId,
            fileRecord.file_name ?? "Lease document",
            fileRecord.module_type ?? "leases",
            fileRecord.document_subtype ?? "base_lease",
            errorCode, message,
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

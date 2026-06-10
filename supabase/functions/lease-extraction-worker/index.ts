// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { createAdminClient } from "../_shared/supabase.ts";
import { createLogger } from "../_shared/logger.ts";
import { setFailed } from "../_shared/pipeline-status.ts";
import { isAuthorizedWorkerCall, UNAUTHORIZED_WORKER_RESPONSE } from "./auth.ts";

const WORKER_NAME = "lease-extraction-worker";
const STAGE_TIMEOUT_MS = 140_000;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function serviceHeaders(orgId: string) {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const workerSecret = Deno.env.get("WORKER_INTERNAL_SECRET") ?? "";
  return {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${serviceKey}`,
    "apikey": serviceKey,
    "x-internal-service-key": serviceKey,
    "x-internal-org-id": orgId,
    ...(workerSecret ? { "x-worker-secret": workerSecret } : {}),
  };
}

async function callInternalFunction(functionName: string, body: Record<string, unknown>, orgId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const response = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
    method: "POST",
    headers: serviceHeaders(orgId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(STAGE_TIMEOUT_MS),
  });

  const text = await response.text().catch(() => "");
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw_response: text.slice(0, 500) };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data,
      error: data?.message || data?.error_details || data?.error_code || text.slice(0, 500) || `HTTP ${response.status}`,
    };
  }

  return { ok: true, status: response.status, data, error: "" };
}

function dispatchSelf(fileId: string, jobId: string, orgId: string) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const promise = fetch(`${supabaseUrl}/functions/v1/${WORKER_NAME}`, {
    method: "POST",
    headers: serviceHeaders(orgId),
    body: JSON.stringify({ job_id: jobId }),
  }).catch((error) => {
    console.error(`[${WORKER_NAME}] self-dispatch failed:`, error?.message || error);
  });

  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(promise);
  }
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!isAuthorizedWorkerCall(req)) {
      return jsonResponse(UNAUTHORIZED_WORKER_RESPONSE, 401);
    }

    const supabaseAdmin = createAdminClient();
    const body = await req.json().catch(() => ({}));
    const jobId = body.job_id;

    if (!jobId) {
      return jsonResponse({ error: true, error_code: "MISSING_JOB_INPUT", message: "job_id is required" }, 400);
    }

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

    const { data: fileRecord, error: fileError } = await supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, status, file_name, module_type")
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

    if (job.stage === "parse") {
      await logger.event("parse", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const parseResult = await callInternalFunction("parse-pdf-docling", { file_id: fileId }, orgId);
      if (!parseResult.ok) {
        const message = parseResult.error || "Document parsing failed";
        await failJob(supabaseAdmin, job, parseResult.data?.error_code || "PARSE_FAILED", message);

        const { data: latestFile } = await supabaseAdmin
          .from("uploaded_files")
          .select("status")
          .eq("id", fileId)
          .maybeSingle();

        if (latestFile?.status !== "failed") {
          await setFailed(supabaseAdmin, fileId, message, "parse", 15);
        }

        await logger.event("parse", "failed", {
          error_code: parseResult.data?.error_code || "PARSE_FAILED",
          error_message: message,
          metadata: { job_id: job.id, status: parseResult.status },
        });
        return jsonResponse({ error: true, job_id: job.id, stage: "parse", message }, 200);
      }

      await supabaseAdmin
        .from("pipeline_jobs")
        .update({
          stage: "normalize",
          status: "queued",
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
      dispatchSelf(fileId, job.id, orgId);
      return jsonResponse({ error: false, job_id: job.id, stage: "normalize", status: "queued" });
    }

    if (job.stage === "normalize") {
      await logger.event("normalize", "running", {
        provider: "lease-extraction-worker",
        metadata: { job_id: job.id, attempt },
      });

      const normalizeResult = await callInternalFunction("normalize-pdf-output", { file_id: fileId }, orgId);
      if (!normalizeResult.ok) {
        const message = normalizeResult.error || "Document normalization failed";
        await failJob(supabaseAdmin, job, normalizeResult.data?.error_code || "NORMALIZE_FAILED", message);

        const { data: latestFile } = await supabaseAdmin
          .from("uploaded_files")
          .select("status")
          .eq("id", fileId)
          .maybeSingle();

        if (latestFile?.status !== "failed") {
          await setFailed(supabaseAdmin, fileId, message, "normalize", 45);
        }

        await logger.event("normalize", "failed", {
          error_code: normalizeResult.data?.error_code || "NORMALIZE_FAILED",
          error_message: message,
          metadata: { job_id: job.id, status: normalizeResult.status },
        });
        return jsonResponse({ error: true, job_id: job.id, stage: "normalize", message }, 200);
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

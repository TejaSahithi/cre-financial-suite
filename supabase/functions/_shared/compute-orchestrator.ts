// @ts-nocheck
import { setStatus, setFailed, STATUS_PROGRESS } from "./pipeline-status.ts";
import { createLogger, type PipelineLogger } from "./logger.ts";

/**
 * Compute Orchestrator
 *
 * Triggers compute engines after store-data completes.
 * - Retries each failed job up to MAX_RETRIES times with exponential backoff
 * - Logs failure reason in uploaded_files.failed_step
 * - Does NOT mark pipeline as completed if any compute job fails after all retries
 */

export type ModuleType =
  | "leases"
  | "expenses"
  | "properties"
  | "revenue"
  | "cam"
  | "budgets"
  | "buildings"
  | "units"
  | "tenants"
  | "invoices"
  | "gl_accounts"
  | "documents";

interface ComputeJob {
  functionName: string;
  body: Record<string, unknown>;
  /** engine_type column in compute_runs — derived from functionName */
  engineType: ComputeEngineType;
  /** property_id + fiscal_year for the compute_runs row */
  propertyId?: string | null;
  fiscalYear?: number | null;
}

interface JobResult {
  job: ComputeJob;
  ok: boolean;
  attempts: number;
  lastError: string;
  /** compute_runs row id; null if the insert failed (non-fatal) */
  runId: string | null;
  startedAt: number;
}

type ComputeEngineType =
  | "lease"
  | "revenue"
  | "budget"
  | "expense"
  | "cam"
  | "reconciliation";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s

/** Map the edge function name to the engine_type value stored in compute_runs. */
function engineTypeForFunction(fn: string): ComputeEngineType {
  if (fn === "compute-lease") return "lease";
  if (fn === "compute-revenue") return "revenue";
  if (fn === "compute-budget") return "budget";
  if (fn === "compute-expense") return "expense";
  if (fn === "compute-cam") return "cam";
  if (fn === "compute-reconciliation") return "reconciliation";
  // Default to the module it most closely resembles to satisfy the CHECK.
  return "reconciliation";
}

/**
 * Stable fingerprint for the compute trigger inputs.
 */
async function fingerprint(parts: Array<string | number | null | undefined>): Promise<string> {
  const source = parts
    .map((p) => (p === undefined || p === null ? "" : String(p)))
    .join("|");
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Insert the starting compute_runs row. Returns the new row id, or null
 * if the insert fails — compute execution proceeds either way since the
 * audit row is advisory, not required for correctness.
 */
async function recordRunStart(args: {
  supabaseAdmin: any;
  orgId: string;
  fileId: string;
  job: ComputeJob;
}): Promise<string | null> {
  try {
    const { supabaseAdmin, orgId, fileId, job } = args;
    const fp = await fingerprint([
      orgId,
      job.propertyId ?? "",
      job.fiscalYear ?? "",
      job.engineType,
      fileId,
    ]);
    const { data, error } = await supabaseAdmin
      .from("compute_runs")
      .insert({
        org_id: orgId,
        property_id: job.propertyId ?? null,
        engine_type: job.engineType,
        fiscal_year: job.fiscalYear ?? null,
        source_file_id: fileId,
        triggered_by: "upload",
        input_fingerprint: fp,
        input_summary: { body: job.body },
        status: "running",
      })
      .select("id")
      .single();

    if (error) {
      console.warn(`[compute-orchestrator] compute_runs insert failed: ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.warn(`[compute-orchestrator] compute_runs insert threw: ${err.message}`);
    return null;
  }
}

/**
 * Close out a compute_runs row with the terminal status + duration.
 * Best-effort — logs but never throws.
 */
async function recordRunFinish(args: {
  supabaseAdmin: any;
  runId: string | null;
  ok: boolean;
  attempts: number;
  startedAt: number;
  errorMessage?: string;
}): Promise<void> {
  if (!args.runId) return;
  const durationMs = Math.max(0, Date.now() - args.startedAt);
  const status = args.ok ? "completed" : "failed";
  try {
    const { error } = await args.supabaseAdmin
      .from("compute_runs")
      .update({
        status,
        completed_at: new Date().toISOString(),
        duration_ms: durationMs,
        output_summary: { attempts: args.attempts },
        error_message: args.ok ? null : args.errorMessage?.slice(0, 500) ?? null,
      })
      .eq("id", args.runId);
    if (error) {
      console.warn(
        `[compute-orchestrator] compute_runs finish update failed: ${error.message}`,
      );
    }
  } catch (err) {
    console.warn(`[compute-orchestrator] compute_runs finish threw: ${err.message}`);
  }
}

function createComputeJob(functionName: string, body: Record<string, unknown>, propertyId: string, fiscalYear: number): ComputeJob {
  return {
    functionName,
    body,
    engineType: engineTypeForFunction(functionName),
    propertyId,
    fiscalYear,
  };
}

function getComputeJobs(moduleType: ModuleType, propertyIds: string[], fiscalYear: number): ComputeJob[] {
  const jobs: ComputeJob[] = [];
  if (propertyIds.length === 0) return jobs;

  for (const pid of propertyIds) {
    switch (moduleType) {
      case "leases":
        jobs.push(createComputeJob("compute-lease", { property_id: pid, fiscal_year: fiscalYear }, pid, fiscalYear));
        jobs.push(createComputeJob("compute-revenue", { property_id: pid, fiscal_year: fiscalYear }, pid, fiscalYear));
        jobs.push(createComputeJob("compute-budget", { property_id: pid, fiscal_year: fiscalYear, action: "generate" }, pid, fiscalYear));
        break;
      case "expenses":
        jobs.push(createComputeJob("compute-expense", { property_id: pid, fiscal_year: fiscalYear }, pid, fiscalYear));
        jobs.push(createComputeJob("compute-cam", { property_id: pid, fiscal_year: fiscalYear }, pid, fiscalYear));
        jobs.push(createComputeJob("compute-budget", { property_id: pid, fiscal_year: fiscalYear, action: "generate" }, pid, fiscalYear));
        break;
      case "revenue":
        jobs.push(createComputeJob("compute-revenue", { property_id: pid, fiscal_year: fiscalYear }, pid, fiscalYear));
        jobs.push(createComputeJob("compute-budget", { property_id: pid, fiscal_year: fiscalYear, action: "generate" }, pid, fiscalYear));
        break;
      case "cam":
        jobs.push(createComputeJob("compute-cam", { property_id: pid, fiscal_year: fiscalYear }, pid, fiscalYear));
        jobs.push(createComputeJob("compute-budget", { property_id: pid, fiscal_year: fiscalYear, action: "generate" }, pid, fiscalYear));
        break;
      case "budgets":
        jobs.push(createComputeJob("compute-budget", { property_id: pid, fiscal_year: fiscalYear, action: "generate" }, pid, fiscalYear));
        break;
      case "properties":
      case "buildings":
      case "units":
      case "tenants":
      case "invoices":
      case "gl_accounts":
      case "documents":
        break; // reference data — no compute needed
    }
  }

  return jobs;
}

/** Single HTTP call to an Edge Function. Returns ok + error text. */
async function callOnce(
  supabaseUrl: string,
  functionName: string,
  body: Record<string, unknown>,
  serviceKey: string,
  orgId: string,
  fileId: string,
): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": serviceKey,
        "x-internal-service-key": serviceKey,
        "x-internal-org-id": orgId,
        "x-source-file-id": fileId,
        "x-compute-trigger": "upload",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "no response body");
      return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }

    return { ok: true, error: "" };
  } catch (err) {
    return { ok: false, error: err.message ?? "network error" };
  }
}

/**
 * Call an Edge Function with up to MAX_RETRIES attempts.
 * Uses exponential backoff: 1s, 2s, 4s between attempts.
 * Returns the final result and total attempts made.
 */
async function callWithRetry(
  supabaseUrl: string,
  functionName: string,
  body: Record<string, unknown>,
  serviceKey: string,
  orgId: string,
  fileId: string,
): Promise<{ ok: boolean; attempts: number; lastError: string }> {
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await callOnce(supabaseUrl, functionName, body, serviceKey, orgId, fileId);

    if (result.ok) {
      console.log(`[compute-orchestrator] ${functionName} OK (attempt ${attempt})`);
      return { ok: true, attempts: attempt, lastError: "" };
    }

    lastError = result.error;
    console.warn(`[compute-orchestrator] ${functionName} failed (attempt ${attempt}/${MAX_RETRIES}): ${lastError}`);

    if (attempt < MAX_RETRIES) {
      const delayMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(`[compute-orchestrator] Retrying ${functionName} in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  console.error(`[compute-orchestrator] ${functionName} exhausted all ${MAX_RETRIES} retries. Last error: ${lastError}`);
  return { ok: false, attempts: MAX_RETRIES, lastError };
}

/**
 * Resolve property_ids from trusted stored scope only.
 */
export async function resolvePropertyIds(
  fileRecord: Record<string, any>,
  validData: Record<string, any>[],
  moduleType: ModuleType,
  orgId: string,
  supabaseAdmin: any,
): Promise<string[]> {
  if (fileRecord.property_id && typeof fileRecord.property_id === "string") {
    return [fileRecord.property_id];
  }

  const fromRows = [
    ...new Set(
      validData
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (fromRows.length > 0) return fromRows;
  return [];
}

function deriveFiscalYear(
  fileRecord: Record<string, any>,
  validData: Record<string, any>[],
): number | null {
  const explicitYear = Number(fileRecord?.fiscal_year ?? validData?.[0]?.fiscal_year ?? 0);
  if (Number.isFinite(explicitYear) && explicitYear >= 2000 && explicitYear <= 3000) {
    return explicitYear;
  }

  const dateSources = [
    fileRecord?.effective_date,
    fileRecord?.date,
    ...validData.flatMap((row) => [row?.effective_date, row?.date, row?.start_date]),
  ].filter(Boolean);

  for (const source of dateSources) {
    const parsed = new Date(String(source));
    const year = parsed.getUTCFullYear();
    if (Number.isFinite(year) && year >= 2000 && year <= 3000) {
      return year;
    }
  }

  return null;
}

/**
 * Main orchestration entry point. Called fire-and-forget after store-data.
 *
 * Behaviour:
 * - Each job is retried up to MAX_RETRIES times with exponential backoff
 * - If ALL jobs succeed → status = "completed"
 * - If ANY job fails after all retries → status = "failed", failed_step records which functions failed
 */
export async function triggerComputePipeline(opts: {
  fileId: string;
  moduleType: ModuleType;
  orgId: string;
  validData: Record<string, any>[];
  fileRecord: Record<string, any>;
  supabaseAdmin: any;
  log?: PipelineLogger;
}): Promise<void> {
  const { fileId, moduleType, orgId, validData, fileRecord, supabaseAdmin } = opts;
  const log = opts.log ?? createLogger(supabaseAdmin, fileId, orgId);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    console.warn("[compute-orchestrator] Missing env vars — skipping compute");
    return;
  }

  try {
    const statusResult = await setStatus(supabaseAdmin, fileId, "computing");
    if (!statusResult?.ok) {
      throw new Error(statusResult?.error || "Failed to set computing status");
    }

    const propertyIds = await resolvePropertyIds(fileRecord, validData, moduleType, orgId, supabaseAdmin);
    const fiscalYear = deriveFiscalYear(fileRecord, validData);

    if (["leases", "expenses", "revenue", "cam", "budgets"].includes(moduleType)) {
      if (propertyIds.length === 0) {
        throw new Error(`Unable to resolve property scope for compute module ${moduleType}`);
      }
      if (!fiscalYear) {
        throw new Error(`Unable to resolve fiscal year for compute module ${moduleType}`);
      }
    }

    await log.info("compute", `Starting compute: module=${moduleType} properties=[${propertyIds.join(",")}] fy=${fiscalYear ?? "n/a"}`, { module: moduleType, property_ids: propertyIds, fiscal_year: fiscalYear });

    const jobs = getComputeJobs(moduleType, propertyIds, fiscalYear ?? 0);

    if (jobs.length === 0) {
      await log.info("compute", `No compute jobs needed for module=${moduleType}`);
      await setStatus(supabaseAdmin, fileId, "completed", {
        processing_completed_at: new Date().toISOString(),
      });
      return;
    }

    // Run all jobs sequentially so retries don't flood the system.
    // Each job is independent — a failure in one does not skip others.
    const results: JobResult[] = [];

    for (const job of jobs) {
      await log.info(`compute:${job.functionName}`, `Starting ${job.functionName}`, { body: job.body });
      const startedAt = Date.now();
      const runId = await recordRunStart({
        supabaseAdmin,
        orgId,
        fileId,
        job,
      });
      const result = await callWithRetry(supabaseUrl, job.functionName, job.body, serviceKey, orgId, fileId);
      await recordRunFinish({
        supabaseAdmin,
        runId,
        ok: result.ok,
        attempts: result.attempts,
        startedAt,
        errorMessage: result.lastError,
      });
      results.push({ job, ...result, runId, startedAt });
      if (result.ok) {
        await log.info(`compute:${job.functionName}`, `Completed in ${result.attempts} attempt(s)`);
      } else {
        await log.error(`compute:${job.functionName}`, `Failed after ${result.attempts} attempts: ${result.lastError}`, { attempts: result.attempts, error: result.lastError });
      }
    }

    // Separate successes from permanent failures
    const failed = results.filter((r) => !r.ok);
    const succeeded = results.filter((r) => r.ok);

    console.log(
      `[compute-orchestrator] Done. ${succeeded.length}/${jobs.length} succeeded, ${failed.length} failed.`,
    );

    if (failed.length === 0) {
      await log.info("compute", `All ${jobs.length} compute jobs succeeded`);
      await setStatus(supabaseAdmin, fileId, "completed", {
        processing_completed_at: new Date().toISOString(),
      });
    } else {
      const failedNames = failed.map((r) => r.job.functionName).join(", ");
      const failedDetails = failed
        .map((r) => `${r.job.functionName} (${r.attempts} attempts): ${r.lastError}`)
        .join(" | ");

      await log.error("compute", `${failed.length} compute job(s) failed permanently: ${failedNames}`, { failed_jobs: failedNames, details: failedDetails });

      await setFailed(
        supabaseAdmin,
        fileId,
        `Compute failed after ${MAX_RETRIES} retries: ${failedDetails.slice(0, 500)}`,
        `computing:${failedNames}`,
        STATUS_PROGRESS.computing,
      );
    }

  } catch (err) {
    console.error("[compute-orchestrator] Unexpected error:", err.message);
    await log.error("compute", `Unexpected orchestrator error: ${err.message}`);
    await setFailed(supabaseAdmin, fileId, err.message, "computing", STATUS_PROGRESS.computing);
  }
}

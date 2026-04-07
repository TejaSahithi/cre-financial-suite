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
  | "budgets";

interface ComputeJob {
  functionName: string;
  body: Record<string, unknown>;
}

interface JobResult {
  job: ComputeJob;
  ok: boolean;
  attempts: number;
  lastError: string;
}

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s, 2s, 4s

function getComputeJobs(moduleType: ModuleType, propertyIds: string[], fiscalYear: number): ComputeJob[] {
  const jobs: ComputeJob[] = [];
  if (propertyIds.length === 0) return jobs;

  for (const pid of propertyIds) {
    switch (moduleType) {
      case "leases":
        jobs.push({ functionName: "compute-lease",   body: { property_id: pid, fiscal_year: fiscalYear } });
        jobs.push({ functionName: "compute-revenue", body: { property_id: pid, fiscal_year: fiscalYear } });
        jobs.push({ functionName: "compute-budget",  body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        break;
      case "expenses":
        jobs.push({ functionName: "compute-expense", body: { property_id: pid, fiscal_year: fiscalYear } });
        jobs.push({ functionName: "compute-cam",     body: { property_id: pid, fiscal_year: fiscalYear } });
        jobs.push({ functionName: "compute-budget",  body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        break;
      case "revenue":
        jobs.push({ functionName: "compute-revenue", body: { property_id: pid, fiscal_year: fiscalYear } });
        jobs.push({ functionName: "compute-budget",  body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        break;
      case "cam":
        jobs.push({ functionName: "compute-cam",    body: { property_id: pid, fiscal_year: fiscalYear } });
        jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        break;
      case "budgets":
        jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        break;
      case "properties":
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
): Promise<{ ok: boolean; error: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/${functionName}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${serviceKey}`,
        "apikey": serviceKey,
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
): Promise<{ ok: boolean; attempts: number; lastError: string }> {
  let lastError = "";

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const result = await callOnce(supabaseUrl, functionName, body, serviceKey);

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
 * Resolve property_ids using a 4-level priority chain:
 * 1. fileRecord.property_id  (set at upload time)
 * 2. validData rows
 * 3. DB lookup on the just-stored table
 * 4. Org-level fallback
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

  const tableMap: Partial<Record<ModuleType, string>> = {
    leases: "leases",
    expenses: "expenses",
    revenue: "revenues",
  };
  const table = tableMap[moduleType];
  if (table) {
    const { data } = await supabaseAdmin
      .from(table)
      .select("property_id")
      .eq("org_id", orgId)
      .not("property_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(50);

    if (data && data.length > 0) {
      const ids = [...new Set(data.map((r: any) => r.property_id).filter(Boolean))];
      if (ids.length > 0) return ids as string[];
    }
  }

  const { data: props } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("org_id", orgId)
    .limit(20);

  return props?.map((p: any) => p.id) ?? [];
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
    await setStatus(supabaseAdmin, fileId, "computing");

    const propertyIds = await resolvePropertyIds(fileRecord, validData, moduleType, orgId, supabaseAdmin);
    const fiscalYear = new Date().getFullYear();

    await log.info("compute", `Starting compute: module=${moduleType} properties=[${propertyIds.join(",")}] fy=${fiscalYear}`, { module: moduleType, property_ids: propertyIds, fiscal_year: fiscalYear });

    const jobs = getComputeJobs(moduleType, propertyIds, fiscalYear);

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
      const result = await callWithRetry(supabaseUrl, job.functionName, job.body, serviceKey);
      results.push({ job, ...result });
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

// @ts-nocheck
import { setStatus, setFailed, STATUS_PROGRESS } from "./pipeline-status.ts";
/**
 * Compute Orchestrator
 *
 * Triggers the appropriate compute engines after store-data completes.
 * Called fire-and-forget — errors are logged but never break the pipeline.
 *
 * Module → compute engines mapping:
 *   leases    → compute-lease, compute-revenue, compute-budget
 *   expenses  → compute-expense, compute-cam, compute-budget
 *   revenue   → compute-revenue, compute-budget
 *   properties → (no compute needed — properties are reference data)
 *   cam       → compute-cam, compute-budget
 *   budgets   → compute-budget
 */

import { setStatus, setFailed, STATUS_PROGRESS } from "./pipeline-status.ts";
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

/**
 * Returns the list of compute jobs to run for a given module type.
 * Each job specifies which Edge Function to call and what body to send.
 */
function getComputeJobs(
  moduleType: ModuleType,
  propertyIds: string[],
  orgId: string,
  fiscalYear: number,
): ComputeJob[] {
  const jobs: ComputeJob[] = [];

  // For modules that operate per-property, fan out one job per property.
  // If no property_ids were found in the stored data, skip property-scoped engines.
  const hasProperties = propertyIds.length > 0;

  switch (moduleType) {
    case "leases":
      // Compute rent schedules for each property that has leases
      if (hasProperties) {
        for (const pid of propertyIds) {
          jobs.push({ functionName: "compute-lease", body: { property_id: pid } });
          jobs.push({ functionName: "compute-revenue", body: { property_id: pid, fiscal_year: fiscalYear } });
          jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        }
      }
      break;

    case "expenses":
      if (hasProperties) {
        for (const pid of propertyIds) {
          jobs.push({ functionName: "compute-expense", body: { property_id: pid, fiscal_year: fiscalYear } });
          jobs.push({ functionName: "compute-cam", body: { property_id: pid, fiscal_year: fiscalYear } });
          jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        }
      }
      break;

    case "revenue":
      if (hasProperties) {
        for (const pid of propertyIds) {
          jobs.push({ functionName: "compute-revenue", body: { property_id: pid, fiscal_year: fiscalYear } });
          jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        }
      }
      break;

    case "cam":
      if (hasProperties) {
        for (const pid of propertyIds) {
          jobs.push({ functionName: "compute-cam", body: { property_id: pid, fiscal_year: fiscalYear } });
          jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        }
      }
      break;

    case "budgets":
      if (hasProperties) {
        for (const pid of propertyIds) {
          jobs.push({ functionName: "compute-budget", body: { property_id: pid, fiscal_year: fiscalYear, action: "generate" } });
        }
      }
      break;

    case "properties":
      // Properties are reference data — no compute needed immediately.
      // Compute will be triggered when leases/expenses are uploaded for these properties.
      break;
  }

  return jobs;
}

/**
 * Calls a single Edge Function via internal HTTP.
 * Uses the service role key so the compute function has full DB access.
 */
async function callEdgeFunction(
  supabaseUrl: string,
  functionName: string,
  body: Record<string, unknown>,
  serviceKey: string,
): Promise<{ ok: boolean; status: number; error?: string }> {
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
      const text = await res.text().catch(() => "unknown error");
      return { ok: false, status: res.status, error: text };
    }

    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  }
}

/**
 * Extract unique property_ids from the stored rows.
 * Falls back to querying the DB for properties in the org if rows have no property_id.
 */
async function resolvePropertyIds(
  validData: Record<string, any>[],
  moduleType: ModuleType,
  orgId: string,
  supabaseAdmin: any,
): Promise<string[]> {
  // Try to get property_ids directly from the stored rows
  const fromRows = [
    ...new Set(
      validData
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];

  if (fromRows.length > 0) return fromRows;

  // For leases: look up properties via the leases table (just stored)
  if (moduleType === "leases") {
    const { data } = await supabaseAdmin
      .from("leases")
      .select("property_id")
      .eq("org_id", orgId)
      .not("property_id", "is", null)
      .limit(50);

    if (data && data.length > 0) {
      return [...new Set(data.map((r: any) => r.property_id).filter(Boolean))];
    }
  }

  // Last resort: get all properties for this org
  const { data: props } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("org_id", orgId)
    .limit(20);

  return props?.map((p: any) => p.id) ?? [];
}

/**
 * Main orchestration entry point.
 *
 * Call this AFTER store-data succeeds. It:
 * 1. Resolves which property_ids are affected
 * 2. Determines which compute engines to run
 * 3. Fires them all in parallel (fire-and-forget)
 * 4. Updates uploaded_files.status to 'computing' then 'processed'
 * 5. Never throws — all errors are caught and logged
 */
export async function triggerComputePipeline(opts: {
  fileId: string;
  moduleType: ModuleType;
  orgId: string;
  validData: Record<string, any>[];
  supabaseAdmin: any;
}): Promise<void> {
  const { fileId, moduleType, orgId, validData, supabaseAdmin } = opts;

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

  if (!supabaseUrl || !serviceKey) {
    console.warn("[compute-orchestrator] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY — skipping compute");
    return;
  }

  try {
    // Mark as computing
    await setStatus(supabaseAdmin, fileId, "computing");

    // Resolve property_ids and fiscal year
    const propertyIds = await resolvePropertyIds(validData, moduleType, orgId, supabaseAdmin);
    const fiscalYear = new Date().getFullYear();

    console.log(
      `[compute-orchestrator] file_id=${fileId} module=${moduleType} properties=${propertyIds.join(",")} fiscal_year=${fiscalYear}`,
    );

    // Build job list
    const jobs = getComputeJobs(moduleType, propertyIds, orgId, fiscalYear);

    if (jobs.length === 0) {
      console.log(`[compute-orchestrator] No compute jobs for module_type=${moduleType}`);
      await setStatus(supabaseAdmin, fileId, "completed", {
        processing_completed_at: new Date().toISOString(),
      });
      return;
    }

    // Fire all jobs in parallel — errors are collected but don't stop others
    const results = await Promise.allSettled(
      jobs.map((job) =>
        callEdgeFunction(supabaseUrl, job.functionName, job.body, serviceKey)
      ),
    );

    // Log results
    const errors: string[] = [];
    results.forEach((result, i) => {
      const job = jobs[i];
      if (result.status === "rejected") {
        errors.push(`${job.functionName}: ${result.reason}`);
        console.error(`[compute-orchestrator] ${job.functionName} rejected:`, result.reason);
      } else if (!result.value.ok) {
        errors.push(`${job.functionName}: HTTP ${result.value.status} — ${result.value.error}`);
        console.error(`[compute-orchestrator] ${job.functionName} failed:`, result.value.error);
      } else {
        console.log(`[compute-orchestrator] ${job.functionName} OK`);
      }
    });

    // Mark as completed (even if some compute jobs failed — data is stored)
    const errorNote = errors.length > 0
      ? `Compute warnings: ${errors.slice(0, 3).join("; ")}`
      : null;

    await setStatus(supabaseAdmin, fileId, "completed", {
      processing_completed_at: new Date().toISOString(),
      ...(errorNote ? { error_message: errorNote } : {}),
    });

    console.log(`[compute-orchestrator] Done. ${jobs.length} jobs, ${errors.length} errors.`);

  } catch (err) {
    // Never let orchestration errors break the pipeline
    console.error("[compute-orchestrator] Unexpected error:", err.message);
    await setFailed(supabaseAdmin, fileId, err.message, "computing", STATUS_PROGRESS.computing);
  }
}

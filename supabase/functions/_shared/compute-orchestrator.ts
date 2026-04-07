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

function getComputeJobs(
  moduleType: ModuleType,
  propertyIds: string[],
  fiscalYear: number,
): ComputeJob[] {
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
        // Reference data — no compute needed immediately
        break;
    }
  }

  return jobs;
}

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
 * Resolve property_ids for the compute pipeline using a priority chain:
 *
 * 1. fileRecord.property_id  — set at upload time (most reliable)
 * 2. validData rows          — rows that contain a property_id column
 * 3. DB lookup               — query the relevant table for recently stored rows
 * 4. Org fallback            — all properties in the org (last resort)
 */
export async function resolvePropertyIds(
  fileRecord: Record<string, any>,
  validData: Record<string, any>[],
  moduleType: ModuleType,
  orgId: string,
  supabaseAdmin: any,
): Promise<string[]> {
  // 1. Explicit property_id stored on the file record
  if (fileRecord.property_id && typeof fileRecord.property_id === "string") {
    console.log(`[compute-orchestrator] property_id from file record: ${fileRecord.property_id}`);
    return [fileRecord.property_id];
  }

  // 2. Extract from valid_data rows
  const fromRows = [
    ...new Set(
      validData
        .map((r) => r.property_id)
        .filter((id): id is string => typeof id === "string" && id.length > 0),
    ),
  ];
  if (fromRows.length > 0) {
    console.log(`[compute-orchestrator] property_ids from rows: ${fromRows.join(",")}`);
    return fromRows;
  }

  // 3. DB lookup — query the table that was just populated
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
      if (ids.length > 0) {
        console.log(`[compute-orchestrator] property_ids from ${table} table: ${ids.join(",")}`);
        return ids as string[];
      }
    }
  }

  // 4. Org-level fallback — all properties (max 20)
  const { data: props } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("org_id", orgId)
    .limit(20);

  const fallback = props?.map((p: any) => p.id) ?? [];
  console.log(`[compute-orchestrator] property_ids from org fallback: ${fallback.join(",")}`);
  return fallback;
}

/**
 * Main orchestration entry point.
 * Called fire-and-forget after store-data succeeds.
 */
export async function triggerComputePipeline(opts: {
  fileId: string;
  moduleType: ModuleType;
  orgId: string;
  validData: Record<string, any>[];
  fileRecord: Record<string, any>;
  supabaseAdmin: any;
}): Promise<void> {
  const { fileId, moduleType, orgId, validData, fileRecord, supabaseAdmin } = opts;

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

    console.log(
      `[compute-orchestrator] file_id=${fileId} module=${moduleType} properties=[${propertyIds.join(",")}] fy=${fiscalYear}`,
    );

    const jobs = getComputeJobs(moduleType, propertyIds, fiscalYear);

    if (jobs.length === 0) {
      console.log(`[compute-orchestrator] No compute jobs for module=${moduleType}`);
      await setStatus(supabaseAdmin, fileId, "completed", {
        processing_completed_at: new Date().toISOString(),
      });
      return;
    }

    const results = await Promise.allSettled(
      jobs.map((job) => callEdgeFunction(supabaseUrl, job.functionName, job.body, serviceKey)),
    );

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

    const errorNote = errors.length > 0 ? `Compute warnings: ${errors.slice(0, 3).join("; ")}` : null;

    await setStatus(supabaseAdmin, fileId, "completed", {
      processing_completed_at: new Date().toISOString(),
      ...(errorNote ? { error_message: errorNote } : {}),
    });

    console.log(`[compute-orchestrator] Done. ${jobs.length} jobs, ${errors.length} errors.`);

  } catch (err) {
    console.error("[compute-orchestrator] Unexpected error:", err.message);
    await setFailed(supabaseAdmin, fileId, err.message, "computing", STATUS_PROGRESS.computing);
  }
}

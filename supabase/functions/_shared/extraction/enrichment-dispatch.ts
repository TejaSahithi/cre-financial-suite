// @ts-nocheck
/**
 * Shared enqueue + fire-and-forget dispatch for the "enrich" pipeline stage
 * (evidence attachment + clause records - the expensive pass deferred out of
 * normalize-pdf-output's main request per the P0.1 fix). Used by both
 * normalize-pdf-output (after a fast minimal payload persists) and
 * lease-extraction-worker's reconciliation path (defensive re-dispatch if a
 * process died before the first dispatch landed).
 *
 * Deliberately does NOT touch uploaded_files.status - unlike the initial
 * lease_extraction job (which transitions status to "parsing"), an enrich
 * job runs after the file already has a durable, visible minimal payload;
 * touching status here would hide already-correct data from the UI.
 */

import { EXTRACTION_CONTRACT_VERSION } from "./contract-version.ts";

export function dispatchEnrichmentWorker(jobId: string, logger?: any) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const workerSecret = Deno.env.get("WORKER_INTERNAL_SECRET") ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.warn("[enrichment-dispatch] Missing service configuration; cannot dispatch lease-extraction-worker");
    return;
  }

  const promise = fetch(`${supabaseUrl}/functions/v1/lease-extraction-worker`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${serviceKey}`,
      "apikey": serviceKey,
      ...(workerSecret ? { "x-worker-secret": workerSecret } : {}),
    },
    body: JSON.stringify({ job_id: jobId }),
  }).then(async (response) => {
    if (response.ok) return;
    const text = await response.text().catch(() => "");
    const message = text.slice(0, 500) || `HTTP ${response.status}`;
    console.error("[enrichment-dispatch] lease-extraction-worker dispatch failed:", message);
    await logger?.event?.("enrich", "dispatch_failed", { error_message: message, metadata: { job_id: jobId } });
  }).catch(async (error: any) => {
    const message = error?.message || String(error);
    console.error("[enrichment-dispatch] lease-extraction-worker dispatch failed:", message);
    await logger?.event?.("enrich", "dispatch_failed", { error_message: message, metadata: { job_id: jobId } });
  });

  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(promise);
  }
}

/**
 * Enqueue an "enrich" pipeline_jobs row for a file and fire-and-forget
 * dispatch the worker to pick it up. Supersedes any other still-queued
 * enrich job for the same file (idempotent re-dispatch safe).
 */
export async function enqueueEnrichmentJob(args: {
  supabaseAdmin: any;
  orgId: string;
  fileId: string;
  moduleType?: string | null;
  logger?: any;
  dispatchWorker?: (jobId: string, logger?: any) => void;
}) {
  const { supabaseAdmin, orgId, fileId, moduleType, logger } = args;
  const dispatchWorker = args.dispatchWorker ?? dispatchEnrichmentWorker;
  const now = new Date().toISOString();

  // enqueue_pipeline_job adds the "enrich" stage to the file's EXISTING
  // active generation (started earlier by start_lease_extraction_generation
  // during ingest/re-extraction) - it never creates a generation itself.
  // Same-generation duplicate calls (this function is deliberately called
  // from two places - see header comment above - as a defensive re-dispatch)
  // return the already-queued/running job instead of creating a second row,
  // replacing the previous non-atomic "cancel then insert" pair.
  // See supabase/migrations/20260824000200_pipeline_jobs_generation_rpcs.sql.
  const { data: result, error: enqueueError } = await supabaseAdmin.rpc("enqueue_pipeline_job", {
    p_org_id: orgId,
    p_uploaded_file_id: fileId,
    p_job_type: "lease_extraction",
    p_stage: "enrich",
    p_contract_version: EXTRACTION_CONTRACT_VERSION,
    p_max_attempts: 3,
    p_input: { mode: "enrich", module_type: moduleType ?? "leases" },
    p_metadata: { enqueued_by: "enrichment-dispatch", enqueued_at: now },
  });

  if (enqueueError || !result) {
    console.error(`[enrichment-dispatch] Could not enqueue enrich job for file_id=${fileId}: ${enqueueError?.message}`);
    return null;
  }

  const jobId = result.created ? result.job_id : result.existing_job_id;
  if (!jobId) {
    console.error(`[enrichment-dispatch] enqueue_pipeline_job returned no job id for file_id=${fileId}`);
    return null;
  }

  if (!result.created) {
    console.log(`[normalize-pdf-output] enrichment_job_already_active file_id=${fileId} job_id=${jobId}`);
    await logger?.event?.("enrich", "redispatched", { provider: "lease-extraction-worker", metadata: { job_id: jobId } });
    dispatchWorker(jobId, logger);
    return { id: jobId, existing: true };
  }

  await logger?.event?.("enrich", "queued", { provider: "lease-extraction-worker", metadata: { job_id: jobId } });
  console.log(`[normalize-pdf-output] enrichment_job_enqueued file_id=${fileId} job_id=${jobId}`);

  dispatchWorker(jobId, logger);
  return { id: jobId, existing: false };
}

// @ts-nocheck
/**
 * Shared enqueue + fire-and-forget dispatch for the bounded enrich
 * sub-stages (see FAILED_EXTRACTION_ROOT_CAUSE.md and the "Bounded
 * Per-Domain Enrich Refactor" plan). Generalizes
 * enrichment-dispatch.ts's enqueueEnrichmentJob()/dispatchEnrichmentWorker()
 * -- the exact "new pipeline_jobs row, new Edge Function invocation,
 * fire-and-forget dispatch" pattern already used for "enrich" today -- to
 * accept any of the 10 new bounded stage names instead of hardcoding
 * "enrich". Dispatch body stays reference-only ({ job_id }), per the user's
 * explicit "pass references, not giant payloads" requirement -- the worker
 * looks up file_id/generation_id/org_id from the claimed pipeline_jobs row.
 */

import { EXTRACTION_CONTRACT_VERSION } from "../contract-version.ts";
import type { EnrichBoundedStageName } from "./stage-sequence.ts";

export function dispatchBoundedEnrichStageWorker(jobId: string, logger?: any) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const workerSecret = Deno.env.get("WORKER_INTERNAL_SECRET") ?? "";
  if (!supabaseUrl || !serviceKey) {
    console.warn("[enrich-bounded-stage/dispatch] Missing service configuration; cannot dispatch lease-extraction-worker");
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
    console.error("[enrich-bounded-stage/dispatch] lease-extraction-worker dispatch failed:", message);
    await logger?.event?.("enrich", "bounded_stage_dispatch_failed", { error_message: message, metadata: { job_id: jobId } });
  }).catch(async (error: any) => {
    const message = error?.message || String(error);
    console.error("[enrich-bounded-stage/dispatch] lease-extraction-worker dispatch failed:", message);
    await logger?.event?.("enrich", "bounded_stage_dispatch_failed", { error_message: message, metadata: { job_id: jobId } });
  });

  const edgeRuntime = (globalThis as any).EdgeRuntime;
  if (edgeRuntime?.waitUntil) {
    edgeRuntime.waitUntil(promise);
  }
}

/**
 * Enqueue ONE bounded-stage pipeline_jobs row and fire-and-forget dispatch
 * the worker to pick it up. Idempotent/dedup-safe via the same
 * enqueue_pipeline_job RPC "enrich" already uses (same-generation duplicate
 * calls return the already-queued/running job instead of a second row).
 */
export async function enqueueBoundedEnrichStage(args: {
  supabaseAdmin: any;
  orgId: string;
  fileId: string;
  stage: EnrichBoundedStageName;
  generationId?: string | null;
  moduleType?: string | null;
  logger?: any;
  dispatchWorker?: (jobId: string, logger?: any) => void;
}) {
  const { supabaseAdmin, orgId, fileId, stage, generationId, moduleType, logger } = args;
  const dispatchWorker = args.dispatchWorker ?? dispatchBoundedEnrichStageWorker;
  const now = new Date().toISOString();

  const { data: result, error: enqueueError } = await supabaseAdmin.rpc("enqueue_pipeline_job", {
    p_org_id: orgId,
    p_uploaded_file_id: fileId,
    p_job_type: "lease_extraction",
    p_stage: stage,
    p_contract_version: EXTRACTION_CONTRACT_VERSION,
    p_max_attempts: 3,
    p_input: { mode: stage, module_type: moduleType ?? "leases" },
    p_metadata: { enqueued_by: "enrich-bounded-stage/dispatch", enqueued_at: now, generation_id: generationId ?? null },
  });

  if (enqueueError || !result) {
    console.error(`[enrich-bounded-stage/dispatch] Could not enqueue ${stage} job for file_id=${fileId}: ${enqueueError?.message}`);
    return null;
  }

  const jobId = result.created ? result.job_id : result.existing_job_id;
  if (!jobId) {
    console.error(`[enrich-bounded-stage/dispatch] enqueue_pipeline_job returned no job id for file_id=${fileId} stage=${stage}`);
    return null;
  }

  if (!result.created) {
    await logger?.event?.(stage, "redispatched", { provider: "lease-extraction-worker", metadata: { job_id: jobId } });
    dispatchWorker(jobId, logger);
    return { id: jobId, existing: true };
  }

  await logger?.event?.(stage, "queued", { provider: "lease-extraction-worker", metadata: { job_id: jobId } });
  console.log(`[enrich-bounded-stage/dispatch] ${stage}_job_enqueued file_id=${fileId} job_id=${jobId}`);

  dispatchWorker(jobId, logger);
  return { id: jobId, existing: false };
}

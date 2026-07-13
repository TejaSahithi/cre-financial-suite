// @ts-nocheck
/**
 * Shared enqueue + fire-and-forget dispatch for the "enrich" pipeline stage
 * (evidence attachment + clause records — the expensive pass deferred out of
 * normalize-pdf-output's main request per the P0.1 fix). Used by both
 * normalize-pdf-output (after a fast minimal payload persists) and
 * lease-extraction-worker's reconciliation path (defensive re-dispatch if a
 * process died before the first dispatch landed).
 *
 * Deliberately does NOT touch uploaded_files.status — unlike the initial
 * lease_extraction job (which transitions status to "parsing"), an enrich
 * job runs after the file already has a durable, visible minimal payload;
 * touching status here would hide already-correct data from the UI.
 */

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
}) {
  const { supabaseAdmin, orgId, fileId, moduleType, logger } = args;
  const now = new Date().toISOString();

  await supabaseAdmin
    .from("pipeline_jobs")
    .update({
      status: "cancelled",
      error_code: "SUPERSEDED",
      error_message: "Superseded by a newer enrichment request.",
      completed_at: now,
      updated_at: now,
    })
    .eq("uploaded_file_id", fileId)
    .eq("stage", "enrich")
    .in("status", ["queued", "running"]);

  const { data: job, error: jobError } = await supabaseAdmin
    .from("pipeline_jobs")
    .insert({
      org_id: orgId,
      uploaded_file_id: fileId,
      job_type: "lease_extraction",
      stage: "enrich",
      status: "queued",
      max_attempts: 3,
      input: { mode: "enrich", module_type: moduleType ?? "leases" },
      metadata: { enqueued_by: "enrichment-dispatch", enqueued_at: now },
    })
    .select("id")
    .single();

  if (jobError || !job?.id) {
    console.error(`[enrichment-dispatch] Could not enqueue enrich job for file_id=${fileId}: ${jobError?.message}`);
    return null;
  }

  await logger?.event?.("enrich", "queued", { provider: "lease-extraction-worker", metadata: { job_id: job.id } });
  console.log(`[normalize-pdf-output] enrichment_job_enqueued file_id=${fileId} job_id=${job.id}`);

  dispatchEnrichmentWorker(job.id, logger);
  return job;
}

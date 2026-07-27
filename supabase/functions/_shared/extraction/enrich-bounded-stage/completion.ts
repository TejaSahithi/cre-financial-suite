// @ts-nocheck
/**
 * Shared "a bounded enrich stage finished (or failed)" handler (see
 * FAILED_EXTRACTION_ROOT_CAUSE.md and the "Bounded Per-Domain Enrich
 * Refactor" plan). Replaces what would otherwise be 9 hand-copied versions
 * of the existing "enrich" stage's ~100-150 line failure-handling block --
 * the exact duplication problem isReviewReadyEnrichmentTransportFailure/
 * completeEnrichmentWithWarning already had (and a recent incident fix had
 * to clean up) for a single stage; this refactor introduces 9 more stages,
 * so a shared helper is required, not optional, to avoid repeating that
 * mistake at 9x the scale.
 *
 * lease-extraction-worker/index.ts's stage-dispatch branch calls this ONE
 * function after every bounded-stage invocation of normalize-pdf-output
 * succeeds or fails; it does not hand-roll per-stage equivalents.
 */

import { checkGenerationStillActive } from "../generation-fence.ts";
import { enqueueBoundedEnrichStage } from "./dispatch.ts";
import { nextEnrichBoundedStage, isFinalEnrichBoundedStage, type EnrichBoundedStageName } from "./stage-sequence.ts";
import { getLeaseDocumentPackageMode } from "../document-package/feature-mode.ts";
import { getLeaseFinancialScheduleMode } from "../lease-financial-schedule/feature-mode.ts";

/**
 * Calls finalize_lease_extraction_for_review exactly the way every other
 * call site in this codebase does (p_package_mode/p_financial_mode
 * included), and ALWAYS inspects the returned {error} instead of only
 * relying on try/catch -- supabase-js resolves an RPC-level failure (e.g.
 * the confirmed live parameter-mismatch: the deployed function does not yet
 * have these two parameters, see FAILED_EXTRACTION_ROOT_CAUSE.md) as
 * {data:null, error} rather than throwing. Deliberately does NOT drop
 * p_package_mode/p_financial_mode to make this call succeed locally -- that
 * would hide the real, still-pending migration mismatch instead of keeping
 * it visible and identical everywhere else this RPC is called.
 */
async function callFinalizeExtractionReadiness(args: {
  supabaseAdmin: any;
  orgId: string;
  fileId: string;
  generationId: string | null;
  stage: EnrichBoundedStageName;
}): Promise<{ ok: boolean; error?: string | null }> {
  const { supabaseAdmin, orgId, fileId, generationId, stage } = args;
  try {
    const { data, error } = await supabaseAdmin.rpc("finalize_lease_extraction_for_review", {
      p_org_id: orgId,
      p_uploaded_file_id: fileId,
      p_generation_id: generationId,
      p_package_mode: getLeaseDocumentPackageMode(),
      p_financial_mode: getLeaseFinancialScheduleMode(),
    });
    if (error) {
      console.error(
        `[enrich-bounded-stage/completion] finalize_lease_extraction_for_review RPC returned an error stage=${stage} file_id=${fileId} generation_id=${generationId}:`,
        error.message,
      );
      return { ok: false, error: error.message };
    }
    if (data?.success === false) {
      console.error(
        `[enrich-bounded-stage/completion] finalize_lease_extraction_for_review reported failure stage=${stage} file_id=${fileId} generation_id=${generationId}:`,
        data?.error_message ?? data?.error_code,
      );
      return { ok: false, error: data?.error_message ?? data?.error_code ?? "FINALIZATION_FAILED" };
    }
    return { ok: true };
  } catch (thrown: any) {
    console.error(
      `[enrich-bounded-stage/completion] finalize_lease_extraction_for_review call threw stage=${stage} file_id=${fileId} generation_id=${generationId}:`,
      thrown?.message ?? thrown,
    );
    return { ok: false, error: thrown?.message ?? String(thrown) };
  }
}

export interface BoundedStageOutcome {
  ok: boolean;
  /**
   * True when ok=false because the stage's input exceeded its hard limit
   * (see enrich-stage-limits.ts), rather than a genuine processing error.
   * Real bounded-slice splitting is not implemented in this change-set
   * (an explicit, deliberate scope decision -- see the plan/report); per
   * the user's explicit requirement, an oversized document must NOT
   * silently fall back to one whole-document invocation. It is instead
   * treated as a normal terminal failure below, tagged with the specific
   * error_code BOUNDED_STAGE_LIMIT_EXCEEDED so it is distinguishable from
   * other failure causes -- never converted into a softer outcome.
   */
  limitExceeded?: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export async function completeBoundedEnrichStage(args: {
  supabaseAdmin: any;
  job: any;
  fileId: string;
  orgId: string;
  moduleType?: string | null;
  stage: EnrichBoundedStageName;
  outcome: BoundedStageOutcome;
  logger?: any;
}) {
  const { supabaseAdmin, job, fileId, orgId, moduleType, stage, outcome, logger } = args;
  const now = new Date().toISOString();

  const fence = await checkGenerationStillActive({
    supabaseAdmin, fileId, orgId, expectedGenerationId: job.generation_id ?? null,
  });
  if (!fence.stillActive) {
    // A newer generation has already superseded this one -- this stage's
    // result (success or failure) is moot; do not write anything further
    // and do not enqueue a next stage for a generation nothing will read.
    await supabaseAdmin.from("pipeline_jobs").update({
      status: "cancelled",
      completed_at: now,
      updated_at: now,
      metadata: { ...(job.metadata || {}), superseded_generation: true },
    }).eq("id", job.id);
    console.log(`[enrich-bounded-stage/completion] ${stage}_stale_generation_skipped file_id=${fileId} job_id=${job.id}`);
    return { proceeded: false, reason: "stale_generation" };
  }

  if (outcome.ok) {
    await supabaseAdmin.from("pipeline_jobs").update({
      status: "completed",
      completed_at: now,
      updated_at: now,
      metadata: { ...(job.metadata || {}), [`${stage}_completed_at`]: now },
    }).eq("id", job.id);
    await logger?.event?.(stage, "completed", { metadata: { job_id: job.id } });

    if (isFinalEnrichBoundedStage(stage)) {
      // enrich_truth_assembly's own normalize-pdf-output handler already
      // persisted the final ui_review_payload and ran the existing
      // mode-gated post-processing + finalize_lease_extraction_for_review
      // call, exactly where handleEnrichMode() runs them today. Nothing
      // further to enqueue -- the chain is complete.
      return { proceeded: true, chainComplete: true };
    }

    const next = nextEnrichBoundedStage(stage);
    if (!next) {
      console.error(`[enrich-bounded-stage/completion] ${stage} has no successor but is not marked final -- stage-sequence.ts is inconsistent`);
      return { proceeded: true, chainComplete: false, error: "NO_SUCCESSOR_STAGE" };
    }
    await enqueueBoundedEnrichStage({ supabaseAdmin, orgId, fileId, stage: next, generationId: job.generation_id ?? null, moduleType, logger });
    return { proceeded: true, chainComplete: false, nextStage: next };
  }

  // Terminal failure -- this includes outcome.limitExceeded (an oversized
  // document; real bounded-slice splitting is not implemented in this
  // change-set, so per the user's explicit instruction this fails
  // explicitly with BOUNDED_STAGE_LIMIT_EXCEEDED rather than silently
  // falling back to a whole-document invocation). Same product-safety
  // behaviors already fixed
  // for the old monolithic "enrich" stage: never silently mask as success,
  // mark enrichment_status failed/incomplete (not "completed"/"completed_with_warnings"),
  // preserve whatever partial payload/bounded_stage_results already exist,
  // and re-run finalize_lease_extraction_for_review so
  // evaluate_lease_extraction_readiness() picks up ENRICHMENT_FAILED --
  // which finalize_lease_review_approval re-checks fresh at approval time
  // regardless of this call's own success (see FAILED_EXTRACTION_ROOT_CAUSE.md §8).
  await supabaseAdmin.from("pipeline_jobs").update({
    status: "failed",
    error_code: outcome.errorCode ?? "ENRICH_STAGE_FAILED",
    error_message: String(outcome.errorMessage ?? "Bounded enrich stage failed").slice(0, 1000),
    completed_at: now,
    updated_at: now,
  }).eq("id", job.id);

  const { data: currentFile } = await supabaseAdmin
    .from("uploaded_files")
    .select("ui_review_payload")
    .eq("id", fileId)
    .maybeSingle();
  const currentPayload = currentFile?.ui_review_payload || {};
  await supabaseAdmin.from("uploaded_files").update({
    ui_review_payload: {
      ...currentPayload,
      enrichment_status: "failed",
      enrichment_error: `${stage}: ${outcome.errorMessage ?? "failed"}`,
      enrichment_failed_stage: stage,
    },
    updated_at: now,
  }).eq("id", fileId);

  await callFinalizeExtractionReadiness({ supabaseAdmin, orgId, fileId, generationId: job.generation_id ?? null, stage });

  await logger?.event?.(stage, "failed", { error_code: outcome.errorCode ?? "ENRICH_STAGE_FAILED", error_message: outcome.errorMessage ?? null, metadata: { job_id: job.id } });
  console.log(`[enrich-bounded-stage/completion] ${stage}_failed_preserved_core_payload file_id=${fileId}`);
  return { proceeded: true, chainComplete: false, failedStage: stage };
}

// @ts-nocheck
/**
 * Reliability Phase R1: one shared, generation-fenced, row-count-checked
 * writer for every enrichment terminal transition, replacing the 3+
 * hand-rolled copies in lease-extraction-worker/index.ts that each
 * independently re-fetched uploaded_files, conditionally updated it, and
 * silently did nothing (at most a console.log) on a generation mismatch
 * or a failed re-fetch -- the direct cause of ui_review_payload
 * .enrichment_status getting stuck at "running" indefinitely after a
 * terminal enrich failure.
 *
 * The core write is a plain column-level compare-and-set
 * (id + org_id + active_generation_id), never dependent on first reading
 * the current ui_review_payload JSONB blob -- enrichment_status and
 * enrichment_error are real top-level columns
 * (20260881000000_enrichment_terminal_state_partial.sql) specifically so
 * this holds. A failed pre-update diagnostic read must never abandon the
 * update (see classifyEnrichmentFailure's caller for why): the
 * compare-and-set's WHERE clause is itself the generation fence.
 *
 * The legacy ui_review_payload.enrichment_status / .enrichment_warning
 * mirror is still written, but only as a best-effort secondary step after
 * the real columns already landed -- several existing consumers
 * (pipeline-status/status-utils.ts, the frontend) still fall back to it.
 */

export type EnrichmentTerminalStatus = "completed" | "partial" | "failed";

export type EnrichmentErrorClassification =
  | "resource_exhausted"
  | "transport_error"
  | "unknown";

export interface ClassifiedEnrichmentFailure {
  classification: EnrichmentErrorClassification;
  retryable: boolean;
}

/**
 * Narrow and explicit: only classify what's actually known from the error
 * code/message/status, matching this codebase's established "never guess,
 * leave it unknown instead" convention (see normalizeAuditRight in
 * expense-obligation-converters.ts for the direct precedent).
 */
export function classifyEnrichmentFailure(
  errorCode: string | null | undefined,
  message: string | null | undefined,
  status?: number | null,
): ClassifiedEnrichmentFailure {
  const code = String(errorCode || "").toUpperCase();
  const text = String(message || "").toLowerCase();

  if (
    code === "DOWNSTREAM_FUNCTION_FAILED" ||
    code.includes("546") ||
    Number(status) === 546 ||
    text.includes("not enough compute resources")
  ) {
    return { classification: "resource_exhausted", retryable: false };
  }

  if (
    code === "STAGE_TIMEOUT" ||
    Number(status) === 504 ||
    text.includes("timed out")
  ) {
    return { classification: "transport_error", retryable: true };
  }

  return { classification: "unknown", retryable: false };
}

export interface PersistEnrichmentTerminalStateArgs {
  supabaseAdmin: any;
  organizationId: string;
  fileId: string;
  generationId: string;
  status: EnrichmentTerminalStatus;
  /** Overrides the string written to ui_review_payload.enrichment_status (e.g. "completed_with_warnings") without changing the real column's value. */
  uiReviewPayloadStatus?: string;
  errorCode?: string | null;
  errorMessage?: string | null;
  classification?: EnrichmentErrorClassification | null;
  retryable?: boolean | null;
  /** The stage this terminal state belongs to, e.g. "enrich" -- also the pipeline_logs step name when set. */
  stage?: string | null;
  /** Macro-level for the monolithic enrich path (always ["parse","normalize"]); real per-substep tracking only exists in the not-yet-authoritative bounded-enrich chain. */
  completedStages?: string[];
  logger?: any;
}

export type TerminalStatePersistenceReason =
  | "OK"
  | "COMPARE_AND_SET_MISSED"
  | "TERMINAL_UPDATE_FAILED";

export interface TerminalStatePersistenceResult {
  persisted: boolean;
  reason: TerminalStatePersistenceReason;
  observedGenerationId?: string | null;
}

function buildEnrichmentError(args: PersistEnrichmentTerminalStateArgs): Record<string, unknown> | null {
  if (!args.errorCode && !args.errorMessage && !args.classification) {
    return null;
  }
  return {
    code: args.errorCode ?? null,
    message: args.errorMessage ?? null,
    classification: args.classification ?? "unknown",
    retryable: args.retryable ?? false,
    stage: args.stage ?? null,
    completedStages: args.completedStages ?? null,
  };
}

/**
 * Never throws. Always resolves with a result describing whether the
 * terminal state actually landed -- unlike logger.event's own
 * fire-and-forget contract, the caller here still needs to know, since a
 * missed compare-and-set means the caller's pipeline_jobs-level failure
 * bookkeeping went through but the file-level terminal state did not (by
 * design -- a newer generation already owns that file's state).
 */
export async function persistEnrichmentTerminalState(
  args: PersistEnrichmentTerminalStateArgs,
): Promise<TerminalStatePersistenceResult> {
  const { supabaseAdmin, organizationId, fileId, generationId, status, stage, logger } = args;
  const enrichmentError = buildEnrichmentError(args);
  const logStage = stage ?? "enrich";
  const now = new Date().toISOString();

  let updateResult;
  try {
    updateResult = await supabaseAdmin
      .from("uploaded_files")
      .update({
        enrichment_status: status,
        enrichment_error: enrichmentError,
        updated_at: now,
      })
      .eq("id", fileId)
      .eq("org_id", organizationId)
      .eq("active_generation_id", generationId)
      .select("id");
  } catch (error: any) {
    await logger?.event?.(logStage, "terminal_update_failed", {
      reason_code: "TERMINAL_UPDATE_FAILED",
      error_code: args.errorCode ?? null,
      error_message: String(error?.message ?? error),
      metadata: { file_id: fileId, generation_id: generationId },
    });
    return { persisted: false, reason: "TERMINAL_UPDATE_FAILED" };
  }

  if (updateResult?.error) {
    await logger?.event?.(logStage, "terminal_update_failed", {
      reason_code: "TERMINAL_UPDATE_FAILED",
      error_code: args.errorCode ?? null,
      error_message: String(updateResult.error.message ?? updateResult.error),
      metadata: { file_id: fileId, generation_id: generationId },
    });
    return { persisted: false, reason: "TERMINAL_UPDATE_FAILED" };
  }

  const affectedRows = Array.isArray(updateResult?.data) ? updateResult.data.length : 0;
  if (affectedRows === 0) {
    // The compare-and-set missed -- a newer generation (or a nonexistent
    // file/org pair) already owns this row. Best-effort diagnostic read;
    // its failure must not change the outcome, the miss itself is already
    // fully determined.
    let observedGenerationId: string | null = null;
    try {
      const { data: currentFile } = await supabaseAdmin
        .from("uploaded_files")
        .select("active_generation_id")
        .eq("id", fileId)
        .maybeSingle();
      observedGenerationId = currentFile?.active_generation_id ?? null;
    } catch {
      // Diagnostic-only; leave observedGenerationId null.
    }

    await logger?.event?.(logStage, "terminal_state_missed", {
      reason_code: "TERMINAL_STATE_COMPARE_AND_SET_MISSED",
      metadata: {
        file_id: fileId,
        expected_generation_id: generationId,
        observed_generation_id: observedGenerationId,
      },
    });
    return { persisted: false, reason: "COMPARE_AND_SET_MISSED", observedGenerationId };
  }

  // Real column landed. Best-effort secondary mirror into
  // ui_review_payload for back-compat consumers -- a failure here is
  // logged but does not flip the overall result; the terminal-state
  // guarantee is already satisfied by the real columns above.
  try {
    const { data: currentFile } = await supabaseAdmin
      .from("uploaded_files")
      .select("ui_review_payload")
      .eq("id", fileId)
      .maybeSingle();
    const currentPayload = currentFile?.ui_review_payload || {};
    const payloadStatus = args.uiReviewPayloadStatus ?? status;
    await supabaseAdmin
      .from("uploaded_files")
      .update({
        ui_review_payload: {
          ...currentPayload,
          enrichment_status: payloadStatus,
          ...(enrichmentError
            ? { enrichment_warning: enrichmentError.message, enrichment_warning_code: enrichmentError.code }
            : {}),
        },
        updated_at: now,
      })
      .eq("id", fileId);
  } catch (error: any) {
    await logger?.warn?.(logStage, "ui_review_payload mirror update failed", {
      error: String(error?.message ?? error),
      file_id: fileId,
    });
  }

  await logger?.event?.(logStage, status, {
    error_code: args.errorCode ?? null,
    error_message: args.errorMessage ?? null,
    classification: args.classification ?? null,
    metadata: { file_id: fileId, generation_id: generationId },
  });

  return { persisted: true, reason: "OK" };
}

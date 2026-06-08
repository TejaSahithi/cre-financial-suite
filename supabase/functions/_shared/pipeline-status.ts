// @ts-nocheck
/**
 * Pipeline Status Helper
 *
 * Single source of truth for all uploaded_files status transitions.
 * Every edge function imports setStatus() / setFailed() from here.
 *
 * Full lifecycle:
 *   uploaded → parsing → parsed → validating → validated
 *            → storing → stored → computing → completed
 *            → failed  (can occur at any step)
 *
 * Progress percentages are used by the frontend progress bar.
 */

export type PipelineStatus =
  | "uploaded"
  | "parsing"
  | "parsed"
  | "pdf_parsed"         // PDF-specific: Docling done, normalisation pending
  | "validating"
  | "validated"
  | "review_required"    // waiting on human approval (lease-sensitive docs)
  | "approved"           // operator cleared, ready for storing
  | "storing"
  | "stored"
  | "computing"
  | "completed"
  | "failed";

export const STATUS_PROGRESS: Record<PipelineStatus, number> = {
  uploaded:         5,
  parsing:          15,
  parsed:           30,
  pdf_parsed:       35,
  validating:       45,
  validated:        55,
  review_required:  60,   // parked; waiting on human
  approved:         65,   // cleared by reviewer, moving to storing
  storing:          70,
  stored:           80,
  computing:        90,
  completed:        100,
  failed:           0,    // overridden at call-site with the last known progress
};

/** Valid forward transitions — prevents accidental status regression */
export const ALLOWED_TRANSITIONS: Partial<Record<PipelineStatus, PipelineStatus[]>> = {
  uploaded:         ["parsing", "review_required", "failed"],
  parsing:          ["parsed", "pdf_parsed", "review_required", "failed"],
  parsed:           ["validating", "failed"],
  pdf_parsed:       ["validating", "review_required", "failed"],
  validating:       ["validated", "review_required", "failed"],
  // After validation we either park for review or go straight to storing.
  validated:        ["validating", "review_required", "storing", "failed"],
  // Reviewer either approves (→ approved → storing) or rejects (→ failed).
  review_required:  ["parsing", "pdf_parsed", "validated", "approved", "failed"],
  approved:         ["validating", "storing", "failed"],
  storing:          ["stored", "failed"],
  stored:           ["computing", "failed"],
  computing:        ["completed", "failed"],
  // terminal states — no further transitions
  completed:        [],
  failed:           ["parsing", "review_required"],
};

const REVIEW_PIPELINE_COLUMNS = new Set([
  "processing_status",
  "extraction_method",
  "document_subtype",
  "normalized_output",
  "ui_review_payload",
  "reviewed_output",
  "review_audit",
  "review_required",
  "review_status",
  "approved_by",
  "approved_at",
  "rejected_by",
  "rejected_at",
  "reject_reason",
  "parent_file_id",
]);

const TRANSITION_DIAGNOSTIC_EXTRA_KEYS = new Set([
  "transition_source",
  "fallback_reason",
]);

function splitTransitionExtras(extra: Record<string, unknown>) {
  const diagnostics: Record<string, unknown> = {};
  const persisted: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(extra ?? {})) {
    if (TRANSITION_DIAGNOSTIC_EXTRA_KEYS.has(key)) {
      diagnostics[key] = value;
    } else {
      persisted[key] = value;
    }
  }

  return { diagnostics, persisted };
}

function looksLikeMissingOptionalColumn(error: any): boolean {
  const message = String(error?.message || error?.details || "");
  const code = String(error?.code || "");
  return (
    code === "42703" ||
    code === "PGRST204" ||
    [...REVIEW_PIPELINE_COLUMNS].some((column) => message.includes(column))
  );
}

function stripReviewPipelineColumns(patch: Record<string, unknown>): Record<string, unknown> {
  const next = { ...patch };
  const message = String((patch as any).__missing_column_error || "");
  let removedMentionedColumn = false;

  if (message) {
    for (const column of REVIEW_PIPELINE_COLUMNS) {
      if (message.includes(column)) {
        delete next[column];
        removedMentionedColumn = true;
      }
    }
    delete next.__missing_column_error;
    if (removedMentionedColumn) return next;
  }

  for (const column of REVIEW_PIPELINE_COLUMNS) {
    delete next[column];
  }
  return next;
}

function buildNoRowUpdatedError(fileId: string, status: string) {
  const error: any = new Error(
    `No uploaded_files row was updated for file ${fileId} while setting status=${status}`,
  );
  error.code = "NO_ROW_UPDATED";
  return error;
}

function buildInvalidTransitionError(fileId: string, fromStatus: PipelineStatus, toStatus: PipelineStatus) {
  const allowed = ALLOWED_TRANSITIONS[fromStatus] ?? [];
  const error: any = new Error(
    `Invalid uploaded_files status transition for file ${fileId}: ${fromStatus} -> ${toStatus}. ` +
    `Allowed: ${allowed.length > 0 ? allowed.join(", ") : "(none)"}`,
  );
  error.code = "INVALID_STATUS_TRANSITION";
  error.details = { fromStatus, toStatus, allowed };
  return error;
}

function buildTransitionDiagnostics(opts: {
  fileId: string;
  previousStatus: PipelineStatus | null;
  requestedNextStatus: PipelineStatus;
  diagnostics?: Record<string, unknown>;
}) {
  const allowedNextStatuses = opts.previousStatus
    ? ALLOWED_TRANSITIONS[opts.previousStatus] ?? []
    : [];

  return {
    file_id: opts.fileId,
    previous_status: opts.previousStatus,
    requested_next_status: opts.requestedNextStatus,
    allowed_next_statuses: allowedNextStatuses,
    transition_source: opts.diagnostics?.transition_source ?? "pipeline-status.setStatus",
    function_name: opts.diagnostics?.transition_source ?? "pipeline-status.setStatus",
    fallback_reason: opts.diagnostics?.fallback_reason ?? null,
  };
}

export function isAllowedTransition(
  fromStatus: PipelineStatus | null | undefined,
  toStatus: PipelineStatus,
): boolean {
  if (!fromStatus) return true;
  if (fromStatus === toStatus) return true;
  return (ALLOWED_TRANSITIONS[fromStatus] ?? []).includes(toStatus);
}

/**
 * Update uploaded_files.status and related metadata.
 * Returns the Supabase update error (if any) — callers decide whether to throw.
 */
export async function setStatus(
  supabaseAdmin: any,
  fileId: string,
  status: PipelineStatus,
  extra: Record<string, unknown> = {},
): Promise<{ error: any }> {
  const now = new Date().toISOString();
  const progress = STATUS_PROGRESS[status];
  const { diagnostics, persisted } = splitTransitionExtras(extra);

  const currentLookup = await supabaseAdmin
    .from("uploaded_files")
    .select("id, status, progress_percentage")
    .eq("id", fileId)
    .maybeSingle();

  if (currentLookup.error) {
    console.error(`[pipeline-status] Could not read current status for file ${fileId}:`, currentLookup.error);
    return { error: currentLookup.error };
  }

  const currentRecord = currentLookup.data;
  if (!currentRecord) {
    return { error: buildNoRowUpdatedError(fileId, status) };
  }

  const currentStatus = currentRecord.status as PipelineStatus | null;
  const transitionDiagnostics = buildTransitionDiagnostics({
    fileId,
    previousStatus: currentStatus,
    requestedNextStatus: status,
    diagnostics,
  });
  console.log("[pipeline-status] status transition requested:", transitionDiagnostics);

  if (!isAllowedTransition(currentStatus, status)) {
    const error = buildInvalidTransitionError(fileId, currentStatus as PipelineStatus, status);
    console.error(`[pipeline-status] Rejected invalid transition for file ${fileId}:`, {
      ...transitionDiagnostics,
      error_details: error.details,
    });
    return { error };
  }

  const patch: Record<string, unknown> = {
    status,
    progress_percentage: progress,
    updated_at: now,
    ...persisted,
  };

  // Set processing_started_at on the first active step
  if (status === "parsing" || status === "validating" || status === "storing") {
    patch.processing_started_at = patch.processing_started_at ?? now;
  }

  // Review states also record an audit timestamp on the file row.
  if (status === "review_required") {
    patch.review_required = true;
    patch.review_status = patch.review_status ?? "pending";
    patch.processing_status = patch.processing_status ?? "review_required";
  }
  if (status === "approved") {
    patch.review_status = "approved";
    patch.approved_at = patch.approved_at ?? now;
  }

  // Set processing_completed_at on terminal steps
  if (status === "completed" || status === "failed") {
    patch.processing_completed_at = patch.processing_completed_at ?? now;
  }

  let { data, error } = await supabaseAdmin
    .from("uploaded_files")
    .update(patch)
    .eq("id", fileId)
    .select("id, status")
    .maybeSingle();

  if (error && looksLikeMissingOptionalColumn(error)) {
    console.warn(
      `[pipeline-status] Optional review-pipeline column missing while setting ${status}; ` +
      `retrying without review metadata. Original: ${error.message}`,
    );
    const retry = await supabaseAdmin
      .from("uploaded_files")
      .update(stripReviewPipelineColumns({
        ...patch,
        __missing_column_error: String(error?.message || error?.details || ""),
      }))
      .eq("id", fileId)
      .select("id, status")
      .maybeSingle();
    data = retry.data;
    error = retry.error;
  }

  if (!error && !data) {
    error = buildNoRowUpdatedError(fileId, status);
  }

  if (error) {
    console.error(`[pipeline-status] setStatus(${status}) failed for file ${fileId}:`, {
      error: error.message,
      patch,
    });
  }

  return { error };
}

/**
 * Mark a file as failed, preserving the last known progress percentage.
 * Optionally records which pipeline step failed.
 */
export async function setFailed(
  supabaseAdmin: any,
  fileId: string,
  errorMessage: string,
  failedStep?: string,
  lastProgress = 0,
): Promise<void> {
  const now = new Date().toISOString();
  const patch = {
    status: "failed",
    error_message: errorMessage,
    failed_step: failedStep ?? null,
    progress_percentage: lastProgress,
    processing_completed_at: now,
    updated_at: now,
  };

  const { data, error: updateError } = await supabaseAdmin
    .from("uploaded_files")
    .update(patch)
    .eq("id", fileId)
    .select("id, status")
    .maybeSingle();

  const error = !updateError && !data
    ? buildNoRowUpdatedError(fileId, "failed")
    : updateError;

  if (error) {
    console.error(`[pipeline-status] setFailed update error for ${fileId}:`, {
      error: error.message,
      patch,
    });
  }
}

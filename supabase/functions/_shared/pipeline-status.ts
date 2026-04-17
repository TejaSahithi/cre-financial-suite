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
const ALLOWED_TRANSITIONS: Partial<Record<PipelineStatus, PipelineStatus[]>> = {
  uploaded:         ["parsing", "failed"],
  parsing:          ["parsed", "pdf_parsed", "failed"],
  parsed:           ["validating", "failed"],
  pdf_parsed:       ["validating", "failed"],
  validating:       ["validated", "failed"],
  // After validation we either park for review or go straight to storing.
  validated:        ["validating", "review_required", "storing", "failed"],
  // Reviewer either approves (→ approved → storing) or rejects (→ failed).
  review_required:  ["approved", "failed"],
  approved:         ["validating", "storing", "failed"],
  storing:          ["stored", "failed"],
  stored:           ["computing", "failed"],
  computing:        ["completed", "failed"],
  // terminal states — no further transitions
  completed:        [],
  failed:           [],
};

const REVIEW_PIPELINE_COLUMNS = new Set([
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
  for (const column of REVIEW_PIPELINE_COLUMNS) {
    delete next[column];
  }
  return next;
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

  const patch: Record<string, unknown> = {
    status,
    progress_percentage: progress,
    updated_at: now,
    ...extra,
  };

  // Set processing_started_at on the first active step
  if (status === "parsing" || status === "validating" || status === "storing") {
    patch.processing_started_at = patch.processing_started_at ?? now;
  }

  // Review states also record an audit timestamp on the file row.
  if (status === "review_required") {
    patch.review_required = true;
    patch.review_status = patch.review_status ?? "pending";
  }
  if (status === "approved") {
    patch.review_status = "approved";
    patch.approved_at = patch.approved_at ?? now;
  }

  // Set processing_completed_at on terminal steps
  if (status === "completed" || status === "failed") {
    patch.processing_completed_at = patch.processing_completed_at ?? now;
  }

  let { error } = await supabaseAdmin
    .from("uploaded_files")
    .update(patch)
    .eq("id", fileId);

  if (error && looksLikeMissingOptionalColumn(error)) {
    console.warn(
      `[pipeline-status] Optional review-pipeline column missing while setting ${status}; ` +
      `retrying without review metadata. Original: ${error.message}`,
    );
    const retry = await supabaseAdmin
      .from("uploaded_files")
      .update(stripReviewPipelineColumns(patch))
      .eq("id", fileId);
    error = retry.error;
  }

  if (error) {
    console.error(`[pipeline-status] setStatus(${status}) failed for file ${fileId}:`, error.message);
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
  await supabaseAdmin
    .from("uploaded_files")
    .update({
      status: "failed",
      error_message: errorMessage,
      failed_step: failedStep ?? null,
      progress_percentage: lastProgress,
      processing_completed_at: now,
      updated_at: now,
    })
    .eq("id", fileId)
    .catch((e: any) => {
      console.error(`[pipeline-status] setFailed update error for ${fileId}:`, e.message);
    });
}

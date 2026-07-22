const ACTIVE_UPLOAD_STATUSES = new Set([
  "uploaded",
  "parsing",
  "parsed",
  "pdf_parsed",
  "validating",
  "validated",
  "storing",
  "stored",
  "computing",
]);

const ACTIVE_JOB_STATUSES = new Set(["queued", "running"]);
const LONG_RUNNING_THRESHOLD_MS = 3 * 60 * 1000;

function normalizeStatus(value) {
  return String(value ?? "").trim().toLowerCase();
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

export function getLeaseUploadPipelineState(fileRecord, nowMs = Date.now()) {
  const status = normalizeStatus(fileRecord?.status);
  const processingStatus = normalizeStatus(fileRecord?.processing_status);
  const displayState = normalizeStatus(fileRecord?.display_state);
  const latestJob = fileRecord?.latest_job || fileRecord?.latestJob || null;
  const latestJobStatus = normalizeStatus(latestJob?.status);
  const latestJobStage = normalizeStatus(latestJob?.stage);
  const activeJobStage = latestJobStatus === "completed" ? "" : latestJobStage;
  const updatedAtMs = fileRecord?.updated_at ? new Date(fileRecord.updated_at).getTime() : NaN;
  const elapsedMs = Number.isFinite(updatedAtMs) ? nowMs - updatedAtMs : null;
  const elapsedLabel = elapsedMs == null ? null : formatElapsed(elapsedMs);
  const activeValues = [status, processingStatus, displayState, activeJobStage].filter(Boolean);
  const hasActiveStatus = activeValues.some((value) => ACTIVE_UPLOAD_STATUSES.has(value));
  const hasActiveJob = ACTIVE_JOB_STATUSES.has(latestJobStatus);
  const isTerminal =
    ["failed", "cancelled", "review_required", "approved", "completed", "processed"].includes(status) ||
    ["complete", "ready_for_review", "failed", "blocked"].includes(displayState) ||
    ["complete", "ready_for_review", "failed", "blocked"].includes(processingStatus);
  const isLongRunning =
    !isTerminal &&
    (hasActiveStatus || hasActiveJob) &&
    elapsedMs != null &&
    elapsedMs >= LONG_RUNNING_THRESHOLD_MS;

  return {
    stage: activeJobStage || processingStatus || displayState || status || "unknown",
    status,
    processingStatus,
    displayState,
    latestJobStatus,
    latestJobStage,
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    elapsedMs,
    elapsedLabel,
    isWaiting: !isTerminal && (hasActiveStatus || hasActiveJob),
    isLongRunning,
    message: isLongRunning
      ? `No status change for ${elapsedLabel || "several minutes"}. Extraction may still finish, but it is taking longer than usual.`
      : null,
  };
}

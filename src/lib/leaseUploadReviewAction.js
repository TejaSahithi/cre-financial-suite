
const ACTIVE_EXTRACTION_JOB_STATUSES = new Set(["queued", "running"]);

export function hasActiveLeaseExtractionJob(fileRecord) {
  const latestJob = fileRecord?.latest_job || fileRecord?.latestJob || null;
  if (!latestJob) return false;
  const jobType = String(latestJob.job_type || latestJob.jobType || "");
  const status = String(latestJob.status || "");
  return ACTIVE_EXTRACTION_JOB_STATUSES.has(status) && (!jobType || jobType === "lease_extraction");
}
function firstMeaningfulId(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function isLeaseUploadReviewReady(fileRecord) {
  if (hasActiveLeaseExtractionJob(fileRecord)) return false;

  const explicitlyReviewable =
    fileRecord?.status === "review_required" ||
    fileRecord?.processing_status === "review_required" ||
    fileRecord?.review_required === true;
  if (explicitlyReviewable) return true;

  const hasExistingReviewTarget = firstMeaningfulId(resolveLeaseReviewIdFromUploadRecord(fileRecord));
  return !!hasExistingReviewTarget && (
    fileRecord?.display_state === "ready_for_review" ||
    fileRecord?.next_action === "open_review"
  );
}
export function getLeaseUploadReviewStatusLabel(fileRecord, fallbackLabel = "Processing...") {
  if (isLeaseUploadReviewReady(fileRecord)) return "Review completed";
  if (fileRecord?.display_state === "complete" || fileRecord?.status === "validated") return "Complete";
  return fallbackLabel;
}

export function resolveLeaseReviewIdFromUploadRecord(fileRecord) {
  const payload = fileRecord?.ui_review_payload || {};
  return firstMeaningfulId(
    fileRecord?.lease_id,
    fileRecord?.leaseId,
    fileRecord?.metadata?.lease_id,
    fileRecord?.extraction_data?.lease_id,
    fileRecord?.normalized_output?.lease_id,
    payload?.lease_id,
    payload?.records?.[0]?.lease_id,
  );
}

export function getLeaseReviewActionState(fileRecord, linkedLeaseId = null) {
  const reviewReady = isLeaseUploadReviewReady(fileRecord);
  const leaseId = firstMeaningfulId(resolveLeaseReviewIdFromUploadRecord(fileRecord), linkedLeaseId);
  return {
    reviewReady,
    leaseId,
    showOpenButton: reviewReady,
    canNavigate: reviewReady,
    needsDraftCreation: reviewReady && !leaseId,
  };
}

// A fresh extraction attempt (the file's current active_generation_id) can
// fail while status/review_required/ui_review_payload still reflect an
// earlier, already-completed generation -- those legacy columns are not
// reset when a new generation starts (only the newer, generation-scoped
// review_readiness column is). Without this check, isLeaseUploadReviewReady
// above (which reads those stale legacy columns) shows "Review completed"
// at the same time latest_job reports the current generation as failed,
// with nothing distinguishing which generation each signal describes.
export function getCurrentGenerationFailureNotice(fileRecord) {
  const activeGenerationId = fileRecord?.active_generation_id || null;
  const latestJob = fileRecord?.latest_job || fileRecord?.latestJob || null;
  const latestJobGenerationId = latestJob?.generation_id || null;
  const belongsToActiveGeneration =
    !!activeGenerationId && !!latestJobGenerationId && activeGenerationId === latestJobGenerationId;

  if (!belongsToActiveGeneration || latestJob?.status !== "failed") {
    return { show: false };
  }
  if (!isLeaseUploadReviewReady(fileRecord)) {
    // Nothing else on screen could be mistaken for describing this failure.
    return { show: false };
  }

  return {
    show: true,
    message: "The latest extraction attempt failed. The review below reflects a previous, already-completed extraction and is unaffected.",
  };
}

export function extractLeaseIdFromPrepareResponse(response) {
  return firstMeaningfulId(
    response?.lease_id,
    response?.leaseId,
    response?.id,
    response?.store_result?.lease_id,
    response?.store_result?.leaseId,
    response?.store_result?.inserted_ids?.[0],
    response?.store_result?.insertedIds?.[0],
    response?.reviewed_output?.lease_review_ids?.[0],
    response?.lease_review_ids?.[0],
  );
}

export async function ensureLeaseReviewDraftForUpload({
  fileId,
  fileRecord,
  linkedLeaseId = null,
  findLeaseByFileId,
  prepareLeaseReviewDraft,
  linkLeaseToUploadedFile,
}) {
  if (!fileId) throw new Error("Upload file id is required");
  if (!isLeaseUploadReviewReady(fileRecord)) {
    throw new Error("Upload is not ready for Lease Review");
  }

  const resolvedLeaseId = firstMeaningfulId(resolveLeaseReviewIdFromUploadRecord(fileRecord), linkedLeaseId);
  if (resolvedLeaseId) {
    await linkLeaseToUploadedFile?.(resolvedLeaseId, fileRecord);
    return { leaseId: resolvedLeaseId, created: false, source: "upload_record" };
  }

  const existingLease = await findLeaseByFileId?.(fileId);
  if (existingLease?.id) {
    await linkLeaseToUploadedFile?.(existingLease.id, fileRecord);
    return { leaseId: existingLease.id, created: false, source: "linked_lease" };
  }

  let prepared;
  try {
    prepared = await prepareLeaseReviewDraft?.({
      file_id: fileId,
      action: "prepare",
      review_payload: fileRecord?.ui_review_payload || null,
    });
  } catch (error) {
    throw new Error("Could not create Lease Review record from this upload.", { cause: error });
  }

  if (prepared?.error) {
    throw new Error(prepared?.message || "Could not create Lease Review record from this upload.");
  }

  const createdLeaseId = extractLeaseIdFromPrepareResponse(prepared) || (await findLeaseByFileId?.(fileId))?.id;
  if (!createdLeaseId) {
    throw new Error("Could not create Lease Review record from this upload.");
  }

  await linkLeaseToUploadedFile?.(createdLeaseId, fileRecord);
  return { leaseId: createdLeaseId, created: true, source: "prepare" };
}
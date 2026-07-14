function firstMeaningfulId(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return null;
}

export function isLeaseUploadReviewReady(fileRecord) {
  return (
    fileRecord?.status === "review_required" ||
    fileRecord?.processing_status === "review_required" ||
    fileRecord?.review_required === true ||
    fileRecord?.display_state === "ready_for_review" ||
    fileRecord?.next_action === "open_review"
  );
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
    canNavigate: reviewReady && Boolean(leaseId),
    showMissingLinkWarning: reviewReady && !leaseId,
  };
}

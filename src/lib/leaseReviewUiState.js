export function isLeaseReviewEnrichmentInFlight(status) {
  return status === "pending" || status === "running";
}

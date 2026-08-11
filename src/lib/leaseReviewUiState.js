export function isLeaseReviewEnrichmentInFlight(status) {
  if (status == null) return false;
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "pending" || normalized === "queued" || normalized === "running" || normalized === "started";
}

export function isLeaseReviewEnrichmentInFlight(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "" || normalized === "pending" || normalized === "queued" || normalized === "running" || normalized === "started";
}
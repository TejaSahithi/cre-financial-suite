import { describe, expect, it } from "vitest";
import { isLeaseReviewEnrichmentInFlight } from "../leaseReviewUiState";

describe("leaseReviewUiState", () => {
  it("shows the enrichment banner only for pending or running enrichment", () => {
    expect(isLeaseReviewEnrichmentInFlight("pending")).toBe(true);
    expect(isLeaseReviewEnrichmentInFlight("running")).toBe(true);
    expect(isLeaseReviewEnrichmentInFlight("completed")).toBe(false);
    expect(isLeaseReviewEnrichmentInFlight("failed")).toBe(false);
    expect(isLeaseReviewEnrichmentInFlight("review_required")).toBe(false);
    expect(isLeaseReviewEnrichmentInFlight(null)).toBe(false);
  });
});

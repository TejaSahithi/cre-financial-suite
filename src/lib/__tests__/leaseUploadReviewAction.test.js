import { describe, expect, it } from "vitest";
import { getLeaseReviewActionState } from "../leaseUploadReviewAction";

describe("lease upload review action state", () => {
  it("renders Open Lease Review for review_required even when failed_step is stale parse", () => {
    const action = getLeaseReviewActionState({
      status: "review_required",
      processing_status: "review_required",
      failed_step: "parse",
      error_message: "Lease extraction is ready for review.",
      lease_id: "lease-123",
    });

    expect(action.showOpenButton).toBe(true);
    expect(action.canNavigate).toBe(true);
    expect(action.leaseId).toBe("lease-123");
    expect(action.showMissingLinkWarning).toBe(false);
  });

  it("renders the missing-link warning for review_required when no lease id is linked", () => {
    const action = getLeaseReviewActionState({
      status: "review_required",
      processing_status: "review_required",
      failed_step: "parse",
      error_message: "Lease extraction is ready for review.",
    });

    expect(action.showOpenButton).toBe(true);
    expect(action.canNavigate).toBe(false);
    expect(action.showMissingLinkWarning).toBe(true);
  });
  it("renders Open Lease Review when only processing_status is review_required", () => {
    const action = getLeaseReviewActionState({
      status: "uploaded",
      processing_status: "review_required",
      failed_step: "parse",
      metadata: { lease_id: "lease-from-metadata" },
    });

    expect(action.showOpenButton).toBe(true);
    expect(action.canNavigate).toBe(true);
    expect(action.leaseId).toBe("lease-from-metadata");
  });
});

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureLeaseReviewDraftForUpload,
  getCurrentGenerationFailureNotice,
  getLeaseUploadReviewStatusLabel,
  getLeaseReviewActionState,
  isLeaseUploadReviewReady,
} from "../leaseUploadReviewAction";

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
    expect(action.needsDraftCreation).toBe(false);
  });

  it("enables Open Lease Review for review_required even when no lease id is linked yet", () => {
    const action = getLeaseReviewActionState({
      status: "review_required",
      processing_status: "review_required",
      failed_step: "parse",
      error_message: "Lease extraction is ready for review.",
    });

    expect(action.showOpenButton).toBe(true);
    expect(action.canNavigate).toBe(true);
    expect(action.needsDraftCreation).toBe(true);
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

  it("does not trust open_review when the upload is not review-required", () => {
    expect(isLeaseUploadReviewReady({
      status: "validated",
      processing_status: "ready_for_review",
      review_required: false,
      display_state: "ready_for_review",
      next_action: "open_review",
    })).toBe(false);

    expect(getLeaseReviewActionState({
      status: "validated",
      processing_status: "ready_for_review",
      review_required: false,
      display_state: "ready_for_review",
      next_action: "open_review",
    }).showOpenButton).toBe(false);
  });


  it("labels non-reviewable validated uploads as complete instead of review completed", () => {
    expect(getLeaseUploadReviewStatusLabel({
      status: "validated",
      processing_status: "ready_for_review",
      review_required: false,
      display_state: "complete",
    }, "Preparing review")).toBe("Complete");
  });

  it("labels review_required uploads as Review completed on the Upload Lease page", () => {
    expect(getLeaseUploadReviewStatusLabel({ status: "review_required", failed_step: "parse" }, "Preparing review"))
      .toBe("Review completed");
    expect(getLeaseUploadReviewStatusLabel({ status: "validating" }, "Extracting lease fields"))
      .toBe("Extracting lease fields");
  });
});

describe("getCurrentGenerationFailureNotice", () => {
  it("shows the notice when the active generation's latest job failed but a prior generation's review is still shown as completed", () => {
    const notice = getCurrentGenerationFailureNotice({
      status: "review_required",
      lease_id: "lease-123",
      active_generation_id: "gen-2",
      latest_job: { status: "failed", generation_id: "gen-2" },
    });
    expect(notice.show).toBe(true);
    expect(notice.message).toMatch(/failed/i);
  });

  it("does not show the notice when the latest job belongs to an older, superseded generation", () => {
    const notice = getCurrentGenerationFailureNotice({
      status: "review_required",
      lease_id: "lease-123",
      active_generation_id: "gen-2",
      latest_job: { status: "failed", generation_id: "gen-1" },
    });
    expect(notice.show).toBe(false);
  });

  it("does not show the notice when the current generation's latest job succeeded", () => {
    const notice = getCurrentGenerationFailureNotice({
      status: "review_required",
      lease_id: "lease-123",
      active_generation_id: "gen-2",
      latest_job: { status: "completed", generation_id: "gen-2" },
    });
    expect(notice.show).toBe(false);
  });

  it("does not show the notice when there is nothing review-ready to contradict", () => {
    const notice = getCurrentGenerationFailureNotice({
      status: "uploaded",
      active_generation_id: "gen-1",
      latest_job: { status: "failed", generation_id: "gen-1" },
    });
    expect(notice.show).toBe(false);
  });

  it("does not show the notice when generation ids are absent (legacy rows / older data)", () => {
    const notice = getCurrentGenerationFailureNotice({
      status: "review_required",
      lease_id: "lease-123",
      latest_job: { status: "failed" },
    });
    expect(notice.show).toBe(false);
  });
});

describe("ensureLeaseReviewDraftForUpload", () => {
  const reviewReadyFile = {
    id: "file-1",
    status: "review_required",
    processing_status: "review_required",
    failed_step: "parse",
    ui_review_payload: { records: [{ tenant_name: "Tenant" }] },
  };

  it("calls the server prepare flow for a review_required file with no linked lease", async () => {
    const findLeaseByFileId = vi.fn().mockResolvedValue(null);
    const prepareLeaseReviewDraft = vi.fn().mockResolvedValue({
      error: false,
      store_result: { inserted_ids: ["lease-created"] },
    });
    const linkLeaseToUploadedFile = vi.fn().mockResolvedValue("lease-created");

    const result = await ensureLeaseReviewDraftForUpload({
      fileId: "file-1",
      fileRecord: reviewReadyFile,
      findLeaseByFileId,
      prepareLeaseReviewDraft,
      linkLeaseToUploadedFile,
    });

    expect(findLeaseByFileId).toHaveBeenCalledWith("file-1");
    expect(prepareLeaseReviewDraft).toHaveBeenCalledWith({
      file_id: "file-1",
      action: "prepare",
      review_payload: reviewReadyFile.ui_review_payload,
    });
    expect(linkLeaseToUploadedFile).toHaveBeenCalledWith("lease-created", reviewReadyFile);
    expect(result).toEqual({ leaseId: "lease-created", created: true, source: "prepare" });
  });

  it("uses an existing lease found by source_file_id without calling prepare", async () => {
    const findLeaseByFileId = vi.fn().mockResolvedValue({ id: "lease-existing" });
    const prepareLeaseReviewDraft = vi.fn();
    const linkLeaseToUploadedFile = vi.fn().mockResolvedValue("lease-existing");

    const result = await ensureLeaseReviewDraftForUpload({
      fileId: "file-1",
      fileRecord: reviewReadyFile,
      findLeaseByFileId,
      prepareLeaseReviewDraft,
      linkLeaseToUploadedFile,
    });

    expect(findLeaseByFileId).toHaveBeenCalledWith("file-1");
    expect(prepareLeaseReviewDraft).not.toHaveBeenCalled();
    expect(linkLeaseToUploadedFile).toHaveBeenCalledWith("lease-existing", reviewReadyFile);
    expect(result).toEqual({ leaseId: "lease-existing", created: false, source: "linked_lease" });
  });

  it("does not let stale failed_step=parse block the handoff", async () => {
    const prepareLeaseReviewDraft = vi.fn().mockResolvedValue({
      store_result: { inserted_ids: ["lease-from-stale-parse"] },
    });

    const result = await ensureLeaseReviewDraftForUpload({
      fileId: "file-1",
      fileRecord: reviewReadyFile,
      findLeaseByFileId: vi.fn().mockResolvedValue(null),
      prepareLeaseReviewDraft,
      linkLeaseToUploadedFile: vi.fn(),
    });

    expect(prepareLeaseReviewDraft).toHaveBeenCalledTimes(1);
    expect(result.leaseId).toBe("lease-from-stale-parse");
  });

  it("raises an actionable error when server creation fails", async () => {
    const serverError = new Error("review-approve unavailable");

    await expect(ensureLeaseReviewDraftForUpload({
      fileId: "file-1",
      fileRecord: reviewReadyFile,
      findLeaseByFileId: vi.fn().mockResolvedValue(null),
      prepareLeaseReviewDraft: vi.fn().mockRejectedValue(serverError),
      linkLeaseToUploadedFile: vi.fn(),
    })).rejects.toThrow("Could not create Lease Review record from this upload.");
  });

  it("keeps LeaseUpload helpers imported for render-time status checks", () => {
    const uploadSource = readFileSync(resolve(process.cwd(), "src/pages/LeaseUpload.jsx"), "utf8");
    expect(uploadSource).not.toContain("createLeaseDraftFromUploadedFile");
    expect(uploadSource).toContain("hasActiveLeaseExtractionJob,");
    expect(uploadSource).toContain("fileRecordActiveJobRef.current = hasActiveLeaseExtractionJob(fileRecord)");
    expect(uploadSource).toContain("const hasActiveExtractionJob = hasActiveLeaseExtractionJob(fileRecord)");
  });
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ensureLeaseReviewDraftForUpload,
  getLeaseUploadReviewStatusLabel,
  getLeaseReviewActionState,
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
  it("labels review_required uploads as Review completed on the Upload Lease page", () => {
    expect(getLeaseUploadReviewStatusLabel({ status: "review_required", failed_step: "parse" }, "Preparing review"))
      .toBe("Review completed");
    expect(getLeaseUploadReviewStatusLabel({ status: "validating" }, "Extracting lease fields"))
      .toBe("Extracting lease fields");
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
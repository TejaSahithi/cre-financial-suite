import { describe, expect, it } from "vitest";
import { getLeaseUploadPipelineState } from "../leaseUploadPipelineState";

describe("getLeaseUploadPipelineState", () => {
  const now = new Date("2026-07-22T15:00:00.000Z").getTime();

  it("treats validated/pdf_parsed as still waiting and long-running after the threshold", () => {
    const state = getLeaseUploadPipelineState({
      status: "validated",
      processing_status: "pdf_parsed",
      updated_at: "2026-07-22T14:55:00.000Z",
    }, now);

    expect(state.stage).toBe("pdf_parsed");
    expect(state.isWaiting).toBe(true);
    expect(state.isLongRunning).toBe(true);
    expect(state.elapsedLabel).toBe("5m");
  });

  it("does not mark a fresh active status as long-running", () => {
    const state = getLeaseUploadPipelineState({
      status: "validating",
      processing_status: "validating",
      updated_at: "2026-07-22T14:59:00.000Z",
    }, now);

    expect(state.isWaiting).toBe(true);
    expect(state.isLongRunning).toBe(false);
  });



  it("treats large-lease field partition continuation as active work", () => {
    const state = getLeaseUploadPipelineState({
      status: "validating",
      processing_status: "normalize_field_partition_pending",
      updated_at: "2026-07-22T14:59:00.000Z",
    }, now);

    expect(state.stage).toBe("normalize_field_partition_pending");
    expect(state.isWaiting).toBe(true);
    expect(state.isLongRunning).toBe(false);
  });
  it("does not keep complete uploads waiting because of a completed job stage", () => {
    const state = getLeaseUploadPipelineState({
      status: "validated",
      processing_status: "complete",
      display_state: "complete",
      latest_job: { status: "completed", stage: "normalize" },
      updated_at: "2026-07-22T14:55:00.000Z",
    }, now);

    expect(state.stage).toBe("complete");
    expect(state.isWaiting).toBe(false);
    expect(state.isLongRunning).toBe(false);
  });

  it("does not mark review-ready records as waiting", () => {
    const state = getLeaseUploadPipelineState({
      status: "review_required",
      processing_status: "review_required",
      updated_at: "2026-07-22T14:50:00.000Z",
    }, now);

    expect(state.isWaiting).toBe(false);
    expect(state.isLongRunning).toBe(false);
  });
});

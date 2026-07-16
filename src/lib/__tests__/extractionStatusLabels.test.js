import { describe, it, expect } from "vitest";
import { computeCanOpenReview, payloadHasMeaningfulFields } from "../extractionStatusLabels";

function payloadWithCoreReady(coreReady) {
  return {
    core_ready: coreReady,
    records: [{ standard_fields: [{ field_key: "tenant_name", value: "Acme Inc" }] }],
  };
}

describe("guarantee 10: computeCanOpenReview", () => {
  it("is false while validating/pdf_parsed with no payload yet", () => {
    expect(
      computeCanOpenReview({ hasValidReviewPayload: false, uiReviewPayload: null, status: "validating" }),
    ).toBe(false);
    expect(
      computeCanOpenReview({ hasValidReviewPayload: false, uiReviewPayload: null, status: "pdf_parsed" }),
    ).toBe(false);
  });

  it("opens review_required payloads even when core_ready is false because they are manual review drafts", () => {
    expect(
      computeCanOpenReview({
        hasValidReviewPayload: true,
        uiReviewPayload: payloadWithCoreReady(false),
        status: "review_required",
      }),
    ).toBe(true);
  });

  it("is true once core_ready is true", () => {
    expect(
      computeCanOpenReview({
        hasValidReviewPayload: true,
        uiReviewPayload: payloadWithCoreReady(true),
        status: "review_required",
      }),
    ).toBe(true);
  });

  it("is true for post-review terminal statuses regardless of payload shape", () => {
    for (const status of ["approved", "storing", "stored", "computing", "completed"]) {
      expect(
        computeCanOpenReview({ hasValidReviewPayload: false, uiReviewPayload: null, status }),
      ).toBe(true);
    }
  });

  it("falls back to payloadHasMeaningfulFields for legacy rows with no core_ready flag", () => {
    const legacyPayload = {
      records: [{ standard_fields: [{ field_key: "tenant_name", value: "Acme Inc" }] }],
    };
    expect(legacyPayload.core_ready).toBeUndefined();
    expect(
      computeCanOpenReview({ hasValidReviewPayload: true, uiReviewPayload: legacyPayload, status: "review_required" }),
    ).toBe(true);
  });

  it("is false when hasValidReviewPayload is false even if core_ready would otherwise be true", () => {
    expect(
      computeCanOpenReview({
        hasValidReviewPayload: false,
        uiReviewPayload: payloadWithCoreReady(true),
        status: "review_required",
      }),
    ).toBe(false);
  });
});

describe("payloadHasMeaningfulFields", () => {
  it("returns false for an empty/fallback payload", () => {
    expect(payloadHasMeaningfulFields(null)).toBe(false);
    expect(payloadHasMeaningfulFields({ records: [{ standard_fields: [{ value: null }] }] })).toBe(false);
  });

  it("returns true when a standard field has a real value", () => {
    expect(
      payloadHasMeaningfulFields({ records: [{ standard_fields: [{ value: "Acme Inc" }] }] }),
    ).toBe(true);
  });
});

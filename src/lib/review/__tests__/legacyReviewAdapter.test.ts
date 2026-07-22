import { describe, expect, it } from "vitest";
import { adaptLegacyReviewPayload } from "@/lib/review/adapters/legacyReviewAdapter";
import { buildReviewDocumentViewModel } from "@/lib/review/adapters/reviewAdapterRegistry";

const legacyPayload = {
  file_id: "legacy-file",
  review_readiness: "ready",
  records: [
    {
      values: { tenant_name: "Legacy Tenant" },
      fields: { tenant_name: { value: "Legacy Tenant", confidence: 88, status: "extracted" } },
      standard_fields: [],
    },
  ],
};

describe("legacy review adapter", () => {
  it("marks legacy fields as legacy-sourced view-model fields", () => {
    const document = adaptLegacyReviewPayload(legacyPayload, { uploadedFileId: "legacy-file" });

    expect(document.uploadedFileId).toBe("legacy-file");
    expect(document.fields.tenant_name.value).toBe("Legacy Tenant");
    expect(document.fields.tenant_name.source).toBe("legacy");
    expect(document.fields.tenant_name.status).toBe("resolved");
    expect(document.approval.eligible).toBe(true);
  });

  it("does not silently fall back to legacy when strict canonical payload is unavailable", () => {
    expect(() => buildReviewDocumentViewModel({ rolloutMode: "canonical_strict", enterprisePayload: null, legacyPayload })).toThrow(/Unsupported review payload schema/i);
  });
});
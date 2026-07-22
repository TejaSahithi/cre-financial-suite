import { describe, expect, it } from "vitest";
import { canonicalStatusToReviewStatus, getReviewStatusPresentation, normalizeReviewFieldStatus } from "@/lib/review/reviewStatusPresentation";

const precedenceStatuses = [
  "invalid",
  "missing",
  "missing_source_evidence",
  "conflict",
  "needs_review",
  "legacy_fallback",
  "not_found",
  "not_applicable",
  "resolved_with_warning",
  "resolved",
];

describe("review status presentation", () => {
  it("has presentation metadata for every Release 5 review status", () => {
    for (const status of precedenceStatuses) {
      const presentation = getReviewStatusPresentation(status);
      expect(presentation.label).toBeTruthy();
      expect(presentation.className).toContain("text-");
    }
  });

  it("maps legacy status aliases without flattening canonical statuses", () => {
    expect(normalizeReviewFieldStatus("auto_populated")).toBe("resolved");
    expect(normalizeReviewFieldStatus("conflict")).toBe("conflict");
    expect(canonicalStatusToReviewStatus("legacy_fallback")).toBe("auto_populated");
    expect(canonicalStatusToReviewStatus("invalid")).toBe("needs_review");
  });
});
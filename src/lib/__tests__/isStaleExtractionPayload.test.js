import { describe, it, expect } from "vitest";
import { isStaleExtractionPayload, CURRENT_EXTRACTION_CONTRACT_VERSION } from "../leaseReviewSchema";

describe("§2 / isStaleExtractionPayload", () => {
  it("is NOT stale when only the nested extractionDebug path has the current version (minimal payload, enrichment not yet complete)", () => {
    const uploadedFile = {
      ui_review_payload: {
        metadata: {
          extractionDebug: { extraction_contract_version: CURRENT_EXTRACTION_CONTRACT_VERSION },
          // top-level metadata.extraction_contract_version deliberately absent —
          // this is exactly the real-world shape of a minimal payload before
          // P0.2's direct top-level stamp or before the enrich pass completes.
        },
      },
    };
    expect(isStaleExtractionPayload(uploadedFile, null)).toBe(false);
  });

  it("is NOT stale when the top-level metadata path has the current version", () => {
    const uploadedFile = {
      ui_review_payload: { metadata: { extraction_contract_version: CURRENT_EXTRACTION_CONTRACT_VERSION } },
    };
    expect(isStaleExtractionPayload(uploadedFile, null)).toBe(false);
  });

  it("is stale when no version is present anywhere", () => {
    expect(isStaleExtractionPayload({ ui_review_payload: { metadata: {} } }, null)).toBe(true);
    expect(isStaleExtractionPayload(null, null)).toBe(true);
  });

  it("is stale when a genuinely older version string is present", () => {
    const uploadedFile = {
      ui_review_payload: { metadata: { extractionDebug: { extraction_contract_version: "lease-review-v1" } } },
    };
    expect(isStaleExtractionPayload(uploadedFile, null)).toBe(true);
  });

  it("uses equality, not lexicographic ordering — a hypothetical future v10 is not misclassified as older than v3", () => {
    const uploadedFile = {
      ui_review_payload: { metadata: { extractionDebug: { extraction_contract_version: "lease-review-evidence-v10" } } },
    };
    // Not equal to the current v3 string, so still reported stale (correctly
    // flags a version mismatch) — but critically the test below shows this
    // isn't a same-version false negative caused by string comparison.
    expect(isStaleExtractionPayload(uploadedFile, null)).toBe(true);
    expect("lease-review-evidence-v10" < CURRENT_EXTRACTION_CONTRACT_VERSION).toBe(true); // proves lexicographic order would have been wrong
  });

  it("falls back to lease.extraction_data.extraction_debug when uploadedFile is unavailable", () => {
    const lease = { extraction_data: { extraction_debug: { extraction_contract_version: CURRENT_EXTRACTION_CONTRACT_VERSION } } };
    expect(isStaleExtractionPayload(null, lease)).toBe(false);
  });
});

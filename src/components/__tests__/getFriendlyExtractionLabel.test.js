import { describe, it, expect } from "vitest";
import { getFriendlyExtractionLabel } from "@/lib/extractionStatusLabels";

describe("getFriendlyExtractionLabel", () => {
  const cases = [
    ["uploaded", "Preparing document"],
    ["parsing", "Preparing document"],
    ["pdf_parsed", "Reading document"],
    ["validating", "Extracting lease fields"],
    ["validated", "Preparing review"],
    ["storing", "Preparing review"],
    ["stored", "Preparing review"],
    ["computing", "Preparing review"],
    ["review_required", "Preparing review"],
    ["completed", "Complete"],
    ["failed", "Extraction failed"],
    ["cancelled", "Cancelled"],
    [null, "Processing..."],
    [undefined, "Processing..."],
    ["some_unrecognized_status", "Processing..."],
  ];

  for (const [status, expected] of cases) {
    it(`maps ${JSON.stringify(status)} -> ${JSON.stringify(expected)}`, () => {
      expect(getFriendlyExtractionLabel(status)).toBe(expected);
    });
  }
});

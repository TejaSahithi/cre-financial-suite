import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanReviewSchemaBoundaries } from "../check-review-schema-boundaries.mjs";

describe("review schema boundary scanner", () => {
  it("passes the checked active review components", () => {
    expect(scanReviewSchemaBoundaries()).toEqual([]);
  });

  it("reports raw backend payload access in a checked component", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-boundary-"));
    const relative = path.relative(process.cwd(), path.join(tempDir, "BadReview.jsx"));
    fs.writeFileSync(path.join(tempDir, "BadReview.jsx"), "export const x = props.ui_review_payload?.canonicalFieldKey;\n", "utf8");

    const violations = scanReviewSchemaBoundaries({ targets: [relative] });

    expect(violations.map((violation) => violation.rule)).toEqual(expect.arrayContaining(["raw ui_review_payload access", "backend canonicalFieldKey key"]));
  });
});

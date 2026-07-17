import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Phase 5D Lease Review source-link contract", () => {
  it("does not auto-write heuristic source links from same-org upload candidates", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");
    const candidateScan = source.slice(
      source.indexOf("Auto-link: when a lease has no source_file_id"),
      source.indexOf("// Manual link from the banner picker."),
    );

    expect(candidateScan).toContain("source-link candidates require manual selection");
    expect(candidateScan).not.toContain("source_file_auto_linked");
    expect(candidateScan).not.toContain(".update({ extraction_data");
  });
});
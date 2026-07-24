import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LeaseReview normalized tab wiring", () => {
  it("defines enterpriseTabs from normalized tabs before rendering tab tables", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");
    expect(source).toContain("const enterpriseTabs = normalized.tabs || {};");

    const definitionIndex = source.indexOf("const enterpriseTabs = normalized.tabs || {};");
    const firstUsageIndex = source.indexOf("enterpriseTabs[");
    expect(definitionIndex).toBeGreaterThan(-1);
    expect(firstUsageIndex).toBeGreaterThan(definitionIndex);
  });

  it("does not render a duplicate top-level Dynamic Findings panel above business tabs", () => {
    const source = readFileSync(resolve(process.cwd(), "src/pages/LeaseReview.jsx"), "utf8");
    expect(source).not.toContain("components/lease-review/DynamicFindings");
    expect(source).not.toContain("<DynamicFindings");
  });
});

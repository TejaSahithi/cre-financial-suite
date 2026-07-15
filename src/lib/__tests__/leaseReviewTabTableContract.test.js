import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("LeaseReviewTabTable contract", () => {
  const source = readFileSync(resolve(process.cwd(), "src/components/lease-review/LeaseReviewTabTable.jsx"), "utf8");

  it("does not render a visible Type table column", () => {
    expect(source).not.toContain('>Type</TableHead>');
    expect(source).not.toContain('{typeMeta.label}');
  });

  it("renders field row actions through the enterprise action menu", () => {
    expect(source).toContain("DropdownMenuTrigger");
    expect(source).toContain(">Accept</DropdownMenuItem>");
    expect(source).toContain(">Edit</DropdownMenuItem>");
    expect(source).toContain(">Mark Needs Review</DropdownMenuItem>");
    expect(source).toContain(">Mark N/A</DropdownMenuItem>");
    expect(source).toContain(">Reject</DropdownMenuItem>");
    expect(source).toContain(">View Source</DropdownMenuItem>");
    expect(source).not.toContain('title="Accept"');
    expect(source).not.toContain('title="Reject"');
  });
});

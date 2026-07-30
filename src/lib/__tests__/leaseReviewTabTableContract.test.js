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

  it("Phase 40: renders an Extraction Mode column", () => {
    expect(source).toContain(">Extraction Mode</TableHead>");
    expect(source).toContain("row.extractionMode");
  });

  it("Phase 40: column order is Field / Term, Value, Status, Confidence, Extraction Mode, Page, Source Text, Action", () => {
    const headerOrder = [
      ">Field / Term</TableHead>",
      ">Value</TableHead>",
      ">Status</TableHead>",
      ">Confidence</TableHead>",
      ">Extraction Mode</TableHead>",
      ">Page</TableHead>",
      ">Source Text</TableHead>",
      ">Action</TableHead>",
    ];
    const indices = headerOrder.map((header) => {
      const index = source.indexOf(header);
      expect(index, `expected to find header ${header}`).toBeGreaterThan(-1);
      return index;
    });
    const sorted = [...indices].sort((a, b) => a - b);
    expect(indices).toEqual(sorted);
  });

  it("Phase 40: empty-state colSpan accounts for the new 8-column layout", () => {
    expect(source).toContain("colSpan={8}");
    expect(source).not.toContain("colSpan={7}");
  });

  it("separates filled rows from missing/source-only rows and cleans source previews", () => {
    expect(source).toContain("completenessFilter");
    expect(source).toContain('useState("filled")');
    expect(source).toContain("Filled");
    expect(source).toContain("Missing");
    expect(source).toContain("rowMatchesCompletenessFilter(row, completenessFilter)");
    expect(source).toContain("cleanSourceEvidenceText(text, { truncate: false })");
    expect(source).toContain("valuePreview(rawRowValue)");
  });
});

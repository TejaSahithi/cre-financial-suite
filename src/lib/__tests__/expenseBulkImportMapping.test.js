import { describe, expect, it } from "vitest";
import { buildExpenseBulkImportColumnMap } from "@/lib/expenseBulkImportMapping";

function expectMaconActualExpenseMap(headers) {
  expect(buildExpenseBulkImportColumnMap(headers)).toMatchObject({
    "Source Type": "source_type",
    Category: "category",
    Subcategory: "expense_subcategory",
    Amount: "amount",
    Vendor: "vendor",
  });
}

describe("buildExpenseBulkImportColumnMap", () => {
  it("maps category, subcategory, and source type by header name regardless of column order", () => {
    expectMaconActualExpenseMap([
      "Source Type",
      "Amount",
      "Subcategory",
      "Vendor",
      "Category",
    ]);

    expectMaconActualExpenseMap([
      "Category",
      "Vendor",
      "Source Type",
      "Amount",
      "Subcategory",
    ]);
  });

  it("does not map generic type-like headers to category unless they are explicit category headers", () => {
    expect(buildExpenseBulkImportColumnMap(["Source Type", "Expense Type", "Type", "Category"])).toEqual({
      "Source Type": "source_type",
      Category: "category",
    });
  });
});
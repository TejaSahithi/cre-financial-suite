import { describe, expect, it } from "vitest";

import {
  buildInvoiceExpenseCandidate,
  extractExpenseRowsFromUploadedFile,
  findEntityByName,
} from "@/lib/expenseInvoicePrefill";

describe("expense invoice prefill", () => {
  it("reads the canonical review-payload field format", () => {
    const rows = extractExpenseRowsFromUploadedFile({
      ui_review_payload: {
        records: [{
          standard_fields: [
            { field_key: "invoice_date", value: "07/15/2026", status: "auto_populated" },
            { field_key: "total_amount", value: "$1,250.40", status: "auto_populated" },
            { field_key: "vendor_name", value: "ABC Services", status: "auto_populated" },
          ],
        }],
      },
    });

    expect(buildInvoiceExpenseCandidate(rows[0], ["general_repairs"])).toMatchObject({
      date: "2026-07-15",
      amount: "1250.4",
      vendor: "ABC Services",
    });
  });

  it("normalizes supported expense aliases without inventing unknown categories", () => {
    expect(buildInvoiceExpenseCandidate(
      { expense_type: "Maintenance", recovery_type: "Owner" },
      ["general_repairs", "utilities"]
    )).toMatchObject({
      category: "general_repairs",
      classification: "non_recoverable",
    });
    expect(buildInvoiceExpenseCandidate({ category: "Unrecognized Thing" }, ["utilities"]).category).toBe("");
  });

  it("only auto-links an entity when the name match is unambiguous", () => {
    const rows = [{ id: "a", name: "North Tower" }, { id: "b", name: "South Tower" }];
    expect(findEntityByName(rows, "North Tower", [(row) => row.name])?.id).toBe("a");
    expect(findEntityByName(rows, "Tower", [(row) => row.name])).toBeNull();
  });
});

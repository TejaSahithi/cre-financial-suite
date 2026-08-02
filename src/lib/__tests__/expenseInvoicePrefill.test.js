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


  it("repairs bad DOCX invoice field assignments from labeled document text", () => {
    const sourceRecord = {
      docling_raw: {
        text: `NORTHSTAR FACILITY SERVICES LLC 1450 Westlake Avenue INVOICE Invoice No.: NSFS-2026-0728 Invoice Date: July 28, 2026 Due Date: August 27, 2026 BILL TO Cedar Grove Property Management Property: Cedar Grove Office Center SERVICE DETAILS Service Date: July 26, 2026 Expense Category: Repairs & Maintenance - HVAC Property ID: CGOC-1001 SERVICE SUMMARY Emergency inspection and repair of rooftop HVAC unit RTU-4 serving the third-floor east wing. Expense Coding GL Account: 6105 - Repairs & Maintenance Department: Property Operations Lease / Tenant Allocation: Common Area / Landlord Expense Approval Status: Pending Manager Review Subtotal $1,001.50 Sales Tax (8.25%) $82.62 Total Due $1,084.12 PAYMENT TERMS: Net 30. Reference invoice NSFS-2026-0728. Approved By: ________________ Date: ________________`,
      },
    };

    const candidate = buildInvoiceExpenseCandidate({
      gl_account: "Subtotal $1,001.50 Sales Tax (8.25%) $82.62 Total",
      invoice_number: "Approved By: ________________ Date: ________________",
      description: "Invoice Approved By: Date:",
    }, ["hvac_maintenance", "general_repairs"], sourceRecord);

    expect(candidate).toMatchObject({
      date: "2026-07-28",
      amount: "1084.12",
      category: "hvac_maintenance",
      gl_code: "6105 - Repairs & Maintenance",
      invoice_number: "NSFS-2026-0728",
      vendor: "NORTHSTAR FACILITY SERVICES LLC",
      property_name: "Cedar Grove Office Center",
      classification: "non_recoverable",
    });
    expect(candidate.description).toContain("Emergency inspection");
  });
  it("only auto-links an entity when the name match is unambiguous", () => {
    const rows = [{ id: "a", name: "North Tower" }, { id: "b", name: "South Tower" }];
    expect(findEntityByName(rows, "North Tower", [(row) => row.name])?.id).toBe("a");
    expect(findEntityByName(rows, "Tower", [(row) => row.name])).toBeNull();
  });
});

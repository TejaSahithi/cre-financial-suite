import { describe, expect, it } from "vitest";
import { splitRulesForLeaseReview } from "@/services/utils/leaseExpenseRuleTaxonomy";

describe("Lease Review expense rule tab partitioning", () => {
  const base = {
    exact_source_text: "Tenant shall pay the charge stated in this lease clause.",
    source_page: 5,
    review_status: "needs_review",
  };

  it("returns non-CAM rules for the Expenses tab", () => {
    const { expenseRules } = splitRulesForLeaseReview([
      { ...base, id: "cam", expense_category: "common_area_maintenance" },
      { ...base, id: "utilities", expense_category: "electricity" },
      { ...base, id: "insurance", expense_category: "tenant_insurance" },
    ]);

    expect(expenseRules.map((row) => row.id)).toEqual(["utilities", "insurance"]);
    expect(expenseRules[0].source_text).toContain("lease clause");
    expect(expenseRules[0].status).toBe("needs_review");
  });

  it("returns CAM/operating/recovery rules for the CAM tab", () => {
    const { camRules } = splitRulesForLeaseReview([
      { ...base, id: "cam", expense_category: "common_area_maintenance" },
      { ...base, id: "reconciliation", expense_category: "annual_reconciliation" },
      { ...base, id: "taxes", expense_category: "real_estate_taxes" },
    ]);

    expect(camRules.map((row) => row.id)).toEqual(["cam", "reconciliation"]);
  });
});

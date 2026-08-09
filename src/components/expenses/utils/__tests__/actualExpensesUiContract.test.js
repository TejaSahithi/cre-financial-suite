import { describe, expect, it } from "vitest";

import {
  ACCOUNTING_STATUS_LABELS,
  ACTUAL_EXPENSES_UI_CONTRACT_VERSION,
  RECOVERY_STATUS_LABELS,
  expenseNeedsClassification,
  getAccountingStatus,
  getCanonicalCategoryLabel,
  getRecoveryStatusFromClassification,
  selectCanonicalExpenseClassification,
} from "../actualExpensesUiContract";

describe("Actual Expenses V1 UI contract", () => {
  it("freezes the contract version and visible vocabularies", () => {
    expect(ACTUAL_EXPENSES_UI_CONTRACT_VERSION).toBe("actual_expenses_v1");
    expect(Object.values(ACCOUNTING_STATUS_LABELS)).toEqual(["Pending", "Approved", "Rejected"]);
    expect(Object.values(RECOVERY_STATUS_LABELS)).toEqual([
      "Pending Classification",
      "Pooled CAM",
      "Direct Recovery",
      "Direct Bill",
      "Tenant Direct",
      "Included in Rent",
      "Nonrecoverable",
      "Conditional Review",
      "Needs Review",
      "Published to CAM",
    ]);
  });

  it("does not convert accounting approval into a recovery status", () => {
    expect(getAccountingStatus({ approval_status: "approved" }).label).toBe("Approved");
    expect(getRecoveryStatusFromClassification(null).label).toBe("Pending Classification");
  });

  it("uses expense_category_id as authoritative for the primary category", () => {
    expect(getCanonicalCategoryLabel({ category: "repairs" }).label).toBe("Needs Category");
    const categories = new Map([["cat-1", { category_name: "Utilities", subcategory_name: "Electric" }]]);
    expect(getCanonicalCategoryLabel({ expense_category_id: "cat-1", category: "raw import" }, categories)).toMatchObject({
      label: "Utilities",
      subcategory: "Electric",
    });
  });

  it("maps only canonical classification fields into frozen recovery statuses", () => {
    expect(getRecoveryStatusFromClassification({ recoverability_result: "recoverable", cam_eligible: "yes" }).label).toBe("Pooled CAM");
    expect(getRecoveryStatusFromClassification({ recovery_method: "direct_bill", recoverability_result: "recoverable" }).label).toBe("Direct Bill");
    expect(getRecoveryStatusFromClassification({ sent_to_cam: true, recovery_status: "recoverable" }).label).toBe("Published to CAM");
  });

  it("marks missing canonical category or missing classification as needing classification", () => {
    expect(expenseNeedsClassification({ expense_category_id: null }, { recovery_status: "non_recoverable" })).toBe(true);
    expect(expenseNeedsClassification({ expense_category_id: "cat-1" }, null)).toBe(true);
    expect(expenseNeedsClassification({ expense_category_id: "cat-1" }, { recovery_status: "non_recoverable" })).toBe(false);
  });
  it("honors outside-CAM route breadcrumbs over generic recoverable CAM fields", () => {
    const status = getRecoveryStatusFromClassification({
      classification_status: "finalized",
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      rule_source: "manual",
      next_step: "No CAM - Tenant Pays Vendor",
    });

    expect(status.label).toBe("Tenant Direct");
  });

  it("selects the finalized canonical classification when multiple rows exist for an expense", () => {
    const selected = selectCanonicalExpenseClassification([
      {
        id: "old",
        classification_status: "matched",
        recoverability_result: "recoverable",
        cam_eligible: "yes",
        classified_at: "2026-08-01T00:00:00Z",
      },
      {
        id: "current",
        classification_status: "finalized",
        recoverability_result: "recoverable",
        cam_eligible: "yes",
        next_step: "No CAM - Tenant Pays Vendor",
        finalized_at: "2026-08-07T00:00:00Z",
      },
    ]);

    expect(selected.id).toBe("current");
    expect(getRecoveryStatusFromClassification(selected).label).toBe("Tenant Direct");
  });
});

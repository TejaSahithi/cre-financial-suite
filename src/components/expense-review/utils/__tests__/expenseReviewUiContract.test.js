import { describe, expect, it } from "vitest";
import {
  buildExpenseReviewReportRows,
  buildExpenseReviewUiRow,
  calculateExpenseReviewTieOut,
  canSendExpenseReviewRowToCam,
  filterFinalizedExpenseReviewRows,
  getExpenseReviewExceptionCounts,
  isExpenseReviewException,
  isExpenseReviewFinalized,
} from "../expenseReviewUiContract";

const baseFinalized = {
  id: "c1",
  actual_expense_id: "e1",
  classification_status: "finalized",
  property_id: "p1",
  expense_category_id: "cat1",
  category: "Utilities",
  amount: 100,
  cam_eligible: "yes",
  recoverability_result: "recoverable",
};

describe("expenseReviewUiContract", () => {
  it("keeps normal resolved finalized rows out of the exception queue", () => {
    expect(isExpenseReviewFinalized(baseFinalized)).toBe(true);
    expect(isExpenseReviewException(baseFinalized)).toBe(false);
    const uiRow = buildExpenseReviewUiRow(baseFinalized);
    expect(uiRow.v1Decision.label).toBe("Pooled CAM");
    expect(uiRow.v1CamStatus.label).toBe("Ready to Publish");
  });

  it("maps persisted missing-information states to contextual review actions", () => {
    const row = buildExpenseReviewUiRow({
      id: "c2",
      actual_expense_id: "e2",
      classification_status: "exception",
      exception_type: "needs_category",
      property_id: "p1",
      amount: 75,
    });

    expect(isExpenseReviewException(row)).toBe(true);
    expect(row.v1Issue.label).toBe("Missing category");
    expect(row.v1Issue.requiredDecision).toBe("Assign Category");
    expect(getExpenseReviewExceptionCounts([row])).toMatchObject({ missingInformation: 1, total: 1, amount: 75 });
  });

  it("treats outside-CAM routes as valid finalized decisions with CAM N/A", () => {
    const row = buildExpenseReviewUiRow({
      ...baseFinalized,
      id: "c3",
      recovery_method: "tenant_direct",
      cam_eligible: "no",
    });

    expect(row.v1Decision.label).toBe("Tenant Direct");
    expect(row.v1CamStatus.label).toBe("N/A");
    expect(canSendExpenseReviewRowToCam(row)).toBe(false);
  });

  it("shows published CAM independently from the financial decision", () => {
    const input = { classification_result_id: "c1", publication_status: "published", status: "active", amount: 100 };
    const row = buildExpenseReviewUiRow(baseFinalized, { publishedInput: input });

    expect(row.v1Decision.label).toBe("Pooled CAM");
    expect(row.v1CamStatus.label).toBe("Published");
  });

  it("ties out finalized financial routes and keeps exception dollars separate", () => {
    const rows = [
      buildExpenseReviewUiRow({ ...baseFinalized, id: "pooled", amount: 100 }),
      buildExpenseReviewUiRow({ ...baseFinalized, id: "direct", amount: 50, recovery_method: "direct_recovery", lease_id: "l1", tenant_id: "t1" }),
      buildExpenseReviewUiRow({ ...baseFinalized, id: "bill", amount: 25, recovery_method: "direct_bill", cam_eligible: "no" }),
      buildExpenseReviewUiRow({ ...baseFinalized, id: "nr", amount: 10, recoverability_result: "non_recoverable", cam_eligible: "no" }),
    ];

    const tieOut = calculateExpenseReviewTieOut(rows, new Map());
    expect(tieOut.totalFinalized).toBe(185);
    expect(tieOut.routeTotal).toBe(185);
    expect(tieOut.tieOutOk).toBe(true);
    expect(tieOut.readyForCam).toBe(150);
    expect(tieOut.outsideCam).toBe(35);
  });

  it("exports only finalized report rows passed from the current filter", () => {
    const rows = [
      buildExpenseReviewUiRow({ ...baseFinalized, id: "ready", amount: 10 }),
      buildExpenseReviewUiRow({ ...baseFinalized, id: "outside", amount: 20, recovery_method: "included_in_rent", cam_eligible: "no" }),
    ];

    const outsideRows = filterFinalizedExpenseReviewRows(rows, "outside_cam");
    expect(outsideRows).toHaveLength(1);
    expect(buildExpenseReviewReportRows(outsideRows)[0].Decision).toBe("Included in Rent");
  });
});

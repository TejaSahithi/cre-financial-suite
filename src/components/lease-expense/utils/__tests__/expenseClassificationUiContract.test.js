import { describe, expect, it } from "vitest";
import {
  CLASSIFICATION_TABS,
  DECISION_LABELS,
  EXPENSE_CLASSIFICATION_UI_CONTRACT_VERSION,
  NEXT_STEP_BY_DECISION,
  POLICY_EVIDENCE_LABELS,
  buildClassificationCounts,
  buildClassificationUiRow,
  calculateClassificationTieOut,
  deriveClassificationDecision,
  derivePolicyEvidence,
} from "../expenseClassificationUiContract";

const baseRow = {
  id: "row-1",
  rowType: "matched_classification",
  actualExpenseId: "expense-1",
  amount: 100,
  financialAmount: 100,
  classificationStatus: "finalized",
  recoverabilityResult: "recoverable",
  camEligible: "yes",
  property: { id: "property-1" },
  expenseCategoryId: "category-1",
  servicePeriodStart: "2026-01-01",
  servicePeriodEnd: "2026-01-31",
  classificationRecord: { id: "classification-1", classification_status: "finalized" },
};

describe("Expense Classification V1 UI contract", () => {
  it("freezes tabs, policy evidence, decision labels, and next steps", () => {
    expect(EXPENSE_CLASSIFICATION_UI_CONTRACT_VERSION).toBe("expense_classification_v1");
    expect(CLASSIFICATION_TABS.map((tab) => tab.label)).toEqual([
      "All",
      "Ready for CAM",
      "Needs Review",
      "Outside CAM",
      "Published",
      "Coverage Gaps",
    ]);
    expect(Object.values(POLICY_EVIDENCE_LABELS)).toEqual([
      "Policy Coverage Found",
      "Direct Policy Found",
      "Multiple Policy Matches",
      "No Policy Coverage",
      "No Policy Required",
      "Needs Review",
    ]);
    expect(Object.values(DECISION_LABELS)).toEqual([
      "Pooled CAM",
      "Direct Recovery",
      "Direct Bill",
      "Tenant Direct",
      "Included in Rent",
      "Nonrecoverable",
      "Conditional Review",
      "Needs Category",
      "Needs Scope",
      "Needs Service Period",
      "Needs Tenant / Lease",
      "Policy Conflict",
      "Published",
    ]);
    expect(NEXT_STEP_BY_DECISION.tenant_direct).toBe("No CAM \u2014 Tenant Pays Vendor");
  });

  it("maps outside-CAM policies to business routes instead of technical exclusion labels", () => {
    const tenantDirect = {
      ...baseRow,
      rule: { recovery_treatment: "tenant_direct", payment_treatment: "tenant_direct_contract", approval_status: "approved" },
    };
    const included = {
      ...baseRow,
      rule: { recovery_treatment: "included_in_rent", included_in_base_rent: true, approval_status: "approved" },
    };
    const nonrecoverable = {
      ...baseRow,
      recoverabilityResult: "non_recoverable",
      rule: { recovery_treatment: "nonrecoverable", recoverable_from_tenant: "no", approval_status: "approved" },
    };

    expect(deriveClassificationDecision(tenantDirect).label).toBe("Tenant Direct");
    expect(deriveClassificationDecision(included).label).toBe("Included in Rent");
    expect(deriveClassificationDecision(nonrecoverable).label).toBe("Nonrecoverable");
  });

  it("does not let a stale finalized outside-CAM row bypass a missing actual category", () => {
    const row = buildClassificationUiRow({
      ...baseRow,
      id: "missing-actual-category",
      expenseCategoryId: null,
      actualExpenseCategoryId: null,
      classificationStatus: "finalized",
      classificationRecord: {
        id: "classification-tenant-direct",
        classification_status: "finalized",
        next_step: "No CAM - Tenant Pays Vendor",
      },
      rule: { recovery_treatment: "tenant_direct", approval_status: "approved" },
    });

    expect(row.v1Decision.label).toBe("Needs Category");
    expect(row.v1Status.label).toBe("Needs Review");
    expect(row.v1Tab).toBe("needs_review");
  });

  it("keeps policy evidence separate from the financial decision", () => {
    const row = {
      ...baseRow,
      matchCandidateCount: 3,
      rule: { recovery_treatment: "direct_recovery", approval_status: "approved" },
    };

    expect(derivePolicyEvidence(row).label).toBe("Multiple Policy Matches");
    expect(deriveClassificationDecision(row).label).toBe("Policy Conflict");
  });

  it("builds V1 tabs from business workflow state", () => {
    const ready = buildClassificationUiRow({ ...baseRow, rule: { recovery_treatment: "pooled_recovery", approval_status: "approved" } }, { state: "ready_to_send" });
    const outside = buildClassificationUiRow({ ...baseRow, id: "outside", rule: { recovery_treatment: "direct_bill", approval_status: "approved" } });
    const needsReview = buildClassificationUiRow({ ...baseRow, id: "needs", expenseCategoryId: null }, { state: "needs_category" });
    const published = buildClassificationUiRow({ ...baseRow, id: "published" }, { state: "published_to_cam" });
    const gap = buildClassificationUiRow({ id: "gap", rowType: "rule_missing_actual" });

    expect(buildClassificationCounts([ready, outside, needsReview, published, gap])).toEqual({
      all: 4,
      ready_for_cam: 1,
      needs_review: 1,
      outside_cam: 1,
      published: 1,
      coverage_gaps: 1,
    });
  });

  it("ties approved actuals exactly to mutually exclusive route buckets and keeps published CAM total separate", () => {
    const rows = [
      buildClassificationUiRow({ ...baseRow, id: "pooled", amount: 100, financialAmount: 100, rule: { recovery_treatment: "pooled_recovery", approval_status: "approved" } }),
      buildClassificationUiRow({ ...baseRow, id: "direct", amount: 50, financialAmount: 50, rule: { recovery_treatment: "direct_recovery", approval_status: "approved" } }),
      buildClassificationUiRow({ ...baseRow, id: "bill", amount: 25, financialAmount: 25, rule: { recovery_treatment: "direct_bill", approval_status: "approved" } }),
      buildClassificationUiRow({ ...baseRow, id: "tenant", amount: 10, financialAmount: 10, rule: { recovery_treatment: "tenant_direct", approval_status: "approved" } }),
      buildClassificationUiRow({ ...baseRow, id: "rent", amount: 5, financialAmount: 5, rule: { recovery_treatment: "included_in_rent", approval_status: "approved" } }),
      buildClassificationUiRow({ ...baseRow, id: "no", amount: 4, financialAmount: 4, recoverabilityResult: "non_recoverable", rule: { recovery_treatment: "nonrecoverable", approval_status: "approved" } }),
      buildClassificationUiRow({ ...baseRow, id: "review", amount: 3, financialAmount: 3, recoverabilityResult: "conditional", rule: { recovery_treatment: "conditional", approval_status: "approved" } }),
    ];
    const totals = calculateClassificationTieOut(rows, [
      { publication_status: "published", status: "active", amount: 100, recovery_method: "pooled" },
      { publication_status: "published", status: "active", amount: 50, recovery_method: "direct_recovery" },
    ]);

    expect(totals.approvedActualExpenses).toBe(197);
    expect(totals.routeTotal).toBe(197);
    expect(totals.tieOutOk).toBe(true);
    expect(totals.publishedCamTotal).toBe(50);
  });
});

import { describe, expect, it } from "vitest";
import {
  CAM_STATUS_LABELS,
  CONTRACT_STATUS_LABELS,
  LANDLORD_EXPENSE_LABELS,
  LEASE_EXPENSE_RULES_UI_CONTRACT_VERSION,
  TREATMENT_LABELS,
  getAmountFormulaLabel,
  getContractStatus,
  getSimplifiedRuleView,
} from "../leaseExpenseRulesHelpers";

const treatmentLabels = () => Object.values(TREATMENT_LABELS);
const camLabels = () => Object.values(CAM_STATUS_LABELS);
const contractLabels = () => Object.values(CONTRACT_STATUS_LABELS);
const landlordExpenseLabels = () => Object.values(LANDLORD_EXPENSE_LABELS);

describe("Lease Expense Rules UI Contract v1", () => {
  it("freezes the public vocabularies", () => {
    expect(LEASE_EXPENSE_RULES_UI_CONTRACT_VERSION).toBe("lease_expense_rules_ui_v1");
    expect(treatmentLabels()).toEqual([
      "Pooled Recovery",
      "Direct Recovery",
      "Direct Bill",
      "Tenant Direct",
      "Included in Rent",
      "Compliance Only",
      "Nonrecoverable",
      "Conditional",
    ]);
    expect(camLabels()).toEqual(["Eligible", "Conditional", "N/A", "Blocked"]);
    expect(contractLabels()).toEqual(["Needs Review", "Approved", "Rejected", "Superseded"]);
    expect(landlordExpenseLabels()).toEqual(["Yes", "No", "Conditional"]);
  });

  it("clamps unknown backend tokens into frozen V1 labels", () => {
    const view = getSimplifiedRuleView({
      recovery_treatment: "future_policy_state",
      actual_expense_expected: "future_expense_state",
      cam_eligible: "maybe",
    });

    expect(view.treatmentLabel).toBe("Conditional");
    expect(view.actualExpenseLabel).toBe("Conditional");
    expect(treatmentLabels()).toContain(view.treatmentLabel);
    expect(camLabels()).toContain(view.camLabel);
  });

  it("shows CAM N/A for outside-CAM treatments", () => {
    for (const recovery_treatment of [
      "tenant_direct",
      "included_in_rent",
      "compliance_only",
      "direct_bill",
      "nonrecoverable",
    ]) {
      expect(getSimplifiedRuleView({ recovery_treatment }).camLabel).toBe("N/A");
    }
  });

  it("requires allocation review for pooled recovery with no stated allocation", () => {
    const rule = {
      recovery_treatment: "pooled_recovery",
      recoverable_from_tenant: "yes",
      cam_eligible: "yes",
      approval_status: "approved",
      review_status: "approved",
      expense_category: "common_area_maintenance",
      exact_source_text: "Tenant shall reimburse Landlord for common area maintenance expenses.",
      source_page: 12,
    };

    expect(getAmountFormulaLabel(rule)).toBe("Needs Allocation Review");
    const view = getSimplifiedRuleView(rule);
    expect(view.camLabel).toBe("Blocked");
    expect(view.camReason).toBe("Allocation basis is required before CAM recovery can proceed.");
  });

  it("uses one frozen contract status badge", () => {
    expect(getContractStatus({ approval_status: "approved", review_status: "approved" }).label).toBe("Approved");
    expect(getContractStatus({ approval_status: "rejected", review_status: "rejected" }).label).toBe("Rejected");
    expect(getContractStatus({ approval_status: "draft", review_status: "draft" }).label).toBe("Needs Review");
    expect(getContractStatus({ row_status: "superseded" }).label).toBe("Superseded");
  });
});

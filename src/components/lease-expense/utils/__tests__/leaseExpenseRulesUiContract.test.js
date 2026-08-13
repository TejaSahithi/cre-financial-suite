import { describe, expect, it } from "vitest";
import {
  CAM_STATUS_LABELS,
  CONTRACT_STATUS_LABELS,
  LANDLORD_EXPENSE_LABELS,
  LEASE_EXPENSE_RULES_UI_CONTRACT_VERSION,
  TREATMENT_LABELS,
  buildRuleEditForm,
  getAmountFormulaLabel,
  getAppliesWhenLabel,
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

  it("shows CAM Conditional (not N/A) for a base-year tax escalation the extraction flagged cam_eligible:no", () => {
    // Regression, real production row: "Tenant pays 70% of the increase ...
    // real estate taxes over the 2026 base taxes" had payment_treatment=
    // reimbursable, recoverable_from_tenant=yes, tenant_share_percent=70 --
    // every structural signal of a pooled recovery clause -- but the
    // extraction had stamped cam_eligible="no" on it, which made the row
    // show CAM "N/A" (reads as "definitely excluded"). Confirmed policy:
    // base-year escalations DO participate in CAM. See the matching fix in
    // ruleDecisionEngine.js's deriveCamEligibility().
    const rule = {
      expense_category: "real_estate_taxes",
      expense_subcategory: "tax_escalation",
      payment_treatment: "reimbursable",
      recoverable_from_tenant: "yes",
      is_recoverable: true,
      recovery_method: "base_year",
      tenant_share_percent: "70",
      allocation_basis: "70% of increase over stated base taxes",
      cam_eligible: "no",
      actual_expense_expected: "yes",
      approval_status: "draft",
      review_status: "needs_review",
    };
    const view = getSimplifiedRuleView(rule);
    expect(view.treatmentLabel).toBe("Pooled Recovery");
    expect(view.camLabel).toBe("Conditional");
  });

  it("reads the applies-when condition from the clause text, not just the category label", () => {
    // Regression: "Applies When" only scanned category_name/expense_subcategory
    // for condition keywords, so a base-year tax escalation clause ("...over
    // the 2026 calendar-year base taxes") fell through to a bare "Always"
    // even though the lease clearly states the condition.
    const baseYearTaxEscalation = {
      expense_category: "real_estate_taxes",
      expense_subcategory: "tax_escalation",
      exact_source_text: "Tenant pays 70% of the increase in combined city, county, school, and special-district real estate taxes over the 2026 calendar-year base taxes of $38,400.00.",
    };
    expect(getAppliesWhenLabel(baseYearTaxEscalation)).toBe("Expense exceeds base year");

    const tenantCausedDamage = {
      expense_category: "roof_repair",
      expense_subcategory: "structural_roof",
      exact_source_text: "Landlord maintains the roof, foundation, exterior load-bearing walls, and structural framing, except for damage caused by Tenant's negligence.",
    };
    expect(getAppliesWhenLabel(tenantCausedDamage)).toBe("Tenant-caused damage");

    const noCondition = {
      expense_category: "utilities",
      expense_subcategory: "electricity",
      exact_source_text: "Tenant shall contract directly for and pay electricity charges.",
    };
    expect(getAppliesWhenLabel(noCondition)).toBe("Always");
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

  it("displays persisted V1 business semantics without inventing amounts", () => {
    const tax = {
      recovery_treatment: "pooled_recovery",
      cam_eligible: "yes",
      actual_expense_expected: "yes",
      amount_formula: "100% of Actual Cost",
      applies_when: "During lease term",
      approval_status: "approved",
      review_status: "approved",
    };
    const taxView = getSimplifiedRuleView(tax);
    expect(taxView.treatmentLabel).toBe("Pooled Recovery");
    expect(taxView.actualExpenseLabel).toBe("Yes");
    expect(getAmountFormulaLabel(tax)).toBe("100% of Actual Cost");

    const liability = {
      recovery_treatment: "compliance_only",
      actual_expense_expected: "no",
      coverage_requirement_amount: 1000000,
    };
    const liabilityView = getSimplifiedRuleView(liability);
    expect(liabilityView.treatmentLabel).toBe("Compliance Only");
    expect(liabilityView.camLabel).toBe("N/A");
    expect(liabilityView.actualExpenseLabel).toBe("No");
    expect(getAmountFormulaLabel(liability)).toBe("$1,000,000 Coverage Requirement");
  });

  it("shows Direct Bill and Tenant Direct outside CAM", () => {
    const lateCharge = {
      recovery_treatment: "direct_bill",
      actual_expense_expected: "no",
      amount_formula: "5% of overdue amount",
      applies_when: "Payment overdue",
    };
    expect(getSimplifiedRuleView(lateCharge).treatmentLabel).toBe("Direct Bill");
    expect(getSimplifiedRuleView(lateCharge).camLabel).toBe("N/A");
    expect(getAmountFormulaLabel(lateCharge)).toBe("5% of overdue amount");

    const utilities = {
      recovery_treatment: "tenant_direct",
      actual_expense_expected: "no",
      amount_formula: "Tenant pays vendor",
    };
    expect(getSimplifiedRuleView(utilities).treatmentLabel).toBe("Tenant Direct");
    expect(getSimplifiedRuleView(utilities).camLabel).toBe("N/A");
    expect(getAmountFormulaLabel(utilities)).toBe("Tenant pays vendor");
  });


  it("keeps CPI/index adjustment fields in the edit form contract", () => {
    const form = buildRuleEditForm({
      index_adjustment_applicable: true,
      index_adjustment_type: "cpi",
      index_name: "CPI-U",
      index_base_period: "base month",
      index_current_period: "current month",
      index_adjustment_percent: 3.25,
      index_floor_percent: 1,
      index_cap_percent: 5,
      index_adjustment_frequency: "annual",
      index_source: "reviewed index assumption",
    });

    expect(form.index_adjustment_applicable).toBe("yes");
    expect(form.index_adjustment_type).toBe("cpi");
    expect(form.index_name).toBe("CPI-U");
    expect(form.index_base_period).toBe("base month");
    expect(form.index_current_period).toBe("current month");
    expect(form.index_adjustment_percent).toBe("3.25");
    expect(form.index_floor_percent).toBe("1");
    expect(form.index_cap_percent).toBe("5");
    expect(form.index_adjustment_frequency).toBe("annual");
    expect(form.index_source).toBe("reviewed index assumption");
  });

  it("surfaces CPI/index adjustments as amount formula data", () => {
    expect(getAmountFormulaLabel({
      recovery_treatment: "pooled_recovery",
      index_adjustment_applicable: true,
      index_adjustment_type: "cpi",
      index_name: "CPI-U",
      index_adjustment_percent: 3.25,
    })).toBe("3.25% CPI-U Adjustment");

    expect(getAmountFormulaLabel({
      index_adjustment_applicable: true,
      index_adjustment_type: "cpi",
    })).toBe("CPI Adjustment Review");
  });
  it("uses one frozen contract status badge", () => {
    expect(getContractStatus({ approval_status: "approved", review_status: "approved" }).label).toBe("Approved");
    expect(getContractStatus({ approval_status: "rejected", review_status: "rejected" }).label).toBe("Rejected");
    expect(getContractStatus({ approval_status: "draft", review_status: "draft" }).label).toBe("Needs Review");
    expect(getContractStatus({ row_status: "superseded" }).label).toBe("Superseded");
  });
});

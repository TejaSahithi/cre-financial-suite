import { describe, expect, it } from "vitest";
import {
  LEASE_EXPENSE_RULE_GROUPS,
  inferLeaseExpenseRuleGroup,
  normalizeLeaseExpenseRule,
  splitRulesForLeaseReview,
} from "./leaseExpenseRuleTaxonomy";

const sourceRule = (overrides) => ({
  exact_source_text: "Tenant shall pay the charge described in this clause.",
  source_page: 4,
  confidence_score: 0.82,
  review_status: "needs_review",
  ...overrides,
});

describe("leaseExpenseRuleTaxonomy", () => {
  it("maps CAM, taxes, insurance, utilities, repairs, and exclusions", () => {
    expect(inferLeaseExpenseRuleGroup(sourceRule({ expense_category: "common_area_maintenance" })))
      .toBe(LEASE_EXPENSE_RULE_GROUPS.CAM_OPERATING_EXPENSES);
    expect(inferLeaseExpenseRuleGroup(sourceRule({ expense_category: "real_estate_taxes" })))
      .toBe(LEASE_EXPENSE_RULE_GROUPS.TAXES);
    expect(inferLeaseExpenseRuleGroup(sourceRule({ expense_category: "property_insurance" })))
      .toBe(LEASE_EXPENSE_RULE_GROUPS.INSURANCE);
    expect(inferLeaseExpenseRuleGroup(sourceRule({ expense_category: "electricity" })))
      .toBe(LEASE_EXPENSE_RULE_GROUPS.UTILITIES);
    expect(inferLeaseExpenseRuleGroup(sourceRule({ expense_category: "hvac_maintenance" })))
      .toBe(LEASE_EXPENSE_RULE_GROUPS.REPAIRS_MAINTENANCE);
    expect(inferLeaseExpenseRuleGroup(sourceRule({ expense_category: "capital_expenditures", is_excluded: true })))
      .toBe(LEASE_EXPENSE_RULE_GROUPS.EXCLUSIONS_NON_RECOVERABLE);
  });

  it("normalizes the rule shape while preserving DB-compatible fields", () => {
    const normalized = normalizeLeaseExpenseRule(sourceRule({
      id: "rule-1",
      rule_type: "pass_through",
      expense_category: "operating_expenses",
      operational_responsibility: "landlord",
      recoverable_from_tenant: "yes",
      exact_source_text: "Tenant shall reimburse Landlord for Operating Expenses.",
    }));

    expect(normalized.id).toBe("rule-1");
    expect(normalized.expense_category).toBe("operating_expenses");
    expect(normalized.rule_group).toBe(LEASE_EXPENSE_RULE_GROUPS.CAM_OPERATING_EXPENSES);
    expect(normalized.responsible_party).toBe("landlord");
    expect(normalized.recoverable).toBe(true);
    expect(normalized.source_text).toContain("Operating Expenses");
    expect(normalized.source_page).toBe(4);
    expect(normalized.confidence).toBe(0.82);
    expect(normalized.status).toBe("needs_review");
  });

  it("does not auto-accept mapped rules without source text", () => {
    const normalized = normalizeLeaseExpenseRule({
      expense_category: "utilities",
      row_status: "mapped",
      confidence_score: 0.9,
    });

    expect(normalized.source_text).toBeNull();
    expect(normalized.status).toBe("needs_review");
  });

  it("splits CAM/operating/recovery rules from non-CAM expense rules", () => {
    const { camRules, expenseRules } = splitRulesForLeaseReview([
      sourceRule({ id: "cam", expense_category: "operating_expenses" }),
      sourceRule({ id: "utility", expense_category: "electricity" }),
      sourceRule({ id: "tax", expense_category: "real_estate_taxes" }),
    ]);

    expect(camRules.map((rule) => rule.id)).toEqual(["cam"]);
    expect(expenseRules.map((rule) => rule.id)).toEqual(["utility", "tax"]);
  });
});

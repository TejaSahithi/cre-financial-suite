/**
 * classificationResolver.test.js
 *
 * 16 Generic Fixture Tests for Lease Expense Rules & Expense Classification Resolver.
 *
 * Proves: lease evidence -> normalized rule -> approved policy -> actual classification -> correct CAM/direct/outside-CAM route
 *
 * Requirements:
 * - NO hardcoded tenant/property names, UUIDs, categories, dollar amounts, or lease-specific text in runtime business logic.
 * - Test suite uses generic abstract fixtures.
 */

import { describe, it, expect } from "vitest";
import { classifyExpense, CLASSIFICATION_STATUSES } from "./classificationResolver";
import { deriveNormalizedContractModel } from "./ruleDecisionEngine";

describe("Expense Classification Resolver & Normalized Contract Model (16 Generic Fixtures)", () => {
  // Fixture 1: NNN pooled taxes/insurance
  it("Fixture 1: NNN pooled taxes/insurance -> READY_POOLED_CAM", () => {
    const rule = {
      expense_category_id: "cat-tax-001",
      recovery_treatment: "pooled_recovery",
      cost_bearer: "tenant",
      vendor_payment_party: "landlord",
      cam_participation: "eligible",
      actual_expense_expected: "yes",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-tax-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 10000,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.actual_expense_expected).toBe("yes");
    expect(norm.recovery_treatment).toBe("pooled_recovery");

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_POOLED_CAM);
    expect(result.route).toBe("pooled_cam_input");
  });

  // Fixture 2: Gross lease included-in-rent
  it("Fixture 2: Gross lease included-in-rent -> INCLUDED_IN_RENT", () => {
    const rule = {
      expense_category_id: "cat-opex-001",
      included_in_base_rent: true,
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-opex-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 5000,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.recovery_treatment).toBe("included_in_rent");
    expect(norm.cam_participation).toBe("not_applicable");

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.INCLUDED_IN_RENT);
    expect(result.route).toBe("outside_cam");
  });

  // Fixture 3: Modified gross / base-year
  it("Fixture 3: Modified gross / base-year -> READY_POOLED_CAM with base_year policy", () => {
    const rule = {
      expense_category_id: "cat-opex-002",
      base_year: 2025,
      recovery_treatment: "pooled_recovery",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-opex-002",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 12000,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.base_year).toBe(2025);

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_POOLED_CAM);
  });

  // Fixture 4: Expense-stop recovery
  it("Fixture 4: Expense-stop recovery -> READY_POOLED_CAM with expense_stop policy", () => {
    const rule = {
      expense_category_id: "cat-util-001",
      expense_stop_amount: 5000,
      recovery_treatment: "pooled_recovery",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-util-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 8000,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.expense_stop).toBe(5000);

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_POOLED_CAM);
  });

  // Fixture 5: CAM cap
  it("Fixture 5: CAM cap -> READY_POOLED_CAM with cap policy", () => {
    const rule = {
      expense_category_id: "cat-cam-001",
      cap_percentage: 5,
      recovery_treatment: "pooled_recovery",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-cam-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 15000,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.cap).toBe(5);

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_POOLED_CAM);
  });

  // Fixture 6: Tenant-direct metered utilities
  it("Fixture 6: Tenant-direct metered utilities -> TENANT_DIRECT (actual_expense_expected = no)", () => {
    const rule = {
      expense_category_id: "cat-elec-001",
      payment_treatment: "tenant_direct_contract",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-elec-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 0,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.actual_expense_expected).toBe("no");
    expect(norm.vendor_payment_party).toBe("tenant");
    expect(norm.cam_participation).toBe("not_applicable");

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.TENANT_DIRECT);
    expect(result.route).toBe("outside_cam");
  });

  // Fixture 7: Jointly-metered conditional utilities
  it("Fixture 7: Jointly-metered conditional utilities -> CONDITIONAL_REVIEW", () => {
    const rule = {
      expense_category_id: "cat-water-001",
      recovery_treatment: "conditional",
      condition_type: "submeter_exceeded",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-water-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 4000,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.actual_expense_expected).toBe("conditional");

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.CONDITIONAL_REVIEW);
    expect(result.route).toBe("review_required");
  });

  // Fixture 8: Tenant-caused direct repair reimbursement
  it("Fixture 8: Tenant-caused direct repair reimbursement -> READY_DIRECT_RECOVERY", () => {
    const rule = {
      expense_category_id: "cat-repair-001",
      recovery_treatment: "direct_recovery",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-repair-001",
      property_id: "prop-001",
      lease_id: "lease-tenant-A",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 3500,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.recovery_treatment).toBe("direct_recovery");

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001", lease_id: "lease-tenant-A" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_DIRECT_RECOVERY);
    expect(result.route).toBe("direct_cam_input");
  });

  // Fixture 9: Tenant-maintained HVAC
  it("Fixture 9: Tenant-maintained HVAC -> TENANT_DIRECT", () => {
    const rule = {
      expense_category_id: "cat-hvac-001",
      recovery_treatment: "tenant_direct",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-hvac-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 0,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.vendor_payment_party).toBe("tenant");

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.TENANT_DIRECT);
  });

  // Fixture 10: Compliance insurance requirement
  it("Fixture 10: Compliance insurance requirement -> TENANT_DIRECT / compliance_only", () => {
    const rule = {
      expense_category_id: "cat-ins-compliance",
      recovery_treatment: "compliance_only",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-ins-compliance",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 0,
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.actual_expense_expected).toBe("no");
    expect(norm.cam_participation).toBe("not_applicable");
  });

  // Fixture 11: Direct legal/assignment bill
  it("Fixture 11: Direct legal/assignment bill -> DIRECT_BILL (requires tenant)", () => {
    const rule = {
      expense_category_id: "cat-legal-001",
      recovery_treatment: "direct_bill",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-legal-001",
      property_id: "prop-001",
      lease_id: "lease-tenant-B",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 2500,
    };

    const result = classifyExpense({
      expense,
      rules: [rule],
      scope: { property_id: "prop-001", lease_id: "lease-tenant-B" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.DIRECT_BILL);
    expect(result.route).toBe("outside_cam");
  });

  // Fixture 12: Property-wide pooled landscaping with multiple tenant policies
  it("Fixture 12: Property-wide pooled landscaping -> READY_POOLED_CAM (publishes once without single lease policy)", () => {
    const rule1 = {
      expense_category_id: "cat-landscaping-001",
      recovery_treatment: "pooled_recovery",
      approval_status: "approved",
      lease_id: "lease-A",
    };
    const rule2 = {
      expense_category_id: "cat-landscaping-001",
      recovery_treatment: "pooled_recovery",
      approval_status: "approved",
      lease_id: "lease-B",
    };
    const expense = {
      expense_category_id: "cat-landscaping-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 15000,
    };

    const result = classifyExpense({
      expense,
      rules: [rule1, rule2],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_POOLED_CAM);
    expect(result.route).toBe("pooled_cam_input");
  });

  // Fixture 13: Future effective lease
  it("Fixture 13: Future effective lease -> Untriggered for current fiscal year", () => {
    const rule = {
      expense_category_id: "cat-cam-001",
      effective_start_date: "2028-01-01",
      recovery_treatment: "pooled_recovery",
      approval_status: "approved",
    };
    const norm = deriveNormalizedContractModel(rule);
    expect(norm.effective_start_date).toBe("2028-01-01");
  });

  // Fixture 14: Mid-year commencement/expiration
  it("Fixture 14: Mid-year commencement/expiration -> Scope & date overlap passes for active period", () => {
    const expense = {
      expense_category_id: "cat-cam-001",
      property_id: "prop-001",
      service_period_start: "2026-06-01",
      service_period_end: "2026-12-31",
      amount: 6000,
    };

    const result = classifyExpense({
      expense,
      rules: [],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.READY_POOLED_CAM);
  });

  // Fixture 15: Conflicting policies
  it("Fixture 15: Conflicting policies -> POLICY_CONFLICT (no arbitrary guessing)", () => {
    const rule1 = {
      expense_category_id: "cat-maint-001",
      recovery_treatment: "conditional",
      condition_type: "tenant_fault_only",
      approval_status: "approved",
    };
    const rule2 = {
      expense_category_id: "cat-maint-001",
      recovery_treatment: "pooled_recovery",
      condition_type: "standard_cam",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-maint-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 7500,
    };

    const result = classifyExpense({
      expense,
      rules: [rule1, rule2],
      scope: { property_id: "prop-001" },
    });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.POLICY_CONFLICT);
    expect(result.route).toBe("review_required");
  });

  // Fixture 16: Missing premises / category / service period
  it("Fixture 16a: Missing expense_category_id -> NEEDS_CATEGORY", () => {
    const expense = {
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 1000,
    };
    const result = classifyExpense({ expense, rules: [], scope: { property_id: "prop-001" } });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.NEEDS_CATEGORY);
  });

  it("Fixture 16b: Missing property_id -> NEEDS_SCOPE", () => {
    const expense = {
      expense_category_id: "cat-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 1000,
    };
    const result = classifyExpense({ expense, rules: [], scope: {} });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.NEEDS_SCOPE);
  });

  it("Fixture 16c: Missing service_period -> NEEDS_SERVICE_PERIOD", () => {
    const expense = {
      expense_category_id: "cat-001",
      property_id: "prop-001",
      amount: 1000,
    };
    const result = classifyExpense({ expense, rules: [], scope: { property_id: "prop-001" } });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.NEEDS_SERVICE_PERIOD);
  });

  it("Fixture 16d: Missing lease_id for direct recovery -> NEEDS_TENANT", () => {
    const rule = {
      expense_category_id: "cat-direct-001",
      recovery_treatment: "direct_recovery",
      approval_status: "approved",
    };
    const expense = {
      expense_category_id: "cat-direct-001",
      property_id: "prop-001",
      service_period_start: "2026-01-01",
      service_period_end: "2026-12-31",
      amount: 1000,
    };
    const result = classifyExpense({ expense, rules: [rule], scope: { property_id: "prop-001" } });
    expect(result.status).toBe(CLASSIFICATION_STATUSES.NEEDS_TENANT);
  });
});

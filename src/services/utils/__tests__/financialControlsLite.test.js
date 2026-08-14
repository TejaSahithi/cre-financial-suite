import { describe, expect, it } from "vitest";
import {
  deriveRecurringExpectations,
  evaluateFinancialControlsLite,
  normalizeControlCategory,
} from "../financialControlsLite";

describe("financialControlsLite", () => {
  it("normalizes categories without hardcoded labels", () => {
    expect(normalizeControlCategory("Snow Removal / Ice")).toBe("snow_removal_ice");
  });

  it("flags over-budget and unbudgeted categories from data", () => {
    const result = evaluateFinancialControlsLite({
      fiscalYear: 2026,
      budgets: [{ budget_year: 2026, expense_items: [{ category: "snow", amount: 100 }] }],
      expenses: [
        { date: "2026-01-01", category: "snow", amount: 160, status: "approved" },
        { date: "2026-01-01", category: "security", amount: 50, status: "approved" },
      ],
      varianceThresholdPercent: 25,
    });

    expect(result.summary.overBudgetCount).toBe(1);
    expect(result.summary.unbudgetedCount).toBe(1);
    expect(result.controls.overBudget[0].category).toBe("snow");
    expect(result.controls.unbudgetedExpenses[0].category).toBe("security");
  });

  it("derives expected recurring invoices from approved rule frequency", () => {
    const expectations = deriveRecurringExpectations({
      fiscalYear: 2026,
      expenseRules: [{ expense_category: "electric", frequency: "monthly" }],
      expenses: [],
    });

    expect(expectations).toEqual([{
      category: "electric",
      expectedCount: 12,
      source: "approved_lease_expense_rule",
    }]);
  });
});

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateFinancialControls } from "../_shared/financial-controls/financial-controls-engine.ts";

Deno.test("financial controls flag categories above budget threshold", () => {
  const result = evaluateFinancialControls({
    fiscalYear: 2026,
    varianceThresholdPercent: 10,
    budgets: [{ fiscal_year: 2026, line_items: [{ category: "Utilities", amount: 1000 }] }],
    expenses: [{ date: "2026-03-01", category: "utilities", amount: 1250, status: "approved" }],
  });

  assertEquals(result.status, "needs_review");
  assertEquals(result.exceptions[0].code, "CATEGORY_OVER_BUDGET");
  assertEquals(result.exceptions[0].variancePercent, 25);
});

Deno.test("financial controls flag approved unbudgeted expenses", () => {
  const result = evaluateFinancialControls({
    fiscalYear: 2026,
    budgets: [],
    expenses: [{ expense_date: "2026-04-01", expense_subcategory: "Snow Removal", amount: 300, status: "posted" }],
  });

  assertEquals(result.status, "needs_review");
  assertEquals(result.exceptions[0].code, "UNBUDGETED_EXPENSE");
  assertEquals(result.exceptions[0].category, "snow_removal");
});

Deno.test("financial controls ignore draft expenses", () => {
  const result = evaluateFinancialControls({
    fiscalYear: 2026,
    budgets: [],
    expenses: [{ date: "2026-04-01", category: "Snow Removal", amount: 300, status: "draft" }],
  });

  assertEquals(result.status, "clear");
  assertEquals(result.exceptions, []);
});

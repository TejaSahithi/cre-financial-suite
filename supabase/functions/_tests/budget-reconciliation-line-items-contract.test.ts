// @ts-nocheck
/**
 * PR-1: Budget -> Reconciliation `line_items` data-contract fix.
 *
 * compute-budget writes `outputs.line_items` as a plain object
 * ({ schema_version, revenue, expenses, noi }). compute-reconciliation
 * previously assumed an array and did `for (const item of ...)`, which
 * throws `TypeError: ... is not iterable` on every real budget snapshot.
 *
 * These tests exercise the real shared parser
 * (_shared/budget-snapshot-parser.ts) that both edge functions now use,
 * not a reimplementation, so a regression in the actual contract logic
 * fails these tests directly.
 */

import { assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  BUDGET_LINE_ITEMS_SCHEMA_VERSION,
  parseBudgetLineItemsByCategory,
} from "../_shared/budget-snapshot-parser.ts";

// ---------------------------------------------------------------------------
// Helper: builds the exact outputs.line_items shape compute-budget writes.
// ---------------------------------------------------------------------------
function budgetOutputs(overrides: Record<string, any> = {}) {
  return {
    budget_id: "budget-1",
    status: "draft",
    line_items: {
      schema_version: BUDGET_LINE_ITEMS_SCHEMA_VERSION,
      revenue: { base_rent: 100000, cam_recovery: 5000, other_income: 1000, total: 106000 },
      expenses: { utilities: 8000, maintenance: 4000, insurance: 2000, taxes: 6000, management: 3000, other: 500, total: 23500 },
      noi: 82500,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. Normal case: real compute-budget shape parses without throwing.
// ---------------------------------------------------------------------------
Deno.test("Normal case: current compute-budget object shape parses to expense category totals", () => {
  const byCategory = parseBudgetLineItemsByCategory(budgetOutputs());
  assertEquals(byCategory, {
    utilities: 8000,
    maintenance: 4000,
    insurance: 2000,
    taxes: 6000,
    management: 3000,
    other: 500,
  });
  // "total" is a rollup key, not a category — must be excluded so it doesn't
  // get compared against actuals as if it were its own category.
  assertEquals("total" in byCategory, false);
});

// ---------------------------------------------------------------------------
// 2. Zero / empty categories.
// ---------------------------------------------------------------------------
Deno.test("Zero/null: empty expenses object produces an empty map, not a crash", () => {
  const byCategory = parseBudgetLineItemsByCategory(
    budgetOutputs({
      line_items: {
        schema_version: BUDGET_LINE_ITEMS_SCHEMA_VERSION,
        revenue: {},
        expenses: {},
        noi: 0,
      },
    }),
  );
  assertEquals(byCategory, {});
});

Deno.test("Zero/null: missing line_items entirely returns an empty map", () => {
  const byCategory = parseBudgetLineItemsByCategory({ budget_id: "budget-1", status: "draft" });
  assertEquals(byCategory, {});
});

Deno.test("Zero/null: non-finite/undefined category amounts coerce to 0 instead of NaN", () => {
  const byCategory = parseBudgetLineItemsByCategory(
    budgetOutputs({
      line_items: {
        schema_version: BUDGET_LINE_ITEMS_SCHEMA_VERSION,
        revenue: {},
        expenses: { utilities: undefined, maintenance: null, insurance: "not-a-number" },
        noi: 0,
      },
    }),
  );
  assertEquals(byCategory, { utilities: 0, maintenance: 0, insurance: 0 });
});

// ---------------------------------------------------------------------------
// 3. Missing schema_version (pre-fix / legacy snapshot): validated then
//    treated as the known object shape.
// ---------------------------------------------------------------------------
Deno.test("Legacy: snapshot with no schema_version but a valid object shape still parses", () => {
  const byCategory = parseBudgetLineItemsByCategory(
    budgetOutputs({
      line_items: {
        // no schema_version key at all
        revenue: { base_rent: 1000, total: 1000 },
        expenses: { utilities: 500, total: 500 },
        noi: 500,
      },
    }),
  );
  assertEquals(byCategory, { utilities: 500 });
});

Deno.test("Legacy fallback: outputs.by_category (pre-line_items producer) is honored when line_items is absent", () => {
  const byCategory = parseBudgetLineItemsByCategory({
    budget_id: "budget-1",
    status: "draft",
    by_category: { utilities: 700, maintenance: 300 },
  });
  assertEquals(byCategory, { utilities: 700, maintenance: 300 });
});

// ---------------------------------------------------------------------------
// 4. Malformed / unknown shape: fail closed, never silently compute.
// ---------------------------------------------------------------------------
Deno.test("Malformed: pre-fix array shape (never actually produced, but defended against) throws", () => {
  assertThrows(
    () =>
      parseBudgetLineItemsByCategory({
        line_items: [{ category: "utilities", amount: 500 }],
      }),
    Error,
    "Unsupported budget snapshot line_items shape",
  );
});

Deno.test("Malformed: line_items.expenses missing entirely throws instead of returning wrong totals", () => {
  assertThrows(
    () =>
      parseBudgetLineItemsByCategory({
        line_items: { schema_version: BUDGET_LINE_ITEMS_SCHEMA_VERSION, revenue: { total: 100 }, noi: 100 },
      }),
    Error,
    "line_items.expenses is missing or malformed",
  );
});

Deno.test("Unknown schema_version: fails closed with a clear domain error, does not guess", () => {
  assertThrows(
    () =>
      parseBudgetLineItemsByCategory(
        budgetOutputs({
          line_items: {
            schema_version: "budget_line_items.v2-does-not-exist",
            revenue: { total: 100 },
            expenses: { utilities: 50, total: 50 },
            noi: 50,
          },
        }),
      ),
    Error,
    'Unrecognized budget line_items schema_version "budget_line_items.v2-does-not-exist"',
  );
});

// ---------------------------------------------------------------------------
// 5. Idempotency: parsing the same snapshot twice yields identical output.
// ---------------------------------------------------------------------------
Deno.test("Idempotent: parsing the same snapshot object twice yields identical results", () => {
  const outputs = budgetOutputs();
  const first = parseBudgetLineItemsByCategory(outputs);
  const second = parseBudgetLineItemsByCategory(outputs);
  assertEquals(first, second);
});

// ---------------------------------------------------------------------------
// 6. Regression guard: revenue categories must NOT leak into the expense
//    category map (that would introduce new false "flagged variance" noise
//    for categories actuals/expenses rows never populate).
// ---------------------------------------------------------------------------
Deno.test("Revenue categories are excluded from the expense category map", () => {
  const byCategory = parseBudgetLineItemsByCategory(budgetOutputs());
  assertEquals("base_rent" in byCategory, false);
  assertEquals("cam_recovery" in byCategory, false);
  assertEquals("other_income" in byCategory, false);
});

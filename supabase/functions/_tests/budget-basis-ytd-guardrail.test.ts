// @ts-nocheck
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildBudgetBasisSnapshot } from "../_shared/budget-basis.ts";

/**
 * Regression coverage for the YTD-projection guardrail: a category with only
 * 1-2 months of current-year approved actuals must NOT be annualized (x12)
 * into the budget basis — that's how a single $100k lump-sum entry became a
 * $1.2M/year "basis" with no signal it was low-confidence. Fewer than
 * MIN_MONTHS_FOR_YTD_PROJECTION (3) months must fall through to the next
 * rung instead.
 */

function fakeClient(expenseRows) {
  function builder(table) {
    const b = {
      select() { return b; },
      eq() { return b; },
      in() { return b; },
      order() { return b; },
      limit() { return b; },
      maybeSingle() {
        if (table === "expense_categories") {
          return Promise.resolve({ data: { category_name: "Insurance", normalized_key: "insurance" }, error: null });
        }
        // budgets (existing approved/locked) and computation_snapshots (prior basis) — none exist
        return Promise.resolve({ data: null, error: null });
      },
      then(resolve, reject) {
        if (table === "expenses") {
          return Promise.resolve({ data: expenseRows, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: [], error: null }).then(resolve, reject);
      },
    };
    return b;
  }
  return {
    from(table) { return builder(table); },
    rpc(name) {
      if (name === "resolve_expense_category_id") {
        return Promise.resolve({ data: { expense_category_id: "cat-insurance", unresolved_reason: null }, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

function approvedRow(amount, date) {
  return { id: crypto.randomUUID(), category: "Insurance", amount, date, approval_status: "approved", approved_status: "approved", building_id: null };
}

Deno.test("Budget basis: 1 month of YTD actuals is too thin to annualize — falls through to no_data instead of a 12x guess", async () => {
  const client = fakeClient([approvedRow(100000, "2026-01-15")]);
  const { snapshotOutputs } = await buildBudgetBasisSnapshot(client, {
    orgId: "org-1", propertyId: "11111111-1111-1111-1111-111111111111",
    scope: { scope_level: "property", scope_id: "11111111-1111-1111-1111-111111111111" },
    fiscalYear: 2027, actorUserId: "user-1",
  });
  const line = snapshotOutputs.categories.find((c) => c.category_label === "Insurance");
  assertEquals(line.baseline_type, "no_data");
  assertEquals(line.annual_budget, 0);
});

Deno.test("Budget basis: 3+ months of YTD actuals is trusted and projected to a full-year run rate", async () => {
  const client = fakeClient([
    approvedRow(10000, "2026-01-10"),
    approvedRow(10000, "2026-02-10"),
    approvedRow(10000, "2026-03-10"),
  ]);
  const { snapshotOutputs } = await buildBudgetBasisSnapshot(client, {
    orgId: "org-1", propertyId: "11111111-1111-1111-1111-111111111111",
    scope: { scope_level: "property", scope_id: "11111111-1111-1111-1111-111111111111" },
    fiscalYear: 2027, actorUserId: "user-1",
  });
  const line = snapshotOutputs.categories.find((c) => c.category_label === "Insurance");
  assertEquals(line.baseline_type, "current_year_ytd_projected");
  assertEquals(line.annual_budget, 120000); // 30000 YTD / 3 months * 12
});

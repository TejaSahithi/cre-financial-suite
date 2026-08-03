// @ts-nocheck
/**
 * Shared, side-effect-free parser for compute-budget's
 * `computation_snapshots.outputs.line_items` contract.
 *
 * compute-budget writes line_items as a plain object:
 *   { schema_version, revenue: {...categories}, expenses: {...categories}, noi }
 * — never an array. compute-reconciliation previously assumed an array shape
 * and threw on every run against a real budget snapshot. This module is the
 * single place that understands the object shape, so both the edge function
 * and its tests read the same logic instead of a reimplementation that could
 * drift from it.
 */

/**
 * Bump this — and add a matching parser branch below — any time the
 * line_items object shape changes. Never repurpose an existing version
 * string for an incompatible shape: unknown versions are rejected rather
 * than guessed at, because a plausible-but-wrong financial total is worse
 * than a visible error.
 */
export const BUDGET_LINE_ITEMS_SCHEMA_VERSION = "budget_line_items.v1";

export interface BudgetCategoryTotals {
  [category: string]: number;
}

/**
 * Extracts an expense-category -> amount map from a compute-budget
 * snapshot's `outputs`, for comparison against actuals/expenses category
 * totals (which are themselves expense-side facts — see
 * compute-reconciliation's actualsByCategory). Revenue variance is handled
 * separately via budget.total_revenue vs. actual revenue and is
 * intentionally not folded into this per-category map.
 *
 * Throws for any line_items shape this parser doesn't recognize, rather
 * than silently falling back to a best-effort guess.
 */
export function parseBudgetLineItemsByCategory(outputs: any): BudgetCategoryTotals {
  const lineItems = outputs?.line_items;

  if (lineItems == null) {
    // Legacy fallback: a historical producer may have written a flat
    // by_category map directly on outputs instead of line_items.
    const byCategory = outputs?.by_category;
    if (byCategory != null && typeof byCategory === "object" && !Array.isArray(byCategory)) {
      const result: BudgetCategoryTotals = {};
      for (const [category, amount] of Object.entries(byCategory)) {
        result[category] = Number(amount) || 0;
      }
      return result;
    }
    return {};
  }

  if (typeof lineItems !== "object" || Array.isArray(lineItems)) {
    throw new Error(
      `Unsupported budget snapshot line_items shape (expected an object, got ` +
        `${Array.isArray(lineItems) ? "array" : typeof lineItems}). Refusing to compute ` +
        `reconciliation against an unrecognized budget snapshot.`,
    );
  }

  const schemaVersion = lineItems.schema_version;

  if (
    schemaVersion !== undefined &&
    schemaVersion !== null &&
    schemaVersion !== BUDGET_LINE_ITEMS_SCHEMA_VERSION
  ) {
    throw new Error(
      `Unrecognized budget line_items schema_version "${schemaVersion}" (expected ` +
        `"${BUDGET_LINE_ITEMS_SCHEMA_VERSION}" or no version marker on a legacy snapshot). ` +
        `Refusing to compute reconciliation against an unknown budget snapshot shape.`,
    );
  }

  // schemaVersion is either the known version or absent (pre-fix snapshot).
  // Either way, validate the shape actually looks like what's expected
  // before trusting it — a missing schema_version is not itself proof the
  // object is well-formed.
  const expenses = lineItems.expenses;
  if (expenses == null || typeof expenses !== "object" || Array.isArray(expenses)) {
    throw new Error(
      "Budget snapshot line_items.expenses is missing or malformed — cannot compute reconciliation.",
    );
  }

  const byCategory: BudgetCategoryTotals = {};
  for (const [category, amount] of Object.entries(expenses)) {
    if (category === "total") continue;
    byCategory[category] = Number(amount) || 0;
  }
  return byCategory;
}

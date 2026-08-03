// @ts-nocheck
/**
 * Canonical, fail-closed budget row resolution.
 *
 * Problem this replaces: export-data, compute-budget's approve/reject/
 * mark_reviewed/lock actions, and several frontend pages used to locate a
 * budget row via `.eq("property_id", X).eq("budget_year", Y)` alone,
 * sometimes with `.order(...).limit(1)` or `.maybeSingle()` layered on top.
 * That was safe back when every budget was property-scoped and unique per
 * (org, property, year) — the OLD schema's actual guarantee. Once
 * building/unit-scoped budgets could coexist with a property's own budget
 * for the same year (the budget scope/period PR), that filter could match
 * MULTIPLE rows, and `.order(...).limit(1)`/`.maybeSingle()` would silently
 * return an ARBITRARY one of them instead of erroring — a confused-deputy
 * bug where an action intended for one budget (e.g. approve a building
 * budget) could silently act on a different one (e.g. the property budget)
 * sharing the same property_id and year.
 *
 * budget_id is now the primary identifier for every command that acts on an
 * EXISTING budget (approve/reject/mark_reviewed/lock/export/download/
 * email). Every resolution path here queries by a column set that is
 * either a primary key (id) or a database-enforced UNIQUE constraint
 * (org_id, scope, scope_id, budget_year — see
 * 20260903000000_budget_scope_columns.sql) — never property_id/budget_year
 * alone — so `.maybeSingle()` here can never silently pick one of several
 * matching rows; it can only return "the" row or none. Not found, wrong
 * org, or a mismatched caller-supplied hint all throw rather than falling
 * back to a different row.
 */

import { assertValidBudgetScopeHierarchy } from "./budget-scope.ts";

export interface ResolvedBudget {
  id: string;
  org_id: string;
  scope: string;
  scope_id: string;
  budget_year: number;
  portfolio_id: string | null;
  property_id: string | null;
  building_id: string | null;
  unit_id: string | null;
  status: string;
  name: string;
  total_revenue: number;
  total_expenses: number;
  cam_total: number;
  noi: number;
  ai_insights: string | null;
  generation_method: string | null;
  period: string;
  [key: string]: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function toFiniteYear(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Resolves and returns exactly one budget row, or throws.
 *
 * Accepts two request shapes:
 *   1. `{ budget_id }` — the primary, preferred path. Any additionally
 *      supplied `scope` / `scope_id` / `property_id` / `budget_year` /
 *      `fiscal_year` is treated as a caller assertion, not a filter: if it
 *      disagrees with the resolved row, the request is rejected rather
 *      than silently honoring budget_id over a stale/incorrect hint.
 *   2. No `budget_id`: the full canonical identity `{ scope, scope_id,
 *      budget_year }`, OR the legacy shorthand `{ property_id, budget_year
 *      }` which resolves to scope="property", scope_id=property_id (task
 *      requirement: preserve legacy property-budget compatibility — every
 *      pre-existing row was backfilled to exactly this shape).
 *
 * `budget_year` and `fiscal_year` are accepted as synonyms throughout this
 * codebase's budget consumers; both are read here.
 *
 * By default, also re-validates that the resolved row's stored hierarchy
 * (property/building/unit/portfolio ids) is STILL a valid, org-owned
 * relationship — not just trusting historical ids on the row — via the same
 * assertValidBudgetScopeHierarchy used at budget-creation time. Pass
 * `{ revalidateHierarchy: false }` to skip this for call sites that only
 * need identity resolution, not a fresh ownership proof (none currently do;
 * the option exists so a future read-only, high-volume caller isn't forced
 * into the extra round trip).
 */
export async function resolveBudgetIdentity(
  supabaseAdmin: any,
  orgId: string,
  input: {
    budget_id?: unknown;
    scope?: unknown;
    scope_id?: unknown;
    property_id?: unknown;
    budget_year?: unknown;
    fiscal_year?: unknown;
  },
  options: { revalidateHierarchy?: boolean } = {},
): Promise<ResolvedBudget> {
  const budgetId = isNonEmptyString(input.budget_id) ? input.budget_id : null;
  const revalidateHierarchy = options.revalidateHierarchy !== false;

  let row: ResolvedBudget;

  if (budgetId) {
    const { data, error } = await supabaseAdmin
      .from("budgets")
      .select("*")
      .eq("id", budgetId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Budget lookup failed: ${error.message}`);
    if (!data) {
      throw new Error(`Budget ${budgetId} was not found in organization ${orgId}`);
    }

    const suppliedScope = typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : undefined;
    if (suppliedScope && suppliedScope !== data.scope) {
      throw new Error(
        `Budget ${budgetId} has scope "${data.scope}", but the request specified scope "${suppliedScope}" — refusing a mismatched request.`,
      );
    }
    const suppliedScopeId = isNonEmptyString(input.scope_id) ? input.scope_id : undefined;
    if (suppliedScopeId && suppliedScopeId !== data.scope_id) {
      throw new Error(
        `Budget ${budgetId} has scope_id "${data.scope_id}", but the request specified scope_id "${suppliedScopeId}" — refusing a mismatched request.`,
      );
    }
    const suppliedPropertyId = isNonEmptyString(input.property_id) ? input.property_id : undefined;
    if (suppliedPropertyId && data.property_id && suppliedPropertyId !== data.property_id) {
      throw new Error(
        `Budget ${budgetId} belongs to property_id "${data.property_id}", but the request specified property_id "${suppliedPropertyId}" — refusing a mismatched request.`,
      );
    }
    const suppliedYear = toFiniteYear(input.budget_year) ?? toFiniteYear(input.fiscal_year);
    if (suppliedYear !== undefined && suppliedYear !== data.budget_year) {
      throw new Error(
        `Budget ${budgetId} has budget_year ${data.budget_year}, but the request specified ${suppliedYear} — refusing a mismatched request.`,
      );
    }

    row = data;
  } else {
    const budgetYear = toFiniteYear(input.budget_year) ?? toFiniteYear(input.fiscal_year);
    if (budgetYear === undefined) {
      throw new Error(
        "budget_id, or budget_year/fiscal_year (with scope+scope_id, or a legacy property_id), is required to locate a budget",
      );
    }

    let scope = typeof input.scope === "string" && input.scope.trim() ? input.scope.trim() : undefined;
    let scopeId = isNonEmptyString(input.scope_id) ? input.scope_id : undefined;

    if (!scope && isNonEmptyString(input.property_id)) {
      // Legacy compatibility: bare property_id resolves to scope="property",
      // scope_id=property_id — the exact shape the budget scope/period
      // migration backfilled every pre-existing row to.
      scope = "property";
      scopeId = input.property_id;
    }

    if (!scope || !scopeId) {
      throw new Error(
        'Either budget_id, or the full canonical identity (scope + scope_id + budget_year), is required. ' +
        'A bare property_id is only accepted as legacy shorthand for scope="property".',
      );
    }

    const { data, error } = await supabaseAdmin
      .from("budgets")
      .select("*")
      .eq("org_id", orgId)
      .eq("scope", scope)
      .eq("scope_id", scopeId)
      .eq("budget_year", budgetYear)
      .maybeSingle();
    if (error) throw new Error(`Budget lookup failed: ${error.message}`);
    if (!data) {
      throw new Error(`No budget found for scope="${scope}" scope_id="${scopeId}" budget_year=${budgetYear} in organization ${orgId}`);
    }
    row = data;
  }

  if (revalidateHierarchy && row.scope !== "portfolio") {
    // Portfolio scope is skipped: portfolio-budget generation is not yet
    // supported (see the budget scope/period PR's compute-budget
    // handleGenerate), so no portfolio-scoped row can exist today, and
    // this check is about re-proving CURRENT hierarchy ownership, not
    // identity — a stale/moved building or a property reassigned to a
    // different portfolio since the budget was generated must still be
    // caught here.
    await assertValidBudgetScopeHierarchy(supabaseAdmin, orgId, {
      scope: row.scope,
      portfolio_id: row.portfolio_id,
      property_id: row.property_id,
      building_id: row.building_id,
      unit_id: row.unit_id,
    });
  }

  return row as ResolvedBudget;
}

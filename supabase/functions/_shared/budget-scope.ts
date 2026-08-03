// @ts-nocheck
/**
 * Canonical budget scope + period contract.
 *
 * Deliberately a SEPARATE module from _shared/scope.ts, not an extension of
 * it. _shared/scope.ts's ScopeLevel ("property" | "building" | "unit") and
 * assertValidScopeHierarchy are used by compute-cam and (via
 * normalizeScopeSelection in _shared/rent-schedule.ts) compute-lease — both
 * untouched by this PR. Adding "portfolio" to that shared enum would make
 * it structurally valid for CAM/lease callers too, but neither has a
 * portfolio-handling branch in assertValidScopeHierarchy, so an
 * out-of-hierarchy "portfolio" scope_level would silently fall through to
 * the unit-lookup branch there — a real bug, not a hypothetical one. Budget
 * gets its own four-level model instead; the two modules intentionally do
 * not share code, only the same DB-column shape
 * (scope_level/scope_id/property_id on computation_snapshots).
 *
 * ── Scope contract ─────────────────────────────────────────────────────
 * BudgetScopeLevel: "portfolio" | "property" | "building" | "unit"
 *
 *   portfolio  requires portfolio_id.
 *              forbids property_id, building_id, unit_id.
 *   property   requires property_id.
 *              forbids building_id, unit_id.
 *              portfolio_id, if given, must match the property's own
 *              portfolio_id (not required as input — inherited).
 *   building   requires property_id AND building_id.
 *              forbids unit_id.
 *   unit       requires property_id AND unit_id.
 *              building_id is NOT required as input, unlike the task's
 *              illustrative example — units.building_id is nullable in
 *              this schema (a unit may attach directly to a property with
 *              no building), so requiring it would reject legitimate
 *              units. This mirrors _shared/scope.ts's assertValidScopeHierarchy,
 *              which makes the identical call for CAM's "unit" scope. When
 *              the resolved unit does have a building_id, it is persisted
 *              on the budget row for filtering/display; when it doesn't,
 *              building_id stays null.
 *
 * All hierarchy relationships (building belongs to property+org, unit
 * belongs to property+org, property belongs to portfolio+org if a
 * portfolio was given) are validated server-side against the admin client
 * — never trusted from the request body alone, matching
 * assertValidScopeHierarchy's posture for CAM.
 *
 * ── Period contract ─────────────────────────────────────────────────────
 * compute-budget's calculation (handleGenerate) produces exactly one
 * annual aggregate — there is no monthly/quarterly breakdown logic
 * anywhere in it, unlike compute-revenue/compute-expense/compute-
 * reconciliation which at least compute a monthly_breakdown as internal
 * output detail. The CreateBudget.jsx UI offers "Quarterly"/"Monthly" as
 * period options today, but nothing server-side can correctly produce
 * either — selecting them has silently done nothing but get discarded
 * before this PR (see the workflow trace in this PR's report). Per this
 * review's explicit instruction not to claim support the calculator can't
 * deliver, "annual" remains the only accepted period value; anything else
 * is rejected with a clear, fail-closed error rather than silently
 * coerced to annual.
 */

export type BudgetScopeLevel = "portfolio" | "property" | "building" | "unit";

export const BUDGET_SCOPE_LEVELS: BudgetScopeLevel[] = ["portfolio", "property", "building", "unit"];

export const SUPPORTED_BUDGET_PERIODS = ["annual"] as const;

export interface ResolvedBudgetScope {
  scope: BudgetScopeLevel;
  scope_id: string;
  portfolio_id: string | null;
  property_id: string | null;
  building_id: string | null;
  unit_id: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Rejects any period value other than "annual" with a clear error. Called
 * before any calculation work begins.
 */
export function assertSupportedBudgetPeriod(period: unknown): "annual" {
  const normalized = typeof period === "string" ? period.trim().toLowerCase() : period;
  if (normalized === undefined || normalized === null || normalized === "") {
    return "annual"; // omitted period defaults to the only supported value
  }
  if (!(SUPPORTED_BUDGET_PERIODS as readonly string[]).includes(normalized as string)) {
    throw new Error(
      `Unsupported budget period "${period}" — this budget engine can only produce annual budgets today ` +
      `(no monthly/quarterly calculation logic exists). Refusing to silently generate an annual budget under ` +
      `a different period label. Supported: ${SUPPORTED_BUDGET_PERIODS.join(", ")}.`,
    );
  }
  return "annual";
}

/**
 * Validates and resolves a budget scope request against the real hierarchy,
 * server-side, via the admin client. Fails closed for: an invalid scope
 * value, a missing required ID, IDs that belong to different hierarchy
 * branches, or any referenced entity belonging to another organization.
 * Never silently defaults an explicitly-invalid scope to "property".
 */
export async function assertValidBudgetScopeHierarchy(
  supabaseAdmin: any,
  orgId: string,
  input: {
    scope: unknown;
    portfolio_id?: unknown;
    property_id?: unknown;
    building_id?: unknown;
    unit_id?: unknown;
  },
): Promise<ResolvedBudgetScope> {
  const scope = typeof input.scope === "string" ? input.scope.trim() : input.scope;
  if (!(BUDGET_SCOPE_LEVELS as string[]).includes(scope as string)) {
    throw new Error(
      `Invalid budget scope "${input.scope}" — must be one of: ${BUDGET_SCOPE_LEVELS.join(", ")}. ` +
      `Refusing to silently default to "property".`,
    );
  }

  const portfolioId = isNonEmptyString(input.portfolio_id) ? input.portfolio_id : null;
  const propertyId = isNonEmptyString(input.property_id) ? input.property_id : null;
  const buildingId = isNonEmptyString(input.building_id) ? input.building_id : null;
  const unitId = isNonEmptyString(input.unit_id) ? input.unit_id : null;

  if (scope === "portfolio") {
    if (!portfolioId) {
      throw new Error('Invalid budget scope: portfolio_id is required when scope is "portfolio"');
    }
    if (propertyId || buildingId || unitId) {
      throw new Error('Invalid budget scope: property_id/building_id/unit_id must not be set when scope is "portfolio"');
    }
    const { data: portfolio, error } = await supabaseAdmin
      .from("portfolios")
      .select("id")
      .eq("id", portfolioId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Portfolio lookup failed while validating budget scope: ${error.message}`);
    if (!portfolio) throw new Error(`Invalid budget scope: portfolio ${portfolioId} was not found in organization ${orgId}`);
    return { scope: "portfolio", scope_id: portfolioId, portfolio_id: portfolioId, property_id: null, building_id: null, unit_id: null };
  }

  // property | building | unit all require a property_id.
  if (!propertyId) {
    throw new Error(`Invalid budget scope: property_id is required when scope is "${scope}"`);
  }
  const { data: property, error: propertyError } = await supabaseAdmin
    .from("properties")
    .select("id, portfolio_id")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (propertyError) throw new Error(`Property lookup failed while validating budget scope: ${propertyError.message}`);
  if (!property) throw new Error(`Invalid budget scope: property ${propertyId} was not found in organization ${orgId}`);

  // If a portfolio_id was also supplied, it must actually be this
  // property's portfolio — never silently accepted, never silently
  // overridden by the property's own value.
  if (portfolioId && property.portfolio_id !== portfolioId) {
    throw new Error(
      `Invalid budget scope: property ${propertyId} belongs to portfolio ${property.portfolio_id ?? "none"}, not the requested portfolio ${portfolioId}`,
    );
  }
  const resolvedPortfolioId = property.portfolio_id ?? null;

  if (scope === "property") {
    if (buildingId || unitId) {
      throw new Error('Invalid budget scope: building_id/unit_id must not be set when scope is "property"');
    }
    return { scope: "property", scope_id: propertyId, portfolio_id: resolvedPortfolioId, property_id: propertyId, building_id: null, unit_id: null };
  }

  if (scope === "building") {
    if (unitId) {
      throw new Error('Invalid budget scope: unit_id must not be set when scope is "building"');
    }
    if (!buildingId) {
      throw new Error('Invalid budget scope: building_id is required when scope is "building"');
    }
    const { data: building, error } = await supabaseAdmin
      .from("buildings")
      .select("id")
      .eq("id", buildingId)
      .eq("property_id", propertyId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (error) throw new Error(`Building lookup failed while validating budget scope: ${error.message}`);
    if (!building) throw new Error(`Invalid budget scope: building ${buildingId} does not belong to property ${propertyId} in organization ${orgId}`);
    return { scope: "building", scope_id: buildingId, portfolio_id: resolvedPortfolioId, property_id: propertyId, building_id: buildingId, unit_id: null };
  }

  // scope === "unit"
  if (!unitId) {
    throw new Error('Invalid budget scope: unit_id is required when scope is "unit"');
  }
  const { data: unit, error: unitError } = await supabaseAdmin
    .from("units")
    .select("id, building_id")
    .eq("id", unitId)
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .maybeSingle();
  if (unitError) throw new Error(`Unit lookup failed while validating budget scope: ${unitError.message}`);
  if (!unit) throw new Error(`Invalid budget scope: unit ${unitId} does not belong to property ${propertyId} in organization ${orgId}`);

  // If the caller also supplied building_id, it must match the unit's own
  // building (when the unit has one) — same "never silently accept a
  // mismatched hint" posture as the portfolio_id check above.
  if (buildingId && unit.building_id && unit.building_id !== buildingId) {
    throw new Error(`Invalid budget scope: unit ${unitId} belongs to building ${unit.building_id}, not the requested building ${buildingId}`);
  }

  return {
    scope: "unit",
    scope_id: unitId,
    portfolio_id: resolvedPortfolioId,
    property_id: propertyId,
    building_id: unit.building_id ?? buildingId ?? null,
    unit_id: unitId,
  };
}

/**
 * Resolves the unit ids that belong to a building — used by
 * applyBudgetScopeRowFilter's building-scope OR clause (a lease/expense/
 * revenue row can be tagged to a unit without its own building_id being
 * populated, mirroring the same nullable relationship documented above for
 * assertValidBudgetScopeHierarchy's unit branch).
 */
export async function resolveBuildingUnitIds(supabaseAdmin: any, orgId: string, buildingId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("units")
    .select("id")
    .eq("building_id", buildingId)
    .eq("org_id", orgId);
  if (error) {
    throw new Error(`Failed to resolve units for building ${buildingId}: ${error.message}`);
  }
  return (data ?? []).map((u: any) => u.id);
}

/**
 * Narrows a leases/expenses/revenues query to a budget's scope. Property
 * scope applies no extra filter (the whole property, as always). Unit scope
 * filters directly on the row's own unit_id. Building scope must match
 * EITHER the row's own building_id OR a unit_id that belongs to this
 * building — omitting the OR clause would silently under-count a
 * building's rollup by dropping any row attached only via unit_id.
 *
 * Shared between compute-budget (building/unit budget calculation) and
 * export-data (building/unit budget export detail rows) so both apply
 * identical scoping — a divergence here would mean an export could show
 * different underlying rows than the budget it's exporting was computed
 * from.
 */
export function applyBudgetScopeRowFilter(query: any, resolvedScope: { scope: string; building_id: string | null; unit_id: string | null }, buildingUnitIds: string[]) {
  if (resolvedScope.scope === "unit") {
    return query.eq("unit_id", resolvedScope.unit_id);
  }
  if (resolvedScope.scope === "building") {
    const orExpr = buildingUnitIds.length > 0
      ? `building_id.eq.${resolvedScope.building_id},unit_id.in.(${buildingUnitIds.join(",")})`
      : `building_id.eq.${resolvedScope.building_id}`;
    return query.or(orExpr);
  }
  return query;
}

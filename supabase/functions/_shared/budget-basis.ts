// @ts-nocheck
// Phase 3A — Next-Year Expense Budget Basis (pure computation, no HTTP/auth).
//
// Produces one traceable next-year budget LINE per (org, property/building
// scope, fiscal_year, canonical expense category) — the historical/current
// evidence and explicit planning assumptions a next-year budget should be
// built from. This is deliberately NOT the approved budget itself: it never
// touches `budgets`, never creates an `expenses` row, and computes a BUDGET
// number, not an accounting fact.
//
// Split from compute-budget-basis/index.ts the same way CAM V2 splits
// buildCamRunInputV2 (DB access, no auth) from the edge function (auth,
// then calls this) — so this module is directly importable/testable without
// standing up an HTTP+auth round trip, and the edge function stays a thin
// wrapper.
//
// Storage: the CALLER persists the returned {snapshotInputs, snapshotOutputs}
// via the existing saveSnapshot/findMatchingCompletedSnapshot helpers
// (engine_type='budget_basis') — this module never writes anything itself.
// No new table, no migration: a prior audit found `budget_line_items` (a
// table shaped almost exactly like this feature) but it is FK-bound to an
// existing `budgets.id`, which this phase's output must not require (a
// basis must be computable before any budget row exists for the target
// year) — so it is not the right reuse target, and computation_snapshots is.
//
// Source-of-truth boundaries enforced here:
//   - reads `public.expenses` directly, filtered to approval_status/
//     approved_status = 'approved' only (draft/rejected/needs_review never
//     contribute) — never expense_classifications, never cam_expense_inputs,
//     never CAM run results, never the legacy compute-expense allocation
//     model.
//   - the TARGET fiscal year's own `expenses` rows are never read at all —
//     only prior_year (target-2) and current_year (target-1), because the
//     whole point of this phase is that target-year actuals normally don't
//     exist yet when the budget is being prepared.
//   - category grouping uses the SAME canonical expense_category_id
//     taxonomy CAM already uses (`resolve_expense_category_id`), applied
//     read-only here — `public.expenses` itself has no expense_category_id
//     column and this function never adds one; it only resolves at read
//     time for grouping.
import { parseBudgetLineItemsByCategory } from "./budget-snapshot-parser.ts";

export const BUDGET_BASIS_ENGINE_TYPE = "budget_basis";
export const BUDGET_BASIS_ENGINE_VERSION = "budget-basis.v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CategoryInput {
  expense_category_id: string;
  assumption_percent?: number | null;
  assumption_reason?: string | null;
  manual_annual_amount?: number | null;
  override_amount?: number | null;
  override_reason?: string | null;
}

export interface BuildBudgetBasisParams {
  orgId: string;
  propertyId: string;
  buildingId?: string | null;
  scope: { scope_level: "property" | "building"; scope_id: string };
  fiscalYear: number;
  categoryInputs?: CategoryInput[];
  actorUserId: string;
  actorEmail?: string | null;
  triggerType?: string;
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function monthFromRow(row: { month?: number | null; date?: string | null }): number | null {
  if (Number.isFinite(row.month) && row.month >= 1 && row.month <= 12) return row.month as number;
  if (row.date) {
    const d = new Date(row.date);
    if (!Number.isNaN(d.getTime())) return d.getUTCMonth() + 1;
  }
  return null;
}

function isApprovedExpenseRow(row: any): boolean {
  const approval = String(row.approval_status || "").toLowerCase();
  const approved = String(row.approved_status || "").toLowerCase();
  if (approval === "rejected" || approved === "rejected") return false;
  return approval === "approved" || approved === "approved";
}

/**
 * Straight-line monthly distribution with exact reconciliation. Splits the
 * annual amount into 12 whole-cent shares, then distributes the leftover
 * cents (from integer-cent division) one at a time across the first N
 * months — the same largest-remainder family of technique already used
 * elsewhere in this codebase for allocation rounding (CAM's residual
 * allocation), applied here to the simple even-split case. This is a
 * transparent supported distribution method, not an invented seasonal
 * curve, and it guarantees sum(monthly) === annual exactly, in cents.
 */
export function distributeMonthly(annual: number): number[] {
  const totalCents = Math.round((Number(annual) || 0) * 100);
  const baseCents = Math.trunc(totalCents / 12);
  let remainder = totalCents - baseCents * 12;
  const months: number[] = [];
  for (let m = 0; m < 12; m++) {
    let cents = baseCents;
    if (remainder > 0) {
      cents += 1;
      remainder -= 1;
    }
    months.push(cents / 100);
  }
  return months;
}

export async function buildBudgetBasisSnapshot(supabaseAdmin: any, params: BuildBudgetBasisParams) {
  const { orgId, propertyId, buildingId = null, scope, fiscalYear, actorUserId, actorEmail = null } = params;
  const categoryInputs = params.categoryInputs ?? [];

  if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
  if (!Number.isInteger(fiscalYear) || fiscalYear < 2000 || fiscalYear > 2100) {
    throw new Error("fiscal_year is required and must be a valid year");
  }
  for (const ci of categoryInputs) {
    if (!UUID_RE.test(String(ci?.expense_category_id || ""))) {
      throw new Error("Each category_inputs entry requires a valid expense_category_id");
    }
    if (ci.override_amount != null && !String(ci.override_reason || "").trim()) {
      throw new Error(`Category ${ci.expense_category_id}: override_amount requires a non-empty override_reason`);
    }
  }

  const priorYear = fiscalYear - 2;
  const currentYear = fiscalYear - 1;

  // ---------------------------------------------------------------
  // 1. Read approved actual expenses for prior_year and current_year
  //    ONLY (never the target fiscal_year). Building-scoped requests
  //    filter to that building's rows; property scope reads the whole
  //    property (matches every other compute-* engine's own property-
  //    level granularity for expenses).
  // ---------------------------------------------------------------
  let expenseQuery = supabaseAdmin
    .from("expenses")
    .select("id, category, amount, month, date, approval_status, approved_status, building_id")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .in("fiscal_year", [priorYear, currentYear]);
  if (scope.scope_level === "building") {
    expenseQuery = expenseQuery.eq("building_id", scope.scope_id);
  }
  const { data: rawExpenses, error: expenseErr } = await expenseQuery;
  if (expenseErr) throw new Error(`Failed to fetch expenses: ${expenseErr.message}`);

  const approvedRows = (rawExpenses ?? []).filter(isApprovedExpenseRow);

  // ---------------------------------------------------------------
  // 2. Resolve each distinct raw category label to the canonical
  //    expense_category_id taxonomy (read-only — expenses.category
  //    itself is never modified). Unresolvable labels are kept
  //    together under an explicit "unresolved:<label>" bucket rather
  //    than silently dropped or guessed.
  // ---------------------------------------------------------------
  const distinctLabels = [...new Set(approvedRows.map((r: any) => String(r.category || "").trim()).filter(Boolean))];
  const resolvedByLabel = new Map<string, { id: string | null; reason: string | null }>();
  for (const label of distinctLabels) {
    const { data: resolved, error: resolveErr } = await supabaseAdmin.rpc("resolve_expense_category_id", {
      p_org_id: orgId,
      p_category: label,
    });
    if (resolveErr) throw new Error(`resolve_expense_category_id failed for "${label}": ${resolveErr.message}`);
    resolvedByLabel.set(label, {
      id: resolved?.expense_category_id ?? null,
      reason: resolved?.unresolved_reason ?? null,
    });
  }

  type Bucket = {
    key: string;
    expense_category_id: string | null;
    category_label: string;
    prior_year_actual: number;
    prior_year_row_ids: string[];
    current_year_by_month: Record<number, number>;
    current_year_row_ids: string[];
  };
  const buckets = new Map<string, Bucket>();
  for (const row of approvedRows as any[]) {
    const label = String(row.category || "").trim() || "(uncategorized)";
    const resolved = resolvedByLabel.get(label);
    const key = resolved?.id ?? `unresolved:${label.toLowerCase()}`;
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        expense_category_id: resolved?.id ?? null,
        category_label: label,
        prior_year_actual: 0,
        prior_year_row_ids: [],
        current_year_by_month: {},
        current_year_row_ids: [],
      });
    }
    const bucket = buckets.get(key)!;
    const amount = Number(row.amount) || 0;
    const rowYear = row.date ? new Date(row.date).getUTCFullYear() : null;
    const belongsToCurrentYear = rowYear === currentYear;
    if (belongsToCurrentYear) {
      const month = monthFromRow(row);
      if (month) {
        bucket.current_year_by_month[month] = (bucket.current_year_by_month[month] || 0) + amount;
      }
      bucket.current_year_row_ids.push(row.id);
    } else {
      bucket.prior_year_actual += amount;
      bucket.prior_year_row_ids.push(row.id);
    }
  }

  // ---------------------------------------------------------------
  // 3. Rung 4 support: an existing approved/locked budget already
  //    persisted for this exact target fiscal_year + scope. Read-only;
  //    reuses the shared parser other engines already use for this
  //    exact shape.
  // ---------------------------------------------------------------
  let approvedBudgetByLabel: Record<string, number> = {};
  {
    const { data: existingBudget } = await supabaseAdmin
      .from("budgets")
      .select("id")
      .eq("org_id", orgId)
      .eq("scope", scope.scope_level)
      .eq("scope_id", scope.scope_id)
      .eq("budget_year", fiscalYear)
      .in("status", ["approved", "locked"])
      .maybeSingle();
    if (existingBudget?.id) {
      const { data: budgetSnapshot } = await supabaseAdmin
        .from("computation_snapshots")
        .select("outputs")
        .eq("org_id", orgId)
        .eq("property_id", propertyId)
        .eq("engine_type", "budget")
        .eq("scope_level", scope.scope_level)
        .eq("scope_id", scope.scope_id)
        .eq("fiscal_year", fiscalYear)
        .eq("status", "completed")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (budgetSnapshot?.outputs) {
        try {
          approvedBudgetByLabel = parseBudgetLineItemsByCategory(budgetSnapshot.outputs);
        } catch {
          approvedBudgetByLabel = {};
        }
      }
    }
  }

  // ---------------------------------------------------------------
  // 4. Carry forward assumptions/overrides from the most recent prior
  //    budget-basis snapshot for this exact series, so a rerun that
  //    doesn't resupply category_inputs still honors what was already
  //    recorded (this IS the "persist the assumption" requirement).
  // ---------------------------------------------------------------
  const { data: priorSnapshotRow } = await supabaseAdmin
    .from("computation_snapshots")
    .select("outputs")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", BUDGET_BASIS_ENGINE_TYPE)
    .eq("scope_level", scope.scope_level)
    .eq("scope_id", scope.scope_id)
    .eq("fiscal_year", fiscalYear)
    .eq("status", "completed")
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const priorCategoriesByKey = new Map<string, any>();
  for (const line of priorSnapshotRow?.outputs?.categories ?? []) {
    const k = line.expense_category_id ?? `unresolved:${String(line.category_label || "").toLowerCase()}`;
    priorCategoriesByKey.set(k, line);
  }

  const categoryInputsById = new Map<string, CategoryInput>();
  for (const ci of categoryInputs) categoryInputsById.set(String(ci.expense_category_id), ci);

  // Every canonical category this org actually has, so a category with
  // an assumption/override but no matching actuals this run still gets a
  // line (needed for override corrections and for categories that exist
  // going forward but had zero prior/current spend).
  const categoryIdsNeedingLines = new Set<string>([
    ...buckets.keys(),
    ...[...categoryInputsById.keys()],
    ...[...priorCategoriesByKey.keys()],
  ]);

  const nowIso = new Date().toISOString();
  const categories: any[] = [];
  const allSourceRowIds: string[] = [];

  for (const key of categoryIdsNeedingLines) {
    const bucket = buckets.get(key) ?? null;
    const expenseCategoryId = bucket?.expense_category_id ?? (UUID_RE.test(key) ? key : null);
    let categoryLabel = bucket?.category_label ?? null;
    let categoryName: string | null = null;
    let normalizedKey: string | null = null;
    if (expenseCategoryId) {
      const { data: catRow } = await supabaseAdmin
        .from("expense_categories")
        .select("category_name, normalized_key")
        .eq("id", expenseCategoryId)
        .maybeSingle();
      categoryName = catRow?.category_name ?? null;
      normalizedKey = catRow?.normalized_key ?? null;
      if (!categoryLabel) categoryLabel = categoryName;
    }
    if (!categoryLabel) categoryLabel = key.startsWith("unresolved:") ? key.slice("unresolved:".length) : key;

    const priorYearActual = round2(bucket?.prior_year_actual ?? 0);
    const currentYearMonths = bucket ? Object.keys(bucket.current_year_by_month).map(Number) : [];
    const currentYearYtd = round2(
      currentYearMonths.reduce((sum, m) => sum + (bucket!.current_year_by_month[m] || 0), 0),
    );
    const monthsElapsed = currentYearMonths.length;
    const currentYearForecast = monthsElapsed > 0 ? round2((currentYearYtd / monthsElapsed) * 12) : null;

    if (bucket) {
      allSourceRowIds.push(...bucket.prior_year_row_ids, ...bucket.current_year_row_ids);
    }

    // Rung 1: authoritative current-year approved forecast. No such
    // persisted/approved expense-forecast mechanism exists anywhere in
    // this codebase today (audited: ExpenseProjection.jsx is ephemeral/
    // client-only; compute-revenue's rolling_forecast is revenue-side).
    // This check is real and will activate automatically the day such a
    // source exists — it is not a stub removed later, it simply always
    // returns null right now.
    const authoritativeForecast: number | null = null;

    // Rung 4: an existing approved/locked budget for this exact target
    // year, matched by category label (case-insensitive) against
    // whatever text keys compute-budget's own snapshot used.
    let approvedBudgetBaseline: number | null = null;
    if (categoryName || normalizedKey || categoryLabel) {
      const candidates = [categoryName, normalizedKey, categoryLabel].filter(Boolean).map((s) => String(s).toLowerCase());
      for (const [label, amount] of Object.entries(approvedBudgetByLabel)) {
        if (candidates.includes(String(label).toLowerCase())) {
          approvedBudgetBaseline = round2(Number(amount) || 0);
          break;
        }
      }
    }

    // Rung 5: known vendor/contract amount. No table in this schema
    // carries a vendor contract dollar amount (public.vendors has no
    // amount column) — same honest "real check, currently always null"
    // treatment as rung 1.
    const vendorContractAmount: number | null = null;

    let baselineType = "no_data";
    let baselineAmount = 0;
    if (authoritativeForecast != null) {
      baselineType = "current_year_authoritative_forecast";
      baselineAmount = authoritativeForecast;
    } else if (currentYearForecast != null) {
      baselineType = "current_year_ytd_projected";
      baselineAmount = currentYearForecast;
    } else if (priorYearActual > 0) {
      baselineType = "prior_year_actual";
      baselineAmount = priorYearActual;
    } else if (approvedBudgetBaseline != null) {
      baselineType = "existing_approved_budget";
      baselineAmount = approvedBudgetBaseline;
    } else if (vendorContractAmount != null) {
      baselineType = "vendor_contract";
      baselineAmount = vendorContractAmount;
    }

    // Rung 6 + assumption/override: from this call's category_inputs, or
    // carried forward from the prior snapshot for this series if this
    // call didn't resupply this category.
    const supplied = expenseCategoryId ? categoryInputsById.get(expenseCategoryId) : null;
    const carried = priorCategoriesByKey.get(key);

    const assumptionPercent =
      supplied && supplied.assumption_percent != null ? Number(supplied.assumption_percent) : carried?.assumption?.value ?? null;
    const assumptionReason = supplied?.assumption_reason ?? carried?.assumption?.reason ?? null;
    const assumptionRecorded = assumptionPercent != null
      ? {
          type: "percent_growth",
          value: assumptionPercent,
          reason: assumptionReason,
          actor_user_id: supplied ? actorUserId : carried?.assumption?.actor_user_id ?? null,
          actor_email: supplied ? actorEmail : carried?.assumption?.actor_email ?? null,
          recorded_at: supplied ? nowIso : carried?.assumption?.recorded_at ?? null,
        }
      : null;

    const manualAnnualAmount =
      supplied && supplied.manual_annual_amount != null ? Number(supplied.manual_annual_amount) : carried?.manual_annual_amount ?? null;
    if (baselineType === "no_data" && manualAnnualAmount != null) {
      baselineType = "manual_assumption";
      baselineAmount = round2(manualAnnualAmount);
    }

    let calculatedAnnualBudget: number;
    if (baselineType === "manual_assumption") {
      calculatedAnnualBudget = baselineAmount;
    } else {
      calculatedAnnualBudget = round2(baselineAmount * (1 + (assumptionPercent || 0) / 100));
    }

    const overrideAmount = supplied && supplied.override_amount != null ? round2(Number(supplied.override_amount)) : carried?.override?.amount ?? null;
    const overrideReason = supplied?.override_reason ?? carried?.override?.reason ?? null;
    const override =
      overrideAmount != null
        ? {
            amount: overrideAmount,
            reason: overrideReason,
            actor_user_id: supplied?.override_amount != null ? actorUserId : carried?.override?.actor_user_id ?? null,
            actor_email: supplied?.override_amount != null ? actorEmail : carried?.override?.actor_email ?? null,
            overridden_at: supplied?.override_amount != null ? nowIso : carried?.override?.overridden_at ?? null,
          }
        : null;

    const annualBudget = override ? override.amount : calculatedAnnualBudget;
    const monthlyBudget = distributeMonthly(annualBudget);

    const explanationParts: string[] = [];
    if (baselineType === "no_data") {
      explanationParts.push(
        `No prior-year (${priorYear}) or current-year (${currentYear}) approved actuals, no approved ${fiscalYear} budget baseline, and no vendor/contract or manual amount supplied.`,
      );
    } else if (baselineType === "current_year_ytd_projected") {
      explanationParts.push(
        `Based on ${currentYear} YTD approved actuals of $${currentYearYtd.toLocaleString()} across ${monthsElapsed} month(s), projected to a full-year run rate of $${baselineAmount.toLocaleString()}.`,
      );
    } else if (baselineType === "prior_year_actual") {
      explanationParts.push(`Based on ${priorYear} full-year approved actual of $${baselineAmount.toLocaleString()} (no ${currentYear} approved actuals available).`);
    } else if (baselineType === "existing_approved_budget") {
      explanationParts.push(`Based on the existing approved/locked ${fiscalYear} budget baseline of $${baselineAmount.toLocaleString()}.`);
    } else if (baselineType === "manual_assumption") {
      explanationParts.push(`No historical/current basis available; using the manually entered ${fiscalYear} amount of $${baselineAmount.toLocaleString()}.`);
    }
    if (assumptionRecorded) {
      explanationParts.push(
        `${assumptionRecorded.value > 0 ? "+" : ""}${assumptionRecorded.value}% assumption applied` +
          (assumptionRecorded.reason ? ` (${assumptionRecorded.reason})` : "") +
          ` -> $${calculatedAnnualBudget.toLocaleString()}.`,
      );
    }
    if (override) {
      explanationParts.push(`Overridden to $${override.amount.toLocaleString()} by ${override.actor_email || override.actor_user_id || "reviewer"}${override.reason ? `: ${override.reason}` : ""}.`);
    }

    categories.push({
      expense_category_id: expenseCategoryId,
      category_label: categoryLabel,
      category_name: categoryName,
      normalized_key: normalizedKey,
      unresolved_reason: expenseCategoryId ? null : resolvedByLabel.get(categoryLabel)?.reason ?? "CATEGORY_NOT_FOUND",
      prior_year: priorYear,
      prior_year_actual: priorYearActual,
      current_year: currentYear,
      current_year_ytd_actual: currentYearYtd,
      current_year_ytd_months_elapsed: monthsElapsed,
      current_year_forecast: currentYearForecast,
      baseline_type: baselineType,
      baseline_amount: round2(baselineAmount),
      assumption: assumptionRecorded,
      calculated_annual_budget: calculatedAnnualBudget,
      override,
      annual_budget: annualBudget,
      monthly_budget: monthlyBudget,
      source_basis_explanation: explanationParts.join(" "),
    });
  }

  categories.sort((a, b) => String(a.category_label).localeCompare(String(b.category_label)));

  const annualBudgetTotal = round2(categories.reduce((s, c) => s + c.annual_budget, 0));
  const totals = {
    calculated_annual_budget_total: round2(categories.reduce((s, c) => s + c.calculated_annual_budget, 0)),
    annual_budget_total: annualBudgetTotal,
    monthly_budget_total: distributeMonthly(annualBudgetTotal),
  };

  const sortedSourceRowIds = [...new Set(allSourceRowIds)].sort();
  const snapshotInputs = {
    property_id: propertyId,
    building_id: buildingId,
    fiscal_year: fiscalYear,
    prior_year: priorYear,
    current_year: currentYear,
    scope_level: scope.scope_level,
    scope_id: scope.scope_id,
    category_inputs: categoryInputs,
    _compute: {
      page_scope: ["CreateBudget", "BudgetDashboard"],
      source_tables: ["expenses", "budgets", "computation_snapshots"],
      source_row_ids: { expenses: sortedSourceRowIds },
      source_counts: { expenses: sortedSourceRowIds.length },
      trigger_type: params.triggerType ?? "manual",
    },
  };
  const snapshotOutputs = {
    schema_version: "budget_basis.v1",
    org_id: orgId,
    property_id: propertyId,
    building_id: buildingId,
    scope_level: scope.scope_level,
    scope_id: scope.scope_id,
    fiscal_year: fiscalYear,
    prior_year: priorYear,
    current_year: currentYear,
    categories,
    totals,
  };

  return { snapshotInputs, snapshotOutputs };
}

// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { verifyUser, getUserOrgId, assertPageAccess, assertPropertyAccess, assertPortfolioAccess } from "../_shared/supabase.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";
import { BUDGET_LINE_ITEMS_SCHEMA_VERSION } from "../_shared/budget-snapshot-parser.ts";
import { assertValidBudgetScopeHierarchy, assertSupportedBudgetPeriod, resolveBuildingUnitIds, applyBudgetScopeRowFilter, type ResolvedBudgetScope } from "../_shared/budget-scope.ts";
import { resolveBudgetIdentity, type ResolvedBudget } from "../_shared/budget-identity.ts";
import { buildSnapshotSeriesIdentity, applySnapshotSeriesFilter } from "../_shared/snapshot-identity.ts";

const ENGINE_VERSION = "budget-v1.1";

/**
 * Compute Budget Edge Function
 * Generates budgets aggregating revenue projections and expense plans.
 * Supports approval workflow and versioning.
 *
 * Scope contract: see _shared/budget-scope.ts (portfolio | property | building
 * | unit, validated server-side against the real hierarchy). Period
 * contract: annual only — see assertSupportedBudgetPeriod.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 * Task: 12.1
 */
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);

    const body = await req.json();
    const {
      budget_id,
      scope: rawScope,
      portfolio_id,
      property_id,
      building_id,
      unit_id,
      // Compact/CAM-style form: { property_id, scope_level, scope_id },
      // the wire shape _shared/scope.ts's assertValidScopeHierarchy and
      // compute-cam already use, and what the shared PipelineActions
      // component (src/components/PipelineActions.jsx) sends for every
      // engine it drives generically — it only knows one scope_id per
      // node, not four separate portfolio/property/building/unit fields.
      // Normalized into the explicit per-level fields below so
      // PipelineActions' existing budget quick-actions (Generate/Approve/
      // Lock) work against this contract without that shared, multi-engine
      // component needing a budget-specific special case. Portfolio scope
      // is not expressible in this compact form (it has no property_id),
      // which is fine — PipelineActions always requires a property_id.
      scope_level,
      scope_id,
      fiscal_year,
      period: rawPeriod,
      action,
      allow_generate_without_cam,
      readiness_snapshot,
      ai_insights,
      reason,
    } = body;

    await assertPageAccess(req, orgId, ["BudgetDashboard", "CreateBudget"], "write");

    const resolvedAction = action || "generate";

    // ---------------------------------------------------------------
    // generate: creates a NEW budget, so it is keyed by the REQUESTED
    // scope (there is no existing row's identity to resolve yet) — full
    // hierarchy + period validation, exactly as before this PR.
    // ---------------------------------------------------------------
    if (resolvedAction === "generate") {
      if (!fiscal_year) {
        throw new Error("fiscal_year is required");
      }

      // Backward-compatible default: an omitted `scope` alongside a
      // property_id is the pre-existing calling convention (every budget
      // before the scope/period PR was implicitly property-scoped). This is
      // the ONLY case that defaults — an explicitly-provided, invalid scope
      // value is never silently coerced; assertValidBudgetScopeHierarchy
      // still fails closed on that.
      const requestedScope = rawScope ?? scope_level ?? (property_id ? "property" : undefined);
      const requestedBuildingId = building_id ?? (scope_level === "building" ? scope_id : undefined);
      const requestedUnitId = unit_id ?? (scope_level === "unit" ? scope_id : undefined);

      const resolvedScope = await assertValidBudgetScopeHierarchy(supabaseAdmin, orgId, {
        scope: requestedScope,
        portfolio_id,
        property_id,
        building_id: requestedBuildingId,
        unit_id: requestedUnitId,
      });

      const period = assertSupportedBudgetPeriod(rawPeriod);

      if (resolvedScope.scope === "portfolio") {
        await assertPortfolioAccess(req, resolvedScope.portfolio_id);
      } else {
        await assertPropertyAccess(req, resolvedScope.property_id);
      }

      return await handleGenerate(supabaseAdmin, orgId, user.id, resolvedScope, period, fiscal_year, allow_generate_without_cam === true, readiness_snapshot ?? null, typeof ai_insights === "string" ? ai_insights : null);
    }

    // ---------------------------------------------------------------
    // approve / mark_reviewed / reject / lock: all act on an EXISTING
    // budget, so budget_id is the primary identifier (hardening PR —
    // never re-derive "the" budget from property_id/fiscal_year alone,
    // since that stopped being unambiguous once building/unit budgets can
    // coexist with a property's own budget for the same year).
    // resolveBudgetIdentity fails closed on: no such budget, wrong org,
    // any supplied scope/scope_id/property_id hint that disagrees with the
    // resolved row, and an invalid/stale stored hierarchy. Legacy callers
    // that only ever send property_id + fiscal_year (no budget_id, no
    // scope) still resolve correctly and unambiguously, because
    // (org_id, scope, scope_id, budget_year) is now a real, DB-enforced
    // unique key — not a guess among possibly-multiple rows.
    // ---------------------------------------------------------------
    const requestedScope = rawScope ?? scope_level;
    const requestedScopeId =
      scope_id ??
      (requestedScope === "building" ? building_id
        : requestedScope === "unit" ? unit_id
        : requestedScope === "portfolio" ? portfolio_id
        : requestedScope === "property" ? property_id
        : undefined);

    const resolvedBudget = await resolveBudgetIdentity(supabaseAdmin, orgId, {
      budget_id,
      scope: requestedScope,
      scope_id: requestedScopeId,
      property_id,
      fiscal_year,
    });

    if (resolvedBudget.scope === "portfolio") {
      await assertPortfolioAccess(req, resolvedBudget.portfolio_id);
    } else {
      await assertPropertyAccess(req, resolvedBudget.property_id);
    }

    // ---------------------------------------------------------------
    // Route to the appropriate action handler
    // ---------------------------------------------------------------
    switch (resolvedAction) {
      case "approve":
        // CreateBudget.jsx's UI only ever offers "Approve" once a budget has
        // been marked "reviewed" (a CreateBudget-specific intermediate step
        // compute-budget itself has no concept of) — accept either status so
        // the one enforced approval gate matches how the UI actually drives
        // it, instead of a precondition the UI could never satisfy.
        return await handleStatusTransition(supabaseAdmin, orgId, user.id, resolvedBudget, ["under_review", "reviewed"], "approved", "Budget approved successfully");
      case "mark_reviewed":
        // Matches CreateBudget.jsx's "Mark as Reviewed" button, which is
        // offered from draft/ai_generated/under_review.
        return await handleMarkReviewed(supabaseAdmin, orgId, user.id, resolvedBudget);
      case "reject":
        // CreateBudget.jsx's "Reject / Rework" button is offered from any
        // status except approved/locked/signed (not just 'under_review') and
        // carries a required rejection comment.
        return await handleReject(supabaseAdmin, orgId, user.id, resolvedBudget, typeof reason === "string" ? reason : null);
      case "lock":
        return await handleLock(supabaseAdmin, orgId, user.id, resolvedBudget);
      default:
        throw new Error(`Unknown action: ${resolvedAction}. Must be one of: generate, approve, mark_reviewed, reject, lock`);
    }
  } catch (err) {
    console.error("[compute-budget] Error:", err.message);
    return new Response(
      JSON.stringify({ error: true, message: err.message }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});

// =================================================================
// Scope-keyed helpers
// =================================================================

/** Applies the canonical budget row identity (org_id, scope, scope_id[, budget_year]) to a `budgets` query builder. */
function applyBudgetRowFilter(query: any, orgId: string, resolvedScope: ResolvedBudgetScope, fiscalYear?: number) {
  let q = query.eq("org_id", orgId).eq("scope", resolvedScope.scope).eq("scope_id", resolvedScope.scope_id);
  if (fiscalYear !== undefined) {
    q = q.eq("budget_year", fiscalYear);
  }
  return q;
}

/** Applies the canonical budget engine_type="budget" snapshot series identity to a computation_snapshots query builder. */
function applyBudgetSnapshotFilter(query: any, orgId: string, resolvedScope: ResolvedBudgetScope, fiscalYear: number) {
  const identity = buildSnapshotSeriesIdentity({
    org_id: orgId,
    property_id: resolvedScope.property_id,
    engine_type: "budget",
    scope_level: resolvedScope.scope,
    scope_id: resolvedScope.scope_id,
    fiscal_year: fiscalYear,
    month: null,
  });
  return applySnapshotSeriesFilter(query, identity);
}

// resolveBuildingUnitIds / applyBudgetScopeRowFilter now live in
// _shared/budget-scope.ts, shared with export-data so both compute the
// exact same underlying row set for a building/unit-scoped budget.

// =================================================================
// Action: generate
// =================================================================
async function handleGenerate(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedScope: ResolvedBudgetScope,
  period: "annual",
  fiscalYear: number,
  allowGenerateWithoutCam = false,
  readinessSnapshot: any = null,
  aiInsights: string | null = null
) {
  // Portfolio-level budget generation is intentionally NOT implemented in
  // this PR. compute-revenue, compute-expense, and compute-cam are all
  // property-anchored engines (none can produce a portfolio-wide figure),
  // so there are exactly two honest ways to support portfolio generation:
  // (a) aggregate the portfolio's property-level snapshots here, or (b)
  // require a dedicated portfolio calculation engine. Both are new
  // calculation capabilities, not a scope-handling fix, and this task's
  // scope is explicitly "honor the selected scope", not "add portfolio
  // roll-up math". Rather than silently picking an arbitrary child
  // property's snapshot (the exact failure mode this task calls out),
  // portfolio scope is fully valid for hierarchy validation and persistence
  // (see _shared/budget-scope.ts) but generation fails closed here until
  // (a) or (b) is explicitly authorized as its own PR.
  if (resolvedScope.scope === "portfolio") {
    throw new Error(
      "Portfolio-level budget generation is not yet supported: no dedicated portfolio calculation engine exists, " +
      "and aggregating child property snapshots is a distinct, unauthorized feature decision. " +
      "Generate property/building/unit budgets individually instead.",
    );
  }

  const propertyId = resolvedScope.property_id;
  const isSubPropertyScope = resolvedScope.scope === "building" || resolvedScope.scope === "unit";

  // ---------------------------------------------------------------
  // 1. Fetch property (and, for building/unit scope, the specific
  //    building/unit) details
  // ---------------------------------------------------------------
  const { data: property, error: propErr } = await supabaseAdmin
    .from("properties")
    .select("id, name")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .single();

  if (propErr || !property) {
    throw new Error(`Property not found: ${propErr?.message ?? propertyId}`);
  }

  let scopeEntityName = property.name;
  if (resolvedScope.scope === "building") {
    const { data: building, error: buildingErr } = await supabaseAdmin
      .from("buildings")
      .select("name")
      .eq("id", resolvedScope.building_id)
      .eq("org_id", orgId)
      .single();
    if (buildingErr || !building) {
      throw new Error(`Building not found: ${buildingErr?.message ?? resolvedScope.building_id}`);
    }
    scopeEntityName = `${property.name} / ${building.name ?? resolvedScope.building_id}`;
  } else if (resolvedScope.scope === "unit") {
    const { data: unit, error: unitErr } = await supabaseAdmin
      .from("units")
      .select("unit_number")
      .eq("id", resolvedScope.unit_id)
      .eq("org_id", orgId)
      .single();
    if (unitErr || !unit) {
      throw new Error(`Unit not found: ${unitErr?.message ?? resolvedScope.unit_id}`);
    }
    scopeEntityName = `${property.name} / Unit ${unit.unit_number ?? resolvedScope.unit_id}`;
  }

  // Revenue/expense dependency snapshots remain PROPERTY-LEVEL ONLY. This is
  // a deliberate, documented limitation carried forward from this PR's
  // workflow trace, not a bug introduced here: compute-revenue and
  // compute-expense have no building/unit-granular calculation logic at
  // all (confirmed by reading both in full), and adding one would be new
  // calculation math, which this task explicitly excludes. A building/unit
  // budget still requires the property's revenue/expense snapshots to
  // exist as a readiness gate (proving those engines have run), but the
  // actual base-rent/other-income/expense DOLLAR figures for a building or
  // unit budget are computed below directly from scope-filtered raw rows
  // (leases/expenses/revenues all carry their own building_id/unit_id),
  // never from the property-wide snapshot total — using the property-wide
  // total for a narrower scope would silently overstate a building/unit
  // budget by including the rest of the property.
  const { data: revenueSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "revenue")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data: expenseSnapshot } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs, computed_at")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "expense")
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!revenueSnapshot?.outputs) {
    throw new Error("Revenue snapshot is required before generating a budget");
  }
  if (!expenseSnapshot?.outputs) {
    throw new Error("Expense snapshot is required before generating a budget");
  }

  const buildingUnitIds = resolvedScope.scope === "building"
    ? await resolveBuildingUnitIds(supabaseAdmin, orgId, resolvedScope.building_id)
    : [];

  // ---------------------------------------------------------------
  // 2. Calculate total projected revenue from trusted snapshots + stored detail
  // ---------------------------------------------------------------

  // 2a. Base rent from active leases
  let leaseQuery = supabaseAdmin
    .from("leases")
    .select("id, monthly_rent, start_date, end_date, status")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("status", "active");
  leaseQuery = applyBudgetScopeRowFilter(leaseQuery, resolvedScope, buildingUnitIds);
  const { data: leases, error: leaseErr } = await leaseQuery;

  if (leaseErr) {
    throw new Error(`Failed to fetch leases: ${leaseErr.message}`);
  }

  const fyStart = new Date(fiscalYear, 0, 1); // Jan 1 of fiscal year
  const fyEnd = new Date(fiscalYear, 11, 31); // Dec 31 of fiscal year

  let computedBaseRentFromLeases = 0;
  for (const lease of leases ?? []) {
    const monthlyRent = Number(lease.monthly_rent) || 0;
    const leaseStart = new Date(lease.start_date);
    const leaseEnd = lease.end_date ? new Date(lease.end_date) : fyEnd;

    const overlapStart = leaseStart > fyStart ? leaseStart : fyStart;
    const overlapEnd = leaseEnd < fyEnd ? leaseEnd : fyEnd;

    if (overlapStart <= overlapEnd) {
      const startMonth = overlapStart.getFullYear() * 12 + overlapStart.getMonth();
      const endMonth = overlapEnd.getFullYear() * 12 + overlapEnd.getMonth();
      const activeMonths = endMonth - startMonth + 1;
      computedBaseRentFromLeases += monthlyRent * activeMonths;
    }
  }

  // Property scope: prefer the trusted snapshot total, falling back to the
  // per-lease computation only when the snapshot has no base_rent figure —
  // unchanged from pre-PR behavior. Building/unit scope: the snapshot total
  // is property-wide and not meaningful at this granularity, so always use
  // the scope-filtered per-lease computation (see block comment above).
  const baseRent = isSubPropertyScope
    ? computedBaseRentFromLeases
    : (Number(revenueSnapshot?.outputs?.summary?.revenue_by_type?.base_rent ?? 0) || computedBaseRentFromLeases);

  // 2b. CAM recovery from the CAM snapshot matching THIS budget's own scope
  // (property budget -> property CAM snapshot, building -> building CAM
  // snapshot, unit -> unit CAM snapshot) — never the whole-property total
  // for a building/unit-scoped budget, and never a sub-scope snapshot for a
  // property-scoped budget.
  let camRecovery = 0;
  const { data: camSnapshot, error: camSnapErr } = await supabaseAdmin
    .from("computation_snapshots")
    .select("id, outputs")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("engine_type", "cam")
    .eq("scope_level", resolvedScope.scope)
    .eq("scope_id", resolvedScope.scope_id)
    .eq("fiscal_year", fiscalYear)
    .order("computed_at", { ascending: false })
    .limit(1);

  if (!camSnapErr && camSnapshot && camSnapshot.length > 0) {
    const camOutputs = camSnapshot[0].outputs;
    camRecovery = Number(camOutputs?.total_cam) || 0;
  } else if (!allowGenerateWithoutCam) {
    throw new Error(
      `CAM snapshot is required before generating a "${resolvedScope.scope}"-scope budget ` +
      `(looked for scope_level="${resolvedScope.scope}", scope_id="${resolvedScope.scope_id}"). ` +
      `Re-run with allow_generate_without_cam=true only when you intentionally want to bypass CAM.`,
    );
  }

  // 2c. Other revenue from revenues table
  let revenueQuery = supabaseAdmin
    .from("revenues")
    .select("type, amount, month")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("fiscal_year", fiscalYear);
  revenueQuery = applyBudgetScopeRowFilter(revenueQuery, resolvedScope, buildingUnitIds);
  const { data: revenues, error: revErr } = await revenueQuery;
  if (revErr) {
    throw new Error(`Failed to fetch revenues: ${revErr.message}`);
  }

  let computedOtherIncomeFromRevenues = 0;
  for (const rev of revenues ?? []) {
    computedOtherIncomeFromRevenues += Number(rev.amount) || 0;
  }

  const otherIncome = isSubPropertyScope
    ? computedOtherIncomeFromRevenues
    : (Number(revenueSnapshot?.outputs?.summary?.revenue_by_type?.other_income ?? 0) || computedOtherIncomeFromRevenues);

  const totalRevenue = baseRent + camRecovery + otherIncome;

  // ---------------------------------------------------------------
  // 3. Calculate total projected expenses
  // ---------------------------------------------------------------
  let expenseQuery = supabaseAdmin
    .from("expenses")
    .select("id, category, amount, classification, month")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("fiscal_year", fiscalYear);
  expenseQuery = applyBudgetScopeRowFilter(expenseQuery, resolvedScope, buildingUnitIds);
  const { data: expenses, error: expErr } = await expenseQuery;

  if (expErr) {
    throw new Error(`Failed to fetch expenses: ${expErr.message}`);
  }

  // Group expenses by category (always computed from the scope-filtered
  // rows, regardless of scope — the per-category breakdown has always come
  // from raw rows, never the snapshot).
  const expenseByCategory: Record<string, number> = {};
  let computedTotalExpensesFromRows = 0;
  for (const exp of expenses ?? []) {
    const amount = Number(exp.amount) || 0;
    const category = (exp.category || "other").toLowerCase();
    expenseByCategory[category] = (expenseByCategory[category] || 0) + amount;
    computedTotalExpensesFromRows += amount;
  }

  const totalExpenses = isSubPropertyScope
    ? computedTotalExpensesFromRows
    : (Number(expenseSnapshot?.outputs?.total_expenses ?? 0) || computedTotalExpensesFromRows);

  // ---------------------------------------------------------------
  // 4. Generate budget line items
  // ---------------------------------------------------------------

  // Revenue lines
  const revenueLines: Record<string, number> = {
    base_rent: round2(baseRent),
    cam_recovery: round2(camRecovery),
    other_income: round2(otherIncome),
    total: round2(totalRevenue),
  };

  // Expense lines - extract known categories, rest goes to "other"
  const knownCategories = ["utilities", "maintenance", "insurance", "taxes", "management"];
  const expenseLines: Record<string, number> = {};

  for (const cat of knownCategories) {
    expenseLines[cat] = round2(expenseByCategory[cat] || 0);
  }

  // Aggregate remaining categories into "other"
  let otherExpenses = 0;
  for (const [cat, amt] of Object.entries(expenseByCategory)) {
    if (!knownCategories.includes(cat)) {
      otherExpenses += amt;
    }
  }
  expenseLines.other = round2(otherExpenses);
  expenseLines.total = round2(totalExpenses);

  // NOI
  const noi = round2(totalRevenue - totalExpenses);

  const lineItems = {
    schema_version: BUDGET_LINE_ITEMS_SCHEMA_VERSION,
    revenue: revenueLines,
    expenses: expenseLines,
    noi,
  };

  // ---------------------------------------------------------------
  // 5. Create or update budget record with status='draft'
  // ---------------------------------------------------------------
  const budgetName = `${scopeEntityName} - FY ${fiscalYear} Budget`;

  const budgetPayload = {
    org_id: orgId,
    scope: resolvedScope.scope,
    scope_id: resolvedScope.scope_id,
    portfolio_id: resolvedScope.portfolio_id,
    property_id: resolvedScope.property_id,
    building_id: resolvedScope.building_id,
    unit_id: resolvedScope.unit_id,
    name: budgetName,
    budget_year: fiscalYear,
    total_revenue: round2(totalRevenue),
    total_expenses: round2(totalExpenses),
    noi: noi,
    cam_total: round2(camRecovery),
    // Only set ai_insights when the caller actually provided a fresh value
    // (e.g. CreateBudget.jsx's OpenAI preview text) — omitting the key
    // entirely on a bare re-generate call preserves whatever was stored
    // previously instead of clobbering it with null.
    ...(aiInsights ? { ai_insights: aiInsights } : {}),
    generation_method: "automated",
    period,
    status: "draft",
    updated_at: new Date().toISOString(),
  };

  // Try to find an existing budget for this scope and year
  const { data: existingBudget } = await applyBudgetRowFilter(
    supabaseAdmin.from("budgets").select("id, status"),
    orgId,
    resolvedScope,
    fiscalYear,
  ).limit(1);

  if (existingBudget && existingBudget.length > 0) {
    const existing = existingBudget[0];
    if (existing.status === "locked") {
      throw new Error("Cannot regenerate a locked budget. Create a new version instead.");
    }
    if (existing.status === "approved") {
      throw new Error("Cannot regenerate an approved budget. Reject it first or lock and create a new version.");
    }
  }

  const { data: upsertData, error: upsertErr } = await supabaseAdmin
    .from("budgets")
    .upsert({
      ...budgetPayload,
      created_at: new Date().toISOString(), // Will be ignored on update if we don't include it in onConflict, but we want it for new rows
    }, {
      onConflict: "org_id,scope,scope_id,budget_year"
    })
    .select("id")
    .single();

  if (upsertErr) {
    throw new Error(`Failed to save budget: ${upsertErr.message}`);
  }
  const budgetId = upsertData.id;


  // ---------------------------------------------------------------
  // 6. Store in computation_snapshots with engine_type='budget'
  // ---------------------------------------------------------------
  const snapshotPayload = {
    org_id: orgId,
    property_id: resolvedScope.property_id,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    inputs: {
      // Explicit scope + period on every newly-created budget snapshot — no
      // legacy defaulting. resolveSnapshotScope (_shared/snapshot.ts) reads
      // scope_level/scope_id straight from here rather than falling back to
      // LEGACY_SCOPE_DEFAULT_ENGINES's property default.
      scope_level: resolvedScope.scope,
      scope_id: resolvedScope.scope_id,
      portfolio_id: resolvedScope.portfolio_id,
      property_id: resolvedScope.property_id,
      building_id: resolvedScope.building_id,
      unit_id: resolvedScope.unit_id,
      fiscal_year: fiscalYear,
      period,
      lease_count: (leases ?? []).length,
      expense_count: (expenses ?? []).length,
      revenue_count: (revenues ?? []).length,
      readiness_snapshot: readinessSnapshot,
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "leases", "expenses", "revenues", "computation_snapshots"],
        source_row_ids: {
          leases: (leases ?? []).map((lease: any) => lease.id).sort(),
          expenses: (expenses ?? []).map((expense: any) => expense.id).sort(),
          revenues: (revenues ?? []).map((revenue: any) => revenue.id).sort(),
        },
        source_counts: {
          leases: (leases ?? []).length,
          expenses: (expenses ?? []).length,
          revenues: (revenues ?? []).length,
        },
        source_snapshot_ids: {
          revenue: revenueSnapshot.id,
          expense: expenseSnapshot.id,
          cam: camSnapshot?.[0]?.id ?? null,
        },
        trigger_type: "manual",
      },
    },
    outputs: {
      budget_id: budgetId,
      status: "draft",
      line_items: lineItems,
    },
  };

  const existingSnapshot = await findMatchingCompletedSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: resolvedScope.property_id,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    inputs: snapshotPayload.inputs,
    outputs: snapshotPayload.outputs,
    computed_by: userId,
  });

  if (existingSnapshot?.outputs?.budget_id) {
    return new Response(
      JSON.stringify({
        error: false,
        scope: resolvedScope.scope,
        scope_id: resolvedScope.scope_id,
        portfolio_id: resolvedScope.portfolio_id,
        property_id: resolvedScope.property_id,
        building_id: resolvedScope.building_id,
        unit_id: resolvedScope.unit_id,
        fiscal_year: fiscalYear,
        period,
        budget_id: existingSnapshot.outputs.budget_id,
        status: existingSnapshot.outputs.status ?? "draft",
        line_items: existingSnapshot.outputs.line_items ?? lineItems,
        snapshot_id: existingSnapshot.id,
        reused_snapshot: true,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const newSnapshotId = await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: resolvedScope.property_id,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    inputs: snapshotPayload.inputs,
    outputs: snapshotPayload.outputs,
  });

  try {
    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      property_id: resolvedScope.property_id,
      entity_type: "computation_snapshots",
      entity_id: newSnapshotId ?? null,
      action: "budget_generated",
      actor_user_id: userId,
      source: "edge_function",
      severity: "info",
      metadata: {
        fiscal_year: fiscalYear,
        scope: resolvedScope.scope,
        scope_id: resolvedScope.scope_id,
        engine_type: "budget",
        engine_version: ENGINE_VERSION,
        snapshot_id: newSnapshotId ?? null,
        budget_id: budgetId,
        total_revenue: round2(totalRevenue),
        total_expenses: round2(totalExpenses),
        noi: noi,
      },
    });
  } catch (auditErr) {
    console.error("[compute-budget] audit_log insert error (budget_generated):", auditErr?.message || auditErr);
  }

  // ---------------------------------------------------------------
  // Response
  // ---------------------------------------------------------------
  return new Response(
    JSON.stringify({
      error: false,
      scope: resolvedScope.scope,
      scope_id: resolvedScope.scope_id,
      portfolio_id: resolvedScope.portfolio_id,
      property_id: resolvedScope.property_id,
      building_id: resolvedScope.building_id,
      unit_id: resolvedScope.unit_id,
      fiscal_year: fiscalYear,
      period,
      budget_id: budgetId,
      status: "draft",
      line_items: lineItems,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: approve / reject (shared status transition handler)
// =================================================================
async function handleStatusTransition(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedBudget: ResolvedBudget,
  requiredStatus: string | string[],
  newStatus: string,
  successMessage: string
) {
  const requiredStatuses = Array.isArray(requiredStatus) ? requiredStatus : [requiredStatus];
  const budget = resolvedBudget;
  const fiscalYear = budget.budget_year;

  if (!requiredStatuses.includes(budget.status)) {
    throw new Error(
      `Budget status must be ${requiredStatuses.map((s) => `'${s}'`).join(" or ")} to perform this action. Current status: '${budget.status}'`
    );
  }

  // Update status
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to update budget status: ${updateErr.message}`);
  }

  // Create audit log entry
  const auditAction = newStatus === "approved" ? "budget_approved" : "budget_rejected";
  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, budget, fiscalYear, auditAction, successMessage);

  const { data: latestSnapshot } = await applyBudgetSnapshotFilter(
    supabaseAdmin.from("computation_snapshots").select("id, outputs"),
    orgId,
    budget,
    fiscalYear,
  )
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: budget.property_id,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    inputs: {
      scope_level: budget.scope,
      scope_id: budget.scope_id,
      fiscal_year: fiscalYear,
      action: newStatus,
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "computation_snapshots"],
        source_snapshot_ids: {
          prior_budget_snapshot: latestSnapshot?.id ?? null,
        },
        trigger_type: "manual",
      },
    },
    outputs: {
      ...(latestSnapshot?.outputs ?? {}),
      budget_id: budget.id,
      status: newStatus,
      message: successMessage,
    },
  });

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      scope: budget.scope,
      scope_id: budget.scope_id,
      status: newStatus,
      message: successMessage,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: mark_reviewed
// =================================================================
async function handleMarkReviewed(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedBudget: ResolvedBudget,
) {
  const ALLOWED_FROM = ["draft", "ai_generated", "under_review"];
  const budget = resolvedBudget;
  const fiscalYear = budget.budget_year;

  if (!ALLOWED_FROM.includes(budget.status)) {
    throw new Error(
      `Budget status must be one of ${ALLOWED_FROM.map((s) => `'${s}'`).join(", ")} to mark as reviewed. Current status: '${budget.status}'`
    );
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: "reviewed",
      reviewed_at: now,
      reviewed_by: userId,
      updated_at: now,
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to mark budget as reviewed: ${updateErr.message}`);
  }

  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, budget, fiscalYear, "budget_marked_reviewed", "Budget marked as reviewed");

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      scope: budget.scope,
      scope_id: budget.scope_id,
      status: "reviewed",
      message: "Budget marked as reviewed",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: reject (rework)
// =================================================================
async function handleReject(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedBudget: ResolvedBudget,
  reason: string | null
) {
  const BLOCKED_FROM = ["approved", "locked", "signed"];
  const trimmedReason = (reason ?? "").trim();

  if (!trimmedReason) {
    throw new Error("A rejection reason is required");
  }

  const budget = resolvedBudget;
  const fiscalYear = budget.budget_year;

  if (BLOCKED_FROM.includes(budget.status)) {
    throw new Error(
      `Budget status '${budget.status}' cannot be rejected. Reject is blocked once a budget is approved, locked, or signed.`
    );
  }

  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: "draft",
      rejected_at: now,
      rejected_by: userId,
      rejection_comment: trimmedReason,
      updated_at: now,
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to reject budget: ${updateErr.message}`);
  }

  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, budget, fiscalYear, "budget_rejected", `Budget rejected and returned to draft: ${trimmedReason}`);

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      scope: budget.scope,
      scope_id: budget.scope_id,
      status: "draft",
      rejection_comment: trimmedReason,
      message: "Budget rejected and returned to draft",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Action: lock
// =================================================================
async function handleLock(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedBudget: ResolvedBudget,
) {
  const budget = resolvedBudget;
  const fiscalYear = budget.budget_year;

  if (budget.status !== "approved") {
    throw new Error(
      `Budget must be 'approved' to lock. Current status: '${budget.status}'`
    );
  }

  // Update status to locked
  const { error: updateErr } = await supabaseAdmin
    .from("budgets")
    .update({
      status: "locked",
      updated_at: new Date().toISOString(),
    })
    .eq("id", budget.id);

  if (updateErr) {
    throw new Error(`Failed to lock budget: ${updateErr.message}`);
  }

  // Create baseline snapshot for variance analysis
  const { data: latestSnapshot } = await applyBudgetSnapshotFilter(
    supabaseAdmin.from("computation_snapshots").select("id, outputs"),
    orgId,
    budget,
    fiscalYear,
  )
    .order("computed_at", { ascending: false })
    .limit(1);

  const baselineOutputs = latestSnapshot && latestSnapshot.length > 0
    ? latestSnapshot[0].outputs
    : {
        budget_id: budget.id,
        total_revenue: Number(budget.total_revenue),
        total_expenses: Number(budget.total_expenses),
      };

  const baselinePayload = {
    org_id: orgId,
    property_id: budget.property_id,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    inputs: {
      scope_level: budget.scope,
      scope_id: budget.scope_id,
      fiscal_year: fiscalYear,
      action: "lock",
      locked_at: new Date().toISOString(),
      locked_by: userId,
    },
    outputs: {
      ...baselineOutputs,
      baseline: true,
      status: "locked",
      locked_at: new Date().toISOString(),
    },
  };

  const lockTimestamp = new Date().toISOString();

  await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: budget.property_id,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    locked_at: lockTimestamp,
    locked_by: userId,
    inputs: {
      ...baselinePayload.inputs,
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "computation_snapshots"],
        source_snapshot_ids: {
          prior_budget_snapshot: latestSnapshot?.[0]?.id ?? null,
        },
        trigger_type: "manual",
      },
    },
    outputs: baselinePayload.outputs,
  });

  // Create audit log entry
  await createAuditLog(supabaseAdmin, orgId, userId, budget.id, budget, fiscalYear, "budget_locked", "Budget locked successfully");

  return new Response(
    JSON.stringify({
      error: false,
      budget_id: budget.id,
      scope: budget.scope,
      scope_id: budget.scope_id,
      status: "locked",
      message: "Budget locked successfully",
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

// =================================================================
// Helpers
// =================================================================

/**
 * Round a number to two decimal places.
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Create an audit log entry for budget status changes.
 */
async function createAuditLog(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  budgetId: string,
  resolvedBudget: ResolvedBudget,
  fiscalYear: number,
  auditAction: string,
  message: string
) {
  try {
    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      property_id: resolvedBudget.property_id,
      entity_type: "budget",
      entity_id: budgetId,
      action: auditAction,
      actor_user_id: userId,
      source: "edge_function",
      severity: "info",
      metadata: {
        scope: resolvedBudget.scope,
        scope_id: resolvedBudget.scope_id,
        fiscal_year: fiscalYear,
        message,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (auditErr) {
    console.error("[compute-budget] audit_log insert error:", auditErr?.message || auditErr);
  }
}

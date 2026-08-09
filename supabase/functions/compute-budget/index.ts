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
      // Phase 4B true stale-version protection & snapshot lineage validation
      expected_updated_at,
      approval_comment,
      expected_basis_snapshot_id,
      expected_cam_snapshot_id,
      expected_revenue_snapshot_id,
      // Phase 4A planning-source mode: explicit snapshot IDs from the UI's
      // BudgetPlanningPanel. When all three are supplied, compute-budget
      // assembles totals from these frozen snapshots instead of re-reading
      // the target fiscal year's raw expense/revenue tables (which normally
      // don't exist yet for a next-year planning budget).
      budget_basis_snapshot_id,
      budget_cam_estimate_snapshot_id,
      revenue_snapshot_id,
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

      // ---------------------------------------------------------------
      // Phase 4A planning-source mode: all three explicit snapshot IDs
      // are present → assemble from frozen planning snapshots, bypassing
      // the legacy target-year raw expense/revenue re-reads entirely.
      // ---------------------------------------------------------------
      const isPlanningMode = !!(budget_basis_snapshot_id && budget_cam_estimate_snapshot_id && revenue_snapshot_id);
      if (isPlanningMode) {
        return await handleGeneratePlanning(
          supabaseAdmin,
          orgId,
          user.id,
          resolvedScope,
          period,
          fiscal_year,
          budget_basis_snapshot_id,
          budget_cam_estimate_snapshot_id,
          revenue_snapshot_id,
          typeof ai_insights === "string" ? ai_insights : null,
        );
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
        // Phase 4B: Atomic Approve + Sign + Lock via transactional RPC
        return await handleApproveAndLock(
          supabaseAdmin,
          orgId,
          user.id,
          resolvedBudget,
          expected_updated_at ?? null,
          typeof approval_comment === "string" ? approval_comment : typeof reason === "string" ? reason : null,
          expected_basis_snapshot_id ?? null,
          expected_cam_snapshot_id ?? null,
          expected_revenue_snapshot_id ?? null,
        );
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

  // 2a. Base rent from leases with an approved abstract that overlaps this
  // fiscal year. `status` is a legacy column (draft/approved/rejected) —
  // it is never the approval signal. `abstract_status` is: it's set to
  // 'approved' together with status by approve_lease_workflow
  // (20260602170000_lease_approval_workflow.sql), but nothing in the
  // current pipeline ever writes status='active', so filtering on that
  // value silently excluded every real approved lease. start_date/end_date
  // remain the correct fields to read for the overlap math below — they're
  // kept in sync with commencement_date/expiration_date by the
  // sync_approved_lease_canonical_dates trigger on approval
  // (20269900000041_approved_lease_canonical_dates.sql), so no new date
  // field or fallback is needed here.
  let leaseQuery = supabaseAdmin
    .from("leases")
    .select("id, monthly_rent, start_date, end_date, abstract_status")
    .eq("property_id", propertyId)
    .eq("org_id", orgId)
    .eq("abstract_status", "approved");
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
// Action: approve (Phase 4B Atomic Approve + Sign + Lock)
// =================================================================
async function handleApproveAndLock(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedBudget: ResolvedBudget,
  expectedUpdatedAt: string | null,
  approvalComment: string | null,
  expectedBasisId: string | null,
  expectedCamId: string | null,
  expectedRevenueId: string | null,
) {
  const budget = resolvedBudget;

  // Execute single transactional SECURITY DEFINER RPC
  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc("approve_and_lock_budget", {
    p_budget_id: budget.id,
    p_org_id: orgId,
    p_user_id: userId,
    p_expected_updated_at: expectedUpdatedAt || budget.updated_at || null,
    p_approval_comment: approvalComment,
    p_expected_basis_snapshot_id: expectedBasisId,
    p_expected_cam_snapshot_id: expectedCamId,
    p_expected_revenue_snapshot_id: expectedRevenueId,
  });

  if (rpcErr) {
    throw new Error(rpcErr.message || "Failed to approve and lock budget");
  }

  return new Response(
    JSON.stringify(rpcResult),
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
// Action: generate (planning-source mode)
// =================================================================
/**
 * Phase 4A planning-source generate: assembles a draft budget entirely from
 * three pre-validated computation snapshots — Phase 3A expense basis,
 * Phase 3B CAM estimate, and the revenue engine snapshot — without re-reading
 * any target-year raw expense/revenue rows.
 *
 * Immutability: once persisted, the budget_line_items rows and the budgets
 * row reflect a frozen point-in-time view of the three planning snapshots.
 * Future re-runs that produce newer snapshots do NOT silently alter these
 * historical dollar amounts.
 */
async function handleGeneratePlanning(
  supabaseAdmin: any,
  orgId: string,
  userId: string,
  resolvedScope: ResolvedBudgetScope,
  period: "annual",
  fiscalYear: number,
  budgetBasisSnapshotId: string,
  budgetCamEstimateSnapshotId: string,
  revenueSnapshotId: string,
  aiInsights: string | null,
) {
  // Portfolio scope is not supported in planning mode for the same reason
  // it is blocked in legacy generate: no portfolio-level calculation engine.
  if (resolvedScope.scope === "portfolio") {
    throw new Error(
      "Portfolio-level planning budget generation is not supported. " +
      "Generate property/building/unit planning budgets individually.",
    );
  }

  const propertyId = resolvedScope.property_id;

  // ---------------------------------------------------------------
  // 1. Load + validate all three planning snapshots.
  //    Six server-side checks per snapshot (org, property, fiscal_year,
  //    status=completed, engine_type match) — all fail-closed.
  // ---------------------------------------------------------------
  async function loadAndValidateSnapshot(
    id: string,
    expectedEngineType: string,
    label: string,
  ): Promise<any> {
    const { data: snap, error } = await supabaseAdmin
      .from("computation_snapshots")
      .select("id, org_id, property_id, fiscal_year, status, engine_type, inputs, outputs, computed_at")
      .eq("id", id)
      .maybeSingle();
    if (error) throw new Error(`[planning] Failed to load ${label} snapshot: ${error.message}`);
    if (!snap) throw new Error(`[planning] ${label} snapshot not found: ${id}`);
    if (snap.org_id !== orgId)
      throw new Error(`[planning] ${label} snapshot belongs to a different organization.`);
    if (snap.property_id !== propertyId)
      throw new Error(`[planning] ${label} snapshot property_id does not match the requested property.`);
    if (Number(snap.fiscal_year) !== fiscalYear)
      throw new Error(`[planning] ${label} snapshot fiscal_year (${snap.fiscal_year}) does not match requested fiscal_year (${fiscalYear}).`);
    if (snap.status !== "completed")
      throw new Error(`[planning] ${label} snapshot status is "${snap.status}"; only completed snapshots may be used for planning budget assembly.`);
    if (snap.engine_type !== expectedEngineType)
      throw new Error(`[planning] ${label} snapshot engine_type is "${snap.engine_type}"; expected "${expectedEngineType}".`);
    return snap;
  }

  const [basisSnap, camEstSnap, revenueSnap] = await Promise.all([
    loadAndValidateSnapshot(budgetBasisSnapshotId, "budget_basis", "Expense Basis (Phase 3A)"),
    loadAndValidateSnapshot(budgetCamEstimateSnapshotId, "budget_cam_estimate", "CAM Estimate (Phase 3B)"),
    loadAndValidateSnapshot(revenueSnapshotId, "revenue", "Revenue"),
  ]);

  // ---------------------------------------------------------------
  // 2. Phase 3B lineage check: the CAM estimate must have been derived
  //    from exactly the same Phase 3A basis snapshot being used here.
  //    The budget_cam_estimate edge function already persists this id
  //    in both snapshotInputs and snapshotOutputs (verified by audit).
  // ---------------------------------------------------------------
  const recordedBasisId =
    camEstSnap.inputs?.budget_basis_snapshot_id ||
    camEstSnap.outputs?.budget_basis_snapshot_id;
  if (recordedBasisId && recordedBasisId !== budgetBasisSnapshotId) {
    throw new Error(
      `[planning] Lineage mismatch: the selected CAM Estimate snapshot was derived from ` +
      `expense basis snapshot "${recordedBasisId}", not from the selected basis snapshot ` +
      `"${budgetBasisSnapshotId}". Re-run Phase 3B using the selected Phase 3A basis before ` +
      `assembling a planning budget.`,
    );
  }

  // ---------------------------------------------------------------
  // 3. Extract authoritative planning totals from validated snapshots.
  //    compute-revenue includes a cam_recovery component built from
  //    posted actual CAM runs (confirmed by audit of compute-revenue
  //    lines 245-278). We MUST NOT use revenue_snapshot.annual_total
  //    or cam_recovery — those would double-count against Phase 3B.
  //    Use only base_rent + other_income from the revenue snapshot.
  // ---------------------------------------------------------------
  const basisOutputs = basisSnap.outputs ?? {};
  const camEstOutputs = camEstSnap.outputs ?? {};
  const revenueOutputs = revenueSnap.outputs ?? {};

  const baseRent = round2(Number(revenueOutputs.summary?.revenue_by_type?.base_rent ?? 0));
  const otherIncome = round2(Number(revenueOutputs.summary?.revenue_by_type?.other_income ?? 0));
  // Phase 3B estimated tenant recoveries — the sole CAM figure used here.
  const estimatedCamRecovery = round2(
    Number(camEstOutputs.property_summary?.estimated_tenant_recoveries ?? 0),
  );

  const totalRevenue = round2(baseRent + estimatedCamRecovery + otherIncome);

  // Phase 3A annual budget total — the sole expense figure used here.
  const totalExpenses = round2(Number(basisOutputs.totals?.annual_budget_total ?? 0));
  if (totalExpenses === 0 && (!basisOutputs.totals || basisOutputs.categories?.length === 0)) {
    throw new Error(
      "[planning] Phase 3A expense basis snapshot has no expense categories. " +
      "Re-run compute-budget-basis with historical expense data before generating a planning budget.",
    );
  }

  const noi = round2(totalRevenue - totalExpenses);

  // ---------------------------------------------------------------
  // 4. Reconciliation assertions — hard guards, not logged warnings.
  //    If any fails, no budget row is persisted.
  // ---------------------------------------------------------------
  const revenueLines: Record<string, number> = {
    base_rent: baseRent,
    cam_recovery: estimatedCamRecovery,
    other_income: otherIncome,
    total: totalRevenue,
  };

  // Per-category expense lines from Phase 3A
  const categoryExpenseLines: Record<string, number> = {};
  let categoryExpenseSum = 0;
  for (const cat of basisOutputs.categories ?? []) {
    const label = String(cat.category_label || cat.normalized_key || cat.expense_category_id || "other").toLowerCase();
    const amt = round2(Number(cat.annual_budget) || 0);
    categoryExpenseLines[label] = (categoryExpenseLines[label] || 0) + amt;
    categoryExpenseSum = round2(categoryExpenseSum + amt);
  }

  const revenueLineSum = round2(baseRent + estimatedCamRecovery + otherIncome);
  if (Math.abs(revenueLineSum - totalRevenue) > 0.02) {
    throw new Error(
      `[planning] Reconciliation failed: revenue line sum ($${revenueLineSum}) does not equal ` +
      `totalRevenue ($${totalRevenue}).`,
    );
  }
  if (Math.abs(categoryExpenseSum - totalExpenses) > 0.02) {
    throw new Error(
      `[planning] Reconciliation failed: sum of Phase 3A category annual budgets ` +
      `($${categoryExpenseSum}) does not equal basis totals.annual_budget_total ($${totalExpenses}).`,
    );
  }
  if (Math.abs(noi - (totalRevenue - totalExpenses)) > 0.01) {
    throw new Error(
      `[planning] Reconciliation failed: NOI ($${noi}) !== totalRevenue ($${totalRevenue}) - totalExpenses ($${totalExpenses}).`,
    );
  }

  // ---------------------------------------------------------------
  // 5. Fetch scope entity name for budget name label.
  // ---------------------------------------------------------------
  const { data: property } = await supabaseAdmin
    .from("properties")
    .select("name")
    .eq("id", propertyId)
    .eq("org_id", orgId)
    .single();
  let scopeEntityName = property?.name ?? propertyId;
  if (resolvedScope.scope === "building" && resolvedScope.building_id) {
    const { data: building } = await supabaseAdmin
      .from("buildings")
      .select("name")
      .eq("id", resolvedScope.building_id)
      .eq("org_id", orgId)
      .single();
    scopeEntityName = `${scopeEntityName} / ${building?.name ?? resolvedScope.building_id}`;
  } else if (resolvedScope.scope === "unit" && resolvedScope.unit_id) {
    const { data: unit } = await supabaseAdmin
      .from("units")
      .select("unit_number")
      .eq("id", resolvedScope.unit_id)
      .eq("org_id", orgId)
      .single();
    scopeEntityName = `${scopeEntityName} / Unit ${unit?.unit_number ?? resolvedScope.unit_id}`;
  }

  // ---------------------------------------------------------------
  // 6. Upsert budgets row with generation_method='planning'.
  //    A locked budget cannot be overwritten.
  // ---------------------------------------------------------------
  const { data: existingBudget } = await applyBudgetRowFilter(
    supabaseAdmin.from("budgets").select("id, status"),
    orgId,
    resolvedScope,
    fiscalYear,
  ).limit(1);
  if (existingBudget && existingBudget.length > 0 && existingBudget[0].status === "locked") {
    throw new Error("Cannot overwrite a locked budget. Create a new version instead.");
  }
  if (existingBudget && existingBudget.length > 0 && existingBudget[0].status === "approved") {
    throw new Error("Cannot overwrite an approved budget. Reject it first or lock and create a new version.");
  }

  const lineItems = {
    schema_version: BUDGET_LINE_ITEMS_SCHEMA_VERSION,
    revenue: revenueLines,
    expenses: { ...categoryExpenseLines, total: totalExpenses },
    noi,
  };

  const budgetName = `${scopeEntityName} - FY ${fiscalYear} Budget (Planning)`;
  const { data: upsertData, error: upsertErr } = await supabaseAdmin
    .from("budgets")
    .upsert({
      org_id: orgId,
      scope: resolvedScope.scope,
      scope_id: resolvedScope.scope_id,
      portfolio_id: resolvedScope.portfolio_id,
      property_id: resolvedScope.property_id,
      building_id: resolvedScope.building_id,
      unit_id: resolvedScope.unit_id,
      name: budgetName,
      budget_year: fiscalYear,
      total_revenue: totalRevenue,
      total_expenses: totalExpenses,
      noi,
      cam_total: estimatedCamRecovery,
      generation_method: "planning",
      period,
      status: "draft",
      updated_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      ...(aiInsights ? { ai_insights: aiInsights } : {}),
    }, { onConflict: "org_id,scope,scope_id,budget_year" })
    .select("id")
    .single();
  if (upsertErr) throw new Error(`[planning] Failed to save budget: ${upsertErr.message}`);
  const budgetId = upsertData.id;

  // ---------------------------------------------------------------
  // 7. Materialize frozen budget_line_items (expense lines from Phase 3A,
  //    revenue summary lines from revenue + Phase 3B snapshots).
  //    DELETE first so a re-generate does not accumulate stale rows.
  // ---------------------------------------------------------------
  const { error: delErr } = await supabaseAdmin
    .from("budget_line_items")
    .delete()
    .eq("budget_id", budgetId)
    .eq("org_id", orgId);
  if (delErr) {
    console.error("[planning] budget_line_items delete error (non-fatal):", delErr.message);
  }

  // Expense lines — one row per Phase 3A category
  const expenseLineRows = (basisOutputs.categories ?? []).map((cat: any, idx: number) => ({
    org_id: orgId,
    budget_id: budgetId,
    property_id: propertyId,
    building_id: resolvedScope.building_id ?? null,
    unit_id: resolvedScope.unit_id ?? null,
    lease_id: null,
    category: String(cat.category_label || cat.normalized_key || cat.expense_category_id || "other"),
    subcategory: cat.normalized_key ?? null,
    line_type: "expense",
    amount: round2(Number(cat.annual_budget) || 0),
    source_type: "planning_basis",
    source_snapshot_id: budgetBasisSnapshotId,
    notes: cat.source_basis_explanation ?? null,
    metadata: {
      expense_category_id: cat.expense_category_id ?? null,
      baseline_type: cat.baseline_type ?? null,
      prior_year_actual: cat.prior_year_actual ?? null,
      current_year_ytd_actual: cat.current_year_ytd_actual ?? null,
      current_year_forecast: cat.current_year_forecast ?? null,
      assumption: cat.assumption ?? null,
      override: cat.override ?? null,
    },
    sort_order: idx,
  }));

  // Revenue summary lines — three rows from revenue + Phase 3B snapshots
  const revLineRows = [
    {
      org_id: orgId,
      budget_id: budgetId,
      property_id: propertyId,
      building_id: resolvedScope.building_id ?? null,
      unit_id: resolvedScope.unit_id ?? null,
      lease_id: null,
      category: "base_rent",
      subcategory: null,
      line_type: "revenue",
      amount: baseRent,
      source_type: "planning_revenue",
      source_snapshot_id: revenueSnapshotId,
      notes: "Base rent from approved lease abstracts (non-CAM portion of revenue snapshot)",
      metadata: { revenue_snapshot_id: revenueSnapshotId },
      sort_order: 0,
    },
    {
      org_id: orgId,
      budget_id: budgetId,
      property_id: propertyId,
      building_id: resolvedScope.building_id ?? null,
      unit_id: resolvedScope.unit_id ?? null,
      lease_id: null,
      category: "cam_recovery",
      subcategory: null,
      line_type: "revenue",
      amount: estimatedCamRecovery,
      source_type: "planning_cam_estimate",
      source_snapshot_id: budgetCamEstimateSnapshotId,
      notes: "Estimated tenant CAM recoveries from Phase 3B planning engine",
      metadata: {
        budget_cam_estimate_snapshot_id: budgetCamEstimateSnapshotId,
        budget_basis_snapshot_id: budgetBasisSnapshotId,
        budgeted_recoverable_expense_basis: camEstOutputs.property_summary?.budgeted_recoverable_expense_basis ?? null,
        budgeted_operating_expenses: camEstOutputs.property_summary?.budgeted_operating_expenses ?? null,
        estimated_owner_nonrecoverable_share: camEstOutputs.property_summary?.estimated_owner_nonrecoverable_share ?? null,
      },
      sort_order: 1,
    },
    {
      org_id: orgId,
      budget_id: budgetId,
      property_id: propertyId,
      building_id: resolvedScope.building_id ?? null,
      unit_id: resolvedScope.unit_id ?? null,
      lease_id: null,
      category: "other_income",
      subcategory: null,
      line_type: "revenue",
      amount: otherIncome,
      source_type: "planning_revenue",
      source_snapshot_id: revenueSnapshotId,
      notes: "Other income from revenues table (revenue snapshot, non-base-rent / non-CAM)",
      metadata: { revenue_snapshot_id: revenueSnapshotId },
      sort_order: 2,
    },
  ];

  const allLineRows = [...revLineRows, ...expenseLineRows];
  if (allLineRows.length > 0) {
    const { error: lineErr } = await supabaseAdmin.from("budget_line_items").insert(allLineRows);
    if (lineErr) {
      console.error("[planning] budget_line_items insert error (non-fatal):", lineErr.message);
    }
  }

  // ---------------------------------------------------------------
  // 8. Save computation_snapshot with full planning lineage.
  // ---------------------------------------------------------------
  const newSnapshotId = await saveSnapshot(supabaseAdmin, {
    org_id: orgId,
    property_id: propertyId,
    engine_type: "budget",
    fiscal_year: fiscalYear,
    computed_by: userId,
    engine_version: ENGINE_VERSION,
    inputs: {
      scope_level: resolvedScope.scope,
      scope_id: resolvedScope.scope_id,
      fiscal_year: fiscalYear,
      period,
      generation_method: "planning",
      _compute: {
        page_scope: ["BudgetDashboard", "CreateBudget"],
        source_tables: ["budgets", "budget_line_items", "computation_snapshots"],
        source_snapshot_ids: {
          budget_basis: budgetBasisSnapshotId,
          budget_cam_estimate: budgetCamEstimateSnapshotId,
          revenue: revenueSnapshotId,
        },
        trigger_type: "manual",
      },
    },
    outputs: {
      budget_id: budgetId,
      status: "draft",
      generation_method: "planning",
      line_items: lineItems,
    },
  });

  // ---------------------------------------------------------------
  // 9. Audit log
  // ---------------------------------------------------------------
  try {
    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      property_id: propertyId,
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
        generation_method: "planning",
        snapshot_id: newSnapshotId ?? null,
        budget_id: budgetId,
        total_revenue: totalRevenue,
        total_expenses: totalExpenses,
        noi,
        source_snapshot_ids: {
          budget_basis: budgetBasisSnapshotId,
          budget_cam_estimate: budgetCamEstimateSnapshotId,
          revenue: revenueSnapshotId,
        },
      },
    });
  } catch (auditErr) {
    console.error("[planning] audit_log insert error:", auditErr?.message || auditErr);
  }

  return new Response(
    JSON.stringify({
      error: false,
      scope: resolvedScope.scope,
      scope_id: resolvedScope.scope_id,
      portfolio_id: resolvedScope.portfolio_id,
      property_id: propertyId,
      building_id: resolvedScope.building_id,
      unit_id: resolvedScope.unit_id,
      fiscal_year: fiscalYear,
      period,
      budget_id: budgetId,
      status: "draft",
      generation_method: "planning",
      line_items: lineItems,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
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

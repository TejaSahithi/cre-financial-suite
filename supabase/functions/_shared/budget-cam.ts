// @ts-nocheck
// Phase 3B — Next-Year Budget CAM Estimate (pure-ish assembly + summary; the
// actual calculation is delegated unmodified to the real CAM V2 engine).
//
// Architectural rule this file exists to satisfy: reuse CAM V2's policy/
// calculation semantics (pro-rata, effective-date segmentation, caps,
// floors, base year, expense stop, gross-up, admin fee, rounding) with a
// DIFFERENT cost source, instead of a second recovery-formula
// implementation. That's possible because runCamEngine (see
// orchestrator/run-cam-engine.ts) is a pure function of a plain in-memory
// CamRunInput object — it never queries the database and never checks
// where `published_expense_inputs`/`pool_assignments` rows actually came
// from (confirmed: pool-builder.ts's assembleSegmentAmounts only reads
// id/service_period_*/category/expense_category_id/variability/
// controllability off each input row, and takes its dollar amount from the
// paired PoolAssignmentInput.amount, never from cam_expense_inputs.amount
// directly, and never touches publication_status/fiscal_year/property_id/
// etc.). So this module builds a real CamRunInput the same way
// buildCamRunInputV2 does for actual CAM — reusing the SAME real, existing
// recovery_pools/recovery_pool_categories/recovery_pool_lease_participants/
// lease_recovery_policies/lease_premises/space_area_measurements rows,
// read-only — except the cost-source arrays are SYNTHETIC, built from a
// Phase 3A budget-basis snapshot's category lines instead of from
// cam_expense_inputs. cam_expense_inputs is never read here at all.
//
// Nothing here calls build_cam_run_input_snapshot_data (actual CAM's own
// assembly RPC) or evaluate_cam_readiness (actual CAM's own readiness
// gate) — both stay 100% untouched, and neither writes anything, so Actual
// CAM cannot be affected by this file no matter what it computes.
//
// Persistence: the CALLER persists the result via computation_snapshots
// (engine_type='budget_cam_estimate') — see compute-budget-cam-estimate/
// index.ts. Never cam_runs: that table's run_type/status CHECK constraints
// and its "one active standard run per period+scope" unique index describe
// an actual-CAM posting lifecycle with no planning-safe state, and a
// synthetic row there would occupy the slot a real run for the same
// period+scope needs (audited before writing this file).
import { runCamEngine } from "./cam-engine-v2/orchestrator/run-cam-engine.ts";
import { validateCamRunOutput } from "./cam-engine-v2/validation/output-validation.ts";
import { distributeMonthly } from "./budget-basis.ts";

export const BUDGET_CAM_ENGINE_TYPE = "budget_cam_estimate";
export const BUDGET_CAM_ENGINE_VERSION = "budget-cam-estimate.v1";

async function deterministicId(...parts: (string | number)[]): Promise<string> {
  const bytes = new TextEncoder().encode(parts.join("|"));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function round2(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export interface BuildBudgetCamParams {
  orgId: string;
  propertyId: string;
  buildingId?: string | null;
  scope: { scope_level: "property" | "building"; scope_id: string };
  fiscalYear: number;
  budgetBasisOutputs: { categories: any[] };
}

/**
 * Assembles a real CamRunInput for a future budget year, reusing the
 * property's EXISTING recovery pool/category configuration and lease
 * recovery policies (read-only, unmodified), with a synthetic cost source
 * built from Phase 3A budget-basis category lines instead of
 * cam_expense_inputs. No DB writes happen in this function.
 */
export async function buildBudgetCamRunInput(supabaseAdmin: any, params: BuildBudgetCamParams) {
  const { orgId, propertyId, buildingId = null, scope, fiscalYear, budgetBasisOutputs } = params;
  const fyStart = `${fiscalYear}-01-01`;
  const fyEnd = `${fiscalYear}-12-31`;

  // ---------------------------------------------------------------
  // 1. Reuse the property's EXISTING recovery pool/category
  //    configuration — the most recently ended non-template recovery
  //    period that has real pools configured, exactly as CAM Setup left
  //    it. No new recovery_periods/recovery_pools rows are created; the
  //    real ids are reused as-is inside the synthetic CamRunInput.
  // ---------------------------------------------------------------
  const { data: poolRows, error: poolErr } = await supabaseAdmin
    .from("recovery_pools")
    .select("*, recovery_pool_categories(*), recovery_pool_scope_members(*), recovery_periods(id, end_date)")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("is_template", false);
  if (poolErr) throw new Error(`Failed to fetch recovery_pools: ${poolErr.message}`);
  if (!poolRows || poolRows.length === 0) {
    throw new Error(
      "No recovery pools are configured for this property yet. Budget CAM reuses the property's existing CAM Setup pool/category configuration — set that up first (CAM Setup), the same configuration actual CAM already uses.",
    );
  }
  const latestPeriodEndDate = poolRows.reduce((latest: string | null, p: any) => {
    const end = p.recovery_periods?.end_date ?? null;
    return !latest || (end && end > latest) ? end : latest;
  }, null as string | null);
  const currentPools = poolRows.filter((p: any) => p.recovery_periods?.end_date === latestPeriodEndDate);
  const poolIds = currentPools.map((p: any) => p.id);

  const pools = currentPools.map((p: any) => ({
    id: p.id,
    org_id: p.org_id,
    period_id: p.period_id,
    is_template: p.is_template,
    property_id: p.property_id,
    name: p.name,
    pool_type: p.pool_type,
    scope_type: p.scope_type,
    scope_id: p.scope_id,
    currency: p.currency,
    status: p.status,
    default_gross_up_target_pct: p.default_gross_up_target_pct,
    categories: p.recovery_pool_categories ?? [],
    scope_members: p.recovery_pool_scope_members ?? [],
  }));

  // ---------------------------------------------------------------
  // 2. Reuse the property's existing pool participants (which lease may
  //    recover from which pool — a contractual fact that doesn't change
  //    between an actual run and a budget estimate for the same pools).
  // ---------------------------------------------------------------
  const { data: participants, error: partErr } = await supabaseAdmin
    .from("recovery_pool_lease_participants")
    .select("*")
    .eq("org_id", orgId)
    .in("pool_id", poolIds)
    .eq("status", "active");
  if (partErr) throw new Error(`Failed to fetch recovery_pool_lease_participants: ${partErr.message}`);

  // ---------------------------------------------------------------
  // 3. Future-year lease selection: approved abstract + date overlap
  //    against the TARGET fiscal year — the same canonical start_date/
  //    end_date behavior established in Phase 1 (compute-budget/
  //    compute-expense/budgetReadinessService.js), layered on top here
  //    because CAM's own actual-run assembly does not apply this check
  //    itself (confirmed by audit: it only requires an approved
  //    lease_recovery_policies row, no re-check of the lease's own
  //    abstract_status or term dates). status='active' is never used.
  // ---------------------------------------------------------------
  let leaseQuery = supabaseAdmin
    .from("leases")
    .select("id, tenant_name, square_footage, start_date, end_date, abstract_status, building_id")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("abstract_status", "approved");
  if (scope.scope_level === "building") leaseQuery = leaseQuery.eq("building_id", scope.scope_id);
  const { data: candidateLeases, error: leaseErr } = await leaseQuery;
  if (leaseErr) throw new Error(`Failed to fetch leases: ${leaseErr.message}`);

  const overlappingLeases = (candidateLeases ?? []).filter((l: any) => {
    if (!l.start_date) return false;
    const start = l.start_date;
    const end = l.end_date || fyEnd;
    return start <= fyEnd && end >= fyStart;
  });
  const leaseIds = overlappingLeases.map((l: any) => l.id);
  const leaseById = new Map(overlappingLeases.map((l: any) => [l.id, l]));

  // ---------------------------------------------------------------
  // 4. Reuse the property's existing, approved, materialized recovery
  //    policies for exactly these leases — never authored or altered
  //    here (Lease Recovery Policies are not redesigned by this phase).
  // ---------------------------------------------------------------
  let policies: any[] = [];
  if (leaseIds.length > 0) {
    const { data: policyRows, error: policyErr } = await supabaseAdmin
      .from("lease_recovery_policies")
      .select("*, lease_recovery_policy_steps(*)")
      .eq("org_id", orgId)
      .eq("status", "approved")
      .in("lease_id", leaseIds);
    if (policyErr) throw new Error(`Failed to fetch lease_recovery_policies: ${policyErr.message}`);
    policies = (policyRows ?? []).map((p: any) => ({
      ...p,
      steps: (p.lease_recovery_policy_steps ?? []).slice().sort((a: any, b: any) => (a.sequence ?? 0) - (b.sequence ?? 0)),
    }));
  }
  const leaseIdsWithPolicy = new Set(policies.map((p: any) => p.lease_id));

  // ---------------------------------------------------------------
  // 5. Premises/area for exactly the leases actually being run, mirroring
  //    the shape (and filter) actual CAM's own assembly uses.
  // ---------------------------------------------------------------
  let leaseContexts: any[] = [];
  if (leaseIds.length > 0) {
    const { data: premisesRows, error: premErr } = await supabaseAdmin
      .from("lease_premises")
      .select("*, lease_premises_spaces(*), lease_premises_area_periods(*)")
      .in("lease_id", leaseIds)
      .neq("status", "draft");
    if (premErr) throw new Error(`Failed to fetch lease_premises: ${premErr.message}`);
    const premisesByLease = new Map<string, any[]>();
    for (const row of premisesRows ?? []) {
      const shaped = {
        ...row,
        spaces: row.lease_premises_spaces ?? [],
        area_periods: row.lease_premises_area_periods ?? [],
      };
      if (!premisesByLease.has(row.lease_id)) premisesByLease.set(row.lease_id, []);
      premisesByLease.get(row.lease_id)!.push(shaped);
    }
    leaseContexts = leaseIds.map((id: string) => ({ id, premises: premisesByLease.get(id) ?? [] }));
  }

  // ---------------------------------------------------------------
  // 6. Area measurements / occupancy for the property and everything
  //    under it (same scope shape actual CAM's assembly uses).
  // ---------------------------------------------------------------
  const { data: buildings } = await supabaseAdmin.from("buildings").select("id").eq("org_id", orgId).eq("property_id", propertyId);
  const { data: units } = await supabaseAdmin.from("units").select("id").eq("org_id", orgId).eq("property_id", propertyId);
  const scopeIds = [propertyId, ...(buildings ?? []).map((b: any) => b.id), ...(units ?? []).map((u: any) => u.id)];

  const { data: areaMeasurements } = await supabaseAdmin.from("space_area_measurements").select("*").eq("org_id", orgId).in("scope_id", scopeIds);
  const { data: occupancyPeriods } = await supabaseAdmin.from("space_occupancy_periods").select("*").eq("org_id", orgId).in("scope_id", scopeIds);

  // ---------------------------------------------------------------
  // 7. THE SUBSTITUTION: synthetic cost source built from Phase 3A
  //    budget-basis category lines, never from cam_expense_inputs (never
  //    queried in this file at all). Each category maps to whichever
  //    real pool its expense_category_id is already configured under
  //    (recovery_pool_categories, reused as-is — inclusion/exclusion
  //    mode is left to the engine's own applyCategoryInclusionExclusion,
  //    so an excluded category still shows up as excluded_amount instead
  //    of vanishing). variability/controllability are read from that
  //    same pool-category row's *_default (the real automatic resolution
  //    path from Phase 2, reused here rather than reimplemented).
  //    Categories with NO matching pool at all never enter the engine —
  //    they are returned separately as unmapped_categories so the
  //    caller can still report them as owner/nonrecoverable cost,
  //    per the "never silently discarded" requirement.
  // ---------------------------------------------------------------
  const categoryToPool = new Map<string, { pool: any; categoryRow: any }>();
  for (const pool of pools) {
    for (const cat of pool.categories) {
      if (cat.expense_category_id && !categoryToPool.has(cat.expense_category_id)) {
        categoryToPool.set(cat.expense_category_id, { pool, categoryRow: cat });
      }
    }
  }

  const publishedExpenseInputs: any[] = [];
  const poolAssignments: any[] = [];
  const unmappedCategories: any[] = [];
  const mappedCategoryLines: any[] = [];

  for (const line of budgetBasisOutputs.categories ?? []) {
    const annualBudget = round2(line.annual_budget);
    if (!line.expense_category_id || annualBudget <= 0) {
      if (annualBudget > 0) {
        unmappedCategories.push({
          expense_category_id: line.expense_category_id,
          category_label: line.category_label,
          annual_budget: annualBudget,
          reason: !line.expense_category_id ? "unresolved_category" : "zero_amount",
        });
      }
      continue;
    }
    const match = categoryToPool.get(line.expense_category_id);
    if (!match) {
      unmappedCategories.push({
        expense_category_id: line.expense_category_id,
        category_label: line.category_label,
        annual_budget: annualBudget,
        reason: "no_pool_category_mapping",
      });
      continue;
    }

    const inputId = await deterministicId("budget-cam-input", orgId, propertyId, fiscalYear, line.expense_category_id);
    const assignmentId = await deterministicId("budget-cam-assignment", orgId, propertyId, fiscalYear, line.expense_category_id, match.pool.id);

    publishedExpenseInputs.push({
      id: inputId,
      amount: annualBudget,
      category: line.category_label,
      expense_category_id: line.expense_category_id,
      publication_status: "published",
      publication_version: 1,
      fiscal_year: fiscalYear,
      property_id: propertyId,
      building_id: buildingId,
      unit_id: null,
      lease_id: null,
      cam_input_type: "budget_estimate",
      variability: match.categoryRow.variability_default || "unknown",
      controllability: match.categoryRow.controllability_default || "unknown",
      service_period_start: fyStart,
      service_period_end: fyEnd,
    });
    poolAssignments.push({
      id: assignmentId,
      cam_expense_input_id: inputId,
      recovery_pool_id: match.pool.id,
      amount: annualBudget,
      percent_of_source: 100,
    });
    mappedCategoryLines.push({ ...line, pool_id: match.pool.id, pool_name: match.pool.name, cam_expense_input_id: inputId });
  }

  // ---------------------------------------------------------------
  // 8. Assemble the CamRunInput. recovery_period and run are in-memory
  //    only (no recovery_periods/cam_runs row created) — runCamEngine
  //    only reads their fields, it never requires them to be persisted.
  // ---------------------------------------------------------------
  const runId = await deterministicId("budget-cam-run", orgId, propertyId, fiscalYear, scope.scope_level, scope.scope_id);
  const recoveryPeriodId = await deterministicId("budget-cam-period", orgId, propertyId, fiscalYear);

  const camRunInput = {
    run: {
      id: runId,
      org_id: orgId,
      recovery_period_id: recoveryPeriodId,
      scope_type: scope.scope_level,
      scope_id: scope.scope_id,
      run_type: "preview",
      adjustment_of_run_id: null,
      restatement_of_run_id: null,
      engine_version: BUDGET_CAM_ENGINE_VERSION,
      currency: "USD",
      area_unit: "sqft",
      rounding_policy: {
        internal_decimal_places: 6,
        ledger_decimal_places: 2,
        annual_rounding_scope: "LEASE_POOL_PERIOD",
        estimate_rounding_scope: "LEASE_POOL_PERIOD",
        residual_allocation: "largest_remainder",
      },
      run_mode: "preview",
    },
    recovery_period: { id: recoveryPeriodId, org_id: orgId, calendar_id: null, start_date: fyStart, end_date: fyEnd, label: `FY${fiscalYear} Budget Plan`, status: "draft" },
    pools,
    published_expense_inputs: publishedExpenseInputs,
    pool_assignments: poolAssignments,
    pool_lease_participants: participants ?? [],
    leases: leaseContexts,
    area_measurements: areaMeasurements ?? [],
    occupancy_periods: occupancyPeriods ?? [],
    policies,
    estimate_schedules: [],
    prior_period_adjustments: [],
    prior_cam_history: [],
    base_year_snapshots: [],
    policy_materializer_versions: Object.fromEntries(policies.map((p: any) => [p.id, p.materializer_version])),
    readiness_at_snapshot_time: { note: "Phase 3B budget estimate — actual-CAM readiness gate not applicable to a planning run." },
  };

  return {
    input: camRunInput,
    unmappedCategories,
    mappedCategoryLines,
    leasesConsidered: overlappingLeases.map((l: any) => ({
      id: l.id,
      tenant_name: l.tenant_name,
      square_footage: l.square_footage,
      start_date: l.start_date,
      end_date: l.end_date,
      has_approved_policy: leaseIdsWithPolicy.has(l.id),
    })),
    sourcePoolIds: poolIds,
  };
}

/**
 * Post-processes a real runCamEngine output (unmodified engine, unmodified
 * math) into the property-summary + tenant-detail shape this phase
 * requires, plus the required reconciliation invariant checked inline.
 */
export function summarizeBudgetCamOutput(params: {
  output: any;
  leasesConsidered: any[];
  mappedCategoryLines: any[];
  unmappedCategories: any[];
}) {
  const { output, leasesConsidered, mappedCategoryLines, unmappedCategories } = params;
  const leaseById = new Map(leasesConsidered.map((l: any) => [l.id, l]));

  const budgetedOperatingExpenses = round2(
    mappedCategoryLines.reduce((s: number, c: any) => s + c.annual_budget, 0) +
      unmappedCategories.reduce((s: number, c: any) => s + c.annual_budget, 0),
  );
  const budgetedRecoverableExpenseBasis = round2(output.pool_results.reduce((s: number, p: any) => s + Number(p.actual_amount || 0), 0));
  const estimatedTenantRecoveries = round2(output.lease_results.reduce((s: number, l: any) => s + Number(l.final_recovery || 0), 0));

  const linesByLease = new Map<string, any[]>();
  for (const line of output.calculation_lines) {
    if (!line.lease_id) continue;
    if (!linesByLease.has(line.lease_id)) linesByLease.set(line.lease_id, []);
    linesByLease.get(line.lease_id)!.push(line);
  }

  // The engine's calculation_lines don't carry `category` on lease-level
  // lines (TENANT_SHARE/CAP/etc. — only pool-assembly lines might), so
  // category is derived from `pool_id` via the same mappedCategoryLines
  // this run's cost source was built from (pool_id -> category_label).
  const categoryLabelsByPool = new Map<string, string>();
  for (const line of mappedCategoryLines) {
    if (line.pool_id) categoryLabelsByPool.set(line.pool_id, line.category_label);
  }
  // Real line_type values emitted by run-cam-engine.ts's policy-step
  // formatting (verified against the engine source, not guessed):
  // TENANT_SHARE, CAP, FLOOR, BASE_YEAR, EXPENSE_STOP, DEDUCTIBLE,
  // GROSS_UP, CAPITAL_AMORTIZATION, DIRECT_ASSIGN, PRORATE, POOL_SOURCE,
  // RESIDUAL_ALLOCATION, ROUNDING_DETAIL, ESTIMATE_RECON.
  const ADJUSTMENT_LINE_TYPES = new Set(["CAP", "FLOOR", "BASE_YEAR", "EXPENSE_STOP", "DEDUCTIBLE", "GROSS_UP", "CAPITAL_AMORTIZATION"]);

  const tenantDetail = output.lease_results.map((lr: any) => {
    const lease = leaseById.get(lr.lease_id) ?? {};
    const lines = linesByLease.get(lr.lease_id) ?? [];
    const categories = [...new Set(lines.map((l: any) => (l.pool_id ? categoryLabelsByPool.get(l.pool_id) : null)).filter(Boolean))];
    const shareLine = lines.find((l: any) => l.line_type === "TENANT_SHARE" || l.line_type === "DIRECT_ASSIGN");
    const adjustments = lines
      .filter((l: any) => ADJUSTMENT_LINE_TYPES.has(l.line_type))
      .map((l: any) => ({
        line_type: l.line_type,
        formula_code: l.formula_code,
        category: l.pool_id ? categoryLabelsByPool.get(l.pool_id) ?? null : null,
        input_amount: l.input_amount,
        output_amount: l.output_amount,
        adjustment: l.adjustment,
        explanation: l.explanation,
      }));
    const annual = round2(lr.final_recovery);
    return {
      lease_id: lr.lease_id,
      tenant_name: lease.tenant_name ?? null,
      premises_area_sqft: lease.square_footage ?? null,
      recovery_categories: categories,
      recovery_method: shareLine?.formula_code ?? null,
      share_explanation: shareLine?.explanation ?? null,
      adjustments,
      annual_estimated_cam: annual,
      monthly_estimated_cam: distributeMonthly(annual),
      estimates_billed: round2(lr.estimates_billed),
      amount_due_credit: round2(lr.amount_due_credit),
    };
  });

  const estimatedOwnerNonrecoverableShare = round2(budgetedOperatingExpenses - estimatedTenantRecoveries);

  return {
    property_summary: {
      budgeted_operating_expenses: budgetedOperatingExpenses,
      budgeted_recoverable_expense_basis: budgetedRecoverableExpenseBasis,
      estimated_tenant_recoveries: estimatedTenantRecoveries,
      estimated_owner_nonrecoverable_share: estimatedOwnerNonrecoverableShare,
    },
    tenant_detail: tenantDetail,
    unmapped_categories: unmappedCategories,
    pool_results: output.pool_results,
    lease_results: output.lease_results,
    exceptions: output.exceptions,
  };
}

export { runCamEngine, validateCamRunOutput };

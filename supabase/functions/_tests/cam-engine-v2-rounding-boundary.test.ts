// CAM Enhancement and Budget Readiness Specification v2.0 — section 21.18
// (rounding) regression suite for the LEASE_POOL_PERIOD rounding boundary.
//
// AUTHORITATIVE RULE UNDER TEST
//   * High-precision values are preserved through every segment and policy
//     step. Cap, base-year, gross-up, share, fee and proration values are NOT
//     rounded between steps.
//   * Amounts aggregate at lease + recovery pool + recovery period.
//   * Ledger rounding happens ONCE, at that boundary.
//   * Largest-remainder allocation is used ONLY to distribute an
//     already-rounded authoritative total among its child lines.
//
// WHY THIS SUITE EXISTS
//   Residual allocation previously ran per MONTHLY SEGMENT: it rounded each
//   tenant's segment share to ledger precision and fed the rounded value into
//   the remaining base-year/cap/fee steps. Twelve segments meant twelve
//   injections of ledger rounding mid-calculation, and the errors compounded
//   into an annual drift (observed as +$0.07 across two tenants on the local
//   tie-out fixture). These tests pin the corrected behaviour.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import type { CamRunInput, CamRunHeader, CamExpenseInputRow, PoolAssignmentInput } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type {
  RecoveryPeriod, RecoveryPool, RecoveryPoolCategory, RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy, LeaseRecoveryPolicyStep, LeasePremises, LeasePremisesSpace, LeasePremisesAreaPeriod,
  SpaceAreaMeasurement, SpaceOccupancyPeriod,
} from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

let seq = 0;
const uid = (p: string) => `${p}-${++seq}`;
const money = (n: number) => Math.round(n * 100) / 100;

function runHeader(overrides: Partial<CamRunHeader> = {}): CamRunHeader {
  return {
    id: "run-round", org_id: "org-1", recovery_period_id: "period-1", scope_type: "property", scope_id: "prop-1",
    run_type: "standard", adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: "cam-engine-v2.0.0",
    currency: "USD", area_unit: "sqft",
    rounding_policy: {
      internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder",
      annual_rounding_scope: "LEASE_POOL_PERIOD", estimate_rounding_scope: "MONTH",
    },
    run_mode: "posting_eligible",
    ...overrides,
  };
}
function period(): RecoveryPeriod {
  return { id: "period-1", org_id: "org-1", calendar_id: "cal-1", start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026", status: "open", soft_closed_at: null, locked_at: null, created_at: "", updated_at: "" };
}
function categoryDef(poolId: string, categoryId: string, mode: "include" | "exclude" = "include"): RecoveryPoolCategory {
  return { id: uid("cat"), org_id: "org-1", pool_id: poolId, expense_category_id: categoryId, inclusion_mode: mode, variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" };
}
function pool(id: string, categories: RecoveryPoolCategory[], grossUpTargetPct: number | null = null): RecoveryPool & { categories: RecoveryPoolCategory[]; scope_members: never[] } {
  return {
    id, org_id: "org-1", period_id: "period-1", is_template: false, property_id: "prop-1", name: id,
    pool_type: "property", scope_type: "property", scope_id: null, currency: "USD", status: "active",
    default_gross_up_target_pct: grossUpTargetPct, created_at: "", updated_at: "", categories, scope_members: [],
  };
}
function expenseInput(id: string, amount: number, categoryId: string, variability: "fixed" | "variable" = "variable"): CamExpenseInputRow {
  return {
    id, amount, category: `label-for-${categoryId}`, expense_category_id: categoryId,
    publication_status: "published", publication_version: 1, fiscal_year: 2026,
    property_id: "prop-1", building_id: null, unit_id: null, lease_id: null, cam_input_type: "actual",
    variability, controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  };
}
function assignment(id: string, expenseId: string, poolId: string, amount: number): PoolAssignmentInput {
  return { id, cam_expense_input_id: expenseId, recovery_pool_id: poolId, amount, percent_of_source: null };
}
function areaMeasurement(sqft: number): SpaceAreaMeasurement {
  return {
    id: uid("area"), org_id: "org-1", scope_type: "property", scope_id: "prop-1", area_type: "rentable",
    standard: null, area_sqft: sqft, effective_from: "2026-01-01", effective_to: null, source_id: null, approved_at: null, approved_by: null,
    created_at: "", updated_at: "", source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  };
}
function occupancy(sqft: number): SpaceOccupancyPeriod {
  return {
    id: uid("occ"), org_id: "org-1", scope_type: "property", scope_id: "prop-1", lease_id: null,
    occupancy_status: "occupied", occupied_area_sqft: sqft, effective_from: "2026-01-01", effective_to: null,
    created_at: "", updated_at: "", source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  };
}
/** One lease, with `areaPeriods` describing its recovery area over time. */
function leaseCtx(leaseId: string, areaPeriods: Array<{ sqft: number; from: string; to: string | null }>) {
  const premisesId = uid("prem");
  const spaces: LeasePremisesSpace[] = [{ id: uid("space"), org_id: "org-1", lease_premises_id: premisesId, property_id: "prop-1", building_id: null, unit_id: null, allocation_weight: 1, created_at: "", updated_at: "" }];
  const periods: LeasePremisesAreaPeriod[] = areaPeriods.map((ap) => ({
    id: uid("ap"), org_id: "org-1", lease_premises_id: premisesId, area_basis: "rentable",
    contractual_area_sqft: ap.sqft, recovery_area_sqft: ap.sqft, effective_from: ap.from, effective_to: ap.to,
    created_at: "", updated_at: "", source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  } as LeasePremisesAreaPeriod));
  const premises: LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] } = {
    id: premisesId, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null,
    premises_type: "primary", effective_from: "2026-01-01", effective_to: null, status: "approved", notes: null,
    created_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    spaces, area_periods: periods,
  } as never;
  return { id: leaseId, premises: [premises] };
}
function participant(poolId: string, leaseId: string): RecoveryPoolLeaseParticipant {
  return { id: uid("pp"), org_id: "org-1", pool_id: poolId, lease_id: leaseId, effective_from: "2026-01-01", effective_to: null, source: "explicit", status: "active", created_by: null, approved_by: null, notes: null, created_at: "", updated_at: "" };
}
function policy(leaseId: string, steps: LeaseRecoveryPolicyStep[], id = uid("policy")): LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] } {
  return {
    id, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null,
    source_rule_set_id: null, source_rule_id: null, source_rule_updated_at: null, source_evidence: null,
    policy_type: "category_recovery", effective_from: "2026-01-01", effective_to: null, status: "approved",
    superseded_by_policy_id: null, approved_by: null, approved_at: null, notes: null, created_at: "", updated_at: "",
    source_rule_hash: null, source_approved_at: null, materializer_version: null, steps,
  } as never;
}
function step(type: string, categoryId: string, parameters: Record<string, unknown>, sequence: number): LeaseRecoveryPolicyStep {
  return { id: uid("step"), org_id: "org-1", policy_id: "p", sequence, step_type: type, expense_category_id: categoryId, pool_id: null, selector: null, parameters, source_evidence: null, created_at: "", updated_at: "" } as never;
}

/**
 * Three tenants with deliberately awkward areas (7,777 / 11,113 / 21,110 of
 * 100,000) so that every monthly share lands well away from a whole cent —
 * the shape that made per-segment rounding drift visible.
 */
function baseInput(opts: {
  areaPeriodsByLease?: Record<string, Array<{ sqft: number; from: string; to: string | null }>>;
  withPolicyExtras?: boolean;
  grossUpTargetPct?: number | null;
} = {}): CamRunInput {
  const CAT = "cat-operating";
  const areaPeriods = opts.areaPeriodsByLease ?? {
    "lease-1": [{ sqft: 7777, from: "2026-01-01", to: null }],
    "lease-2": [{ sqft: 11113, from: "2026-01-01", to: null }],
    "lease-3": [{ sqft: 21110, from: "2026-01-01", to: null }],
  };
  const p = pool("pool-1", [categoryDef("pool-1", CAT)], opts.grossUpTargetPct ?? null);
  const exp = expenseInput("exp-1", 123456.78, CAT, "variable");

  const policies = Object.keys(areaPeriods).map((leaseId) => {
    const steps: LeaseRecoveryPolicyStep[] = [step("CALCULATE_SHARE", CAT, { allocation_method: "pro_rata_share" }, 1)];
    if (opts.withPolicyExtras) {
      steps.push(step("APPLY_BASE_YEAR", CAT, { base_year: "2025", base_year_amount: 40000 }, 2));
      steps.push(step("APPLY_CAP", CAT, { cap_type: "fixed_dollar", cap_amount: 9999.99 }, 3));
      steps.push(step("ADD_ADMIN_FEE", CAT, { admin_fee_percent: 7.5 }, 4));
    }
    return policy(leaseId, steps);
  });

  return {
    run: runHeader(),
    recovery_period: period(),
    pools: [p],
    published_expense_inputs: [exp],
    pool_assignments: [assignment("a-1", "exp-1", "pool-1", 123456.78)],
    pool_lease_participants: Object.keys(areaPeriods).map((l) => participant("pool-1", l)),
    leases: Object.entries(areaPeriods).map(([leaseId, aps]) => leaseCtx(leaseId, aps)),
    area_measurements: [areaMeasurement(100000)],
    occupancy_periods: [occupancy(80000)],
    policies,
    estimate_schedules: [],
    prior_period_adjustments: [],
    prior_cam_history: [],
    base_year_snapshots: [],
    policy_materializer_versions: [],
    readiness_at_snapshot_time: null,
  } as never;
}

const totalFor = (out: Awaited<ReturnType<typeof runCamEngine>>) =>
  money(out.lease_results.reduce((s, r) => s + Number(r.final_recovery), 0));

// ---------------------------------------------------------------------------

Deno.test("rounding: every lease's rounded pool amounts sum exactly to the rounded pool authoritative total (no drift left to tolerate)", async () => {
  const out = await runCamEngine(baseInput());
  // Pool is fully allocated across the three tenants: 7,777 + 11,113 + 21,110
  // = 39,999 wait — only their own shares are recovered, the rest is vacant.
  // The invariant that must hold is that the SUM of the leases' rounded
  // amounts equals the ROUNDED sum of their unrounded amounts.
  const roundingLines = out.calculation_lines.filter((l) => l.line_type === "ROUNDING_DETAIL");
  assertEquals(roundingLines.length, 3);
  const unroundedSum = roundingLines.reduce((s, l) => s + Number(l.unrounded_aggregate ?? 0), 0);
  assertEquals(totalFor(out), money(unroundedSum));
});

Deno.test("rounding: splitting the year into more segments does not change annual recovery (economically identical area change)", async () => {
  // Same 7,777 sqft all year, but expressed as two adjacent area periods.
  // This forces an extra effective-date boundary — more segments, identical
  // economics. The annual result must be byte-identical.
  const single = await runCamEngine(baseInput());
  const split = await runCamEngine(baseInput({
    areaPeriodsByLease: {
      "lease-1": [
        { sqft: 7777, from: "2026-01-01", to: "2026-06-15" },
        { sqft: 7777, from: "2026-06-16", to: null },
      ],
      "lease-2": [{ sqft: 11113, from: "2026-01-01", to: null }],
      "lease-3": [{ sqft: 21110, from: "2026-01-01", to: null }],
    },
  }));
  assertEquals(split.lease_results, single.lease_results);
});

Deno.test("rounding: a mid-year split with policy steps (base year + cap + fee) does not accumulate intermediate-rounding drift", async () => {
  const single = await runCamEngine(baseInput({ withPolicyExtras: true }));
  const split = await runCamEngine(baseInput({
    withPolicyExtras: true,
    areaPeriodsByLease: {
      "lease-1": [
        { sqft: 7777, from: "2026-01-01", to: "2026-03-20" },
        { sqft: 7777, from: "2026-03-21", to: "2026-09-09" },
        { sqft: 7777, from: "2026-09-10", to: null },
      ],
      "lease-2": [{ sqft: 11113, from: "2026-01-01", to: null }],
      "lease-3": [{ sqft: 21110, from: "2026-01-01", to: null }],
    },
  }));
  // Three times as many segments for lease-1, through base-year, cap and fee
  // steps. If any step rounded between segments this would drift.
  assertEquals(split.lease_results, single.lease_results);
});

Deno.test("rounding: gross-up does not accumulate drift across segments", async () => {
  const single = await runCamEngine(baseInput({ grossUpTargetPct: 100 }));
  const split = await runCamEngine(baseInput({
    grossUpTargetPct: 100,
    areaPeriodsByLease: {
      "lease-1": [
        { sqft: 7777, from: "2026-01-01", to: "2026-07-04" },
        { sqft: 7777, from: "2026-07-05", to: null },
      ],
      "lease-2": [{ sqft: 11113, from: "2026-01-01", to: null }],
      "lease-3": [{ sqft: 21110, from: "2026-01-01", to: null }],
    },
  }));
  assertEquals(split.lease_results, single.lease_results);
  // And gross-up genuinely applied (80% occupancy -> 100% target = x1.25).
  const poolResult = single.pool_results[0];
  assertEquals(money(poolResult.adjusted_pool), money(123456.78 * 1.25));
});

Deno.test("rounding: repeated runs of identical input are deterministic, including residual allocation", async () => {
  const input = baseInput({ withPolicyExtras: true, grossUpTargetPct: 100 });
  const a = await runCamEngine(input);
  const b = await runCamEngine(input);
  const c = await runCamEngine(input);
  assertEquals(b.lease_results, a.lease_results);
  assertEquals(c.lease_results, a.lease_results);
  assertEquals(b.pool_results, a.pool_results);
  const residualOf = (o: typeof a) => o.calculation_lines.filter((l) => l.line_type === "RESIDUAL_ALLOCATION").map((l) => `${l.lease_id}|${l.adjustment}`);
  assertEquals(residualOf(b), residualOf(a));
  assertEquals(residualOf(c), residualOf(a));
});

Deno.test("rounding: intermediate policy-step lines are NOT rounded to ledger precision and disclose no boundary", async () => {
  const out = await runCamEngine(baseInput({ withPolicyExtras: true }));
  const intermediate = out.calculation_lines.filter((l) =>
    ["TENANT_SHARE", "BASE_YEAR", "CAP", "ADMIN_FEE"].includes(l.line_type)
  );
  assertEquals(intermediate.length > 0, true);
  for (const l of intermediate) {
    // No rounding disclosure: these lines never crossed a rounding boundary.
    assertEquals(l.rounding_scope ?? null, null);
    assertEquals(l.rounded_amount ?? null, null);
  }
  // At least one intermediate value must carry more than 2 decimals, which is
  // direct evidence that ledger rounding was not applied between steps.
  const hasHighPrecision = intermediate.some((l) => {
    const v = Number(l.output_amount ?? 0);
    return Math.abs(v - Math.round(v * 100) / 100) > 1e-9;
  });
  assertEquals(hasHighPrecision, true);
});

Deno.test("rounding: the ROUNDING_DETAIL line discloses raw value, boundary, rounded value, residual and the policy in force", async () => {
  const out = await runCamEngine(baseInput({ withPolicyExtras: true }));
  const detail = out.calculation_lines.find((l) => l.line_type === "ROUNDING_DETAIL");
  assertEquals(detail !== undefined, true);
  assertEquals(detail!.rounding_scope, "LEASE_POOL_PERIOD");
  assertEquals(typeof detail!.unrounded_aggregate, "number");
  assertEquals(typeof detail!.rounded_amount, "number");
  assertEquals(typeof detail!.rounding_residual, "number");
  assertEquals(detail!.rounding_policy?.ledger_decimal_places, 2);
  assertEquals(detail!.rounding_policy?.annual_rounding_scope, "LEASE_POOL_PERIOD");
  assertEquals(detail!.rounding_policy?.estimate_rounding_scope, "MONTH");
  assertEquals(detail!.rounding_policy?.residual_allocation, "largest_remainder");
  // The rounded amount is exactly the ledger-rounded raw aggregate plus the
  // disclosed residual — the line reconciles itself.
  assertEquals(money(Number(detail!.unrounded_aggregate) + Number(detail!.rounding_residual)), money(Number(detail!.rounded_amount)));
});

Deno.test("rounding: any residual allocation line covers the whole recovery period, never a single segment", async () => {
  const out = await runCamEngine(baseInput({ withPolicyExtras: true, grossUpTargetPct: 100 }));
  for (const l of out.calculation_lines.filter((l) => l.line_type === "RESIDUAL_ALLOCATION")) {
    assertEquals(l.segment_start, "2026-01-01");
    assertEquals(l.segment_end, "2026-12-31");
    assertEquals(l.rounding_scope, "LEASE_POOL_PERIOD");
    assertEquals(l.rounding_policy?.residual_allocation, "largest_remainder");
  }
});

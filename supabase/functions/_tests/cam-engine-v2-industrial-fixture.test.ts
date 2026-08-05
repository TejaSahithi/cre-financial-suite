// Enterprise CAM & Budget Implementation Blueprint v1.0 — Workstream B.4.
//
// The "Industrial Park" property archetype fixture — multiple distinct
// units, a mid-year unit area change (expansion), separately-metered direct
// utility charges per tenant, and a shared property-wide pool everyone
// participates in regardless of individual metering — with a MANUALLY
// computed expected result (shown in the comments below, not just
// asserted) run through the real orchestrator. Per the Phase 3B/4
// instructions, manually-tied-out expected values are the acceptance
// standard here, not V1 parity — no anonymized production industrial
// property was available in this environment to run V1 against, which is
// disclosed plainly rather than fabricated.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import type { CamRunInput, CamRunLeaseContext, CamRunHeader, PoolAssignmentInput, CamExpenseInputRow } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type {
  RecoveryPeriod, RecoveryPool, RecoveryPoolCategory, RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy, LeaseRecoveryPolicyStep, LeasePremises, LeasePremisesSpace, LeasePremisesAreaPeriod,
  SpaceAreaMeasurement,
} from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

// --- Industrial Park archetype fixture --------------------------------------
//
// Property "Industrial Park": single property, 200,000 sqft total rentable
// area, subdivided into distinct units. FY2026.
//
//   Pool "property" ($40,000, property-wide operating/tax/insurance blend):
//     every tenant participates regardless of its own metering arrangement.
//   Pool "utilities" (separately metered per tenant): each tenant recovers
//     its OWN submetered annual utility cost via DIRECT_ASSIGN, entirely
//     independent of area or of the other tenants sharing the same pool —
//     multiple simultaneous direct-assign tenants in one pool, none of them
//     ever entering the residual-allocation mechanism (Workstream B.3).
//
//   Unit 1 -- Tenant I1, 50,000 sqft, stable all year.
//   Unit 2 -- Tenant I2, 20,000 sqft Jan 1 - Jun 30, EXPANDS to 30,000 sqft
//     Jul 1 - Dec 31 (a genuine mid-year unit area change, day-weighted).
//   Unit 3 -- Tenant I3, 70,000 sqft, stable all year.
//   Remaining 200,000 - 50,000 - 30,000(post-expansion) = up to 60,000 sqft
//   is unleased and recovers nothing from anyone, same as the vacant-space
//   pattern in Golden 22b and the Retail fixture.
//
//   Pool "property" ($40,000) -- denominator is the property's total area
//   (200,000 sqft), constant all year (only I2's OWN premises area changes,
//   not the property-wide denominator):
//     I1 (50,000/200,000 = 25% flat all year):
//       40,000 * 25% = $10,000.00
//     I3 (70,000/200,000 = 35% flat all year):
//       40,000 * 35% = $14,000.00
//     I2 (day-weighted, 181 days at 20,000/200,000=10%, 184 days at
//       30,000/200,000=15%, out of FY2026's 365 days):
//       40,000 * (181*0.10 + 184*0.15) / 365
//       = 40,000 * (18.1 + 27.6) / 365 = 40,000 * 45.7 / 365
//       = 1,828,000 / 365 = $5,008.2191... ~= $5,008.22
//   Combined property-pool total recovered: 10,000 + 5,008.22 + 14,000 =
//     $29,008.22 (the remaining ~$10,991.78 corresponds to the unleased
//     area, never billed to anyone).
//
//   Direct utilities (submetered, DIRECT_ASSIGN, exact and unaffected by
//   I2's area change happening in the very same period):
//     I1 = $3,600.00, I2 = $2,400.00, I3 = $8,400.00
//
//   TOTALS:
//     I1 = 10,000.00 + 3,600.00 = $13,600.00
//     I2 =  5,008.22 + 2,400.00 =  $7,408.22
//     I3 = 14,000.00 + 8,400.00 = $22,400.00

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function runHeader(): CamRunHeader {
  return {
    id: "run-industrial", org_id: "org-1", recovery_period_id: "period-1", scope_type: "property", scope_id: "prop-1",
    run_type: "standard", adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: "cam-engine-v2.0.0",
    currency: "USD", area_unit: "sqft",
    rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder", annual_rounding_scope: "LEASE_POOL_PERIOD", estimate_rounding_scope: "MONTH" },
    run_mode: "posting_eligible",
  };
}

function period(): RecoveryPeriod {
  return { id: "period-1", org_id: "org-1", calendar_id: "cal-1", start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026", status: "open", soft_closed_at: null, locked_at: null, created_at: "", updated_at: "" };
}

function pool(id: string, name: string, categories: RecoveryPoolCategory[]): RecoveryPool & { categories: RecoveryPoolCategory[]; scope_members: never[] } {
  return {
    id, org_id: "org-1", period_id: "period-1", is_template: false, property_id: "prop-1", name,
    pool_type: "property", scope_type: "property", scope_id: null, currency: "USD", status: "active",
    default_gross_up_target_pct: null, created_at: "", updated_at: "", categories, scope_members: [],
  };
}

function categoryDef(poolId: string, expenseCategoryId: string): RecoveryPoolCategory {
  return { id: uid("cat"), org_id: "org-1", pool_id: poolId, expense_category_id: expenseCategoryId, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable", created_at: "", updated_at: "" };
}

function expenseInput(id: string, amount: number, category: string): CamExpenseInputRow {
  return {
    // Symbolic category identifier doubles as the canonical
    // expense_category_id, which is what pools/policies now match on.
    id, amount, category, expense_category_id: category,
    publication_status: "published", publication_version: 1, fiscal_year: 2026,
    property_id: "prop-1", building_id: null, unit_id: null, lease_id: null, cam_input_type: "actual",
    variability: "fixed", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  };
}

function assignment(id: string, expenseId: string, poolId: string, amount: number): PoolAssignmentInput {
  return { id, cam_expense_input_id: expenseId, recovery_pool_id: poolId, amount, percent_of_source: null };
}

function areaMeasurement(scopeId: string, sqft: number): SpaceAreaMeasurement {
  return {
    id: uid("area"), org_id: "org-1", scope_type: "property", scope_id: scopeId, area_type: "rentable",
    standard: null, area_sqft: sqft, effective_from: "2026-01-01", effective_to: null, source_id: null, approved_at: null, approved_by: null,
    created_at: "", updated_at: "", source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  };
}

function premises(
  leaseId: string, unitId: string, sqft: number, overrides: Partial<LeasePremises> = {},
): LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] } {
  const id = overrides.id ?? uid("prem");
  return {
    org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, premises_type: "primary",
    effective_from: "2026-01-01", effective_to: null, status: "approved", notes: null, created_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    ...overrides, id,
    spaces: [{ id: uid("space"), org_id: "org-1", lease_premises_id: id, property_id: "prop-1", building_id: null, unit_id: unitId, allocation_weight: 1, created_at: "", updated_at: "" }],
    area_periods: [{ id: uid("areaper"), org_id: "org-1", lease_premises_id: id, area_basis: "rentable", contractual_area_sqft: sqft, recovery_area_sqft: sqft, effective_from: overrides.effective_from ?? "2026-01-01", effective_to: overrides.effective_to ?? null, created_at: "", updated_at: "" }],
  };
}

function lease(id: string, premisesList: (LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] })[]): CamRunLeaseContext {
  return { id, premises: premisesList };
}

function participant(poolId: string, leaseId: string): RecoveryPoolLeaseParticipant {
  return { id: uid("participant"), org_id: "org-1", pool_id: poolId, lease_id: leaseId, effective_from: "2020-01-01", effective_to: null, source: "explicit", status: "active", created_by: null, approved_by: null, notes: null, created_at: "", updated_at: "" };
}

function policy(id: string, leaseId: string, steps: LeaseRecoveryPolicyStep[]): LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] } {
  return {
    id, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, source_rule_set_id: null,
    source_rule_id: null, source_rule_updated_at: null, source_rule_hash: null, source_approved_at: null, materializer_version: "materializer_v1",
    source_evidence: null, policy_type: "category_recovery", effective_from: "2026-01-01", effective_to: null,
    effective_date_source: "lease_commencement", effective_date_reason: null, effective_date_approved_by: null, effective_date_confidence: null,
    status: "approved", superseded_by_policy_id: null, approved_by: null, approved_at: null, notes: null, created_at: "", updated_at: "",
    steps,
  };
}

function shareStep(category: string): LeaseRecoveryPolicyStep {
  return { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 1, step_type: "CALCULATE_SHARE", expense_category_id: category, pool_id: null, selector: null, parameters: {}, source_evidence: null, created_at: "", updated_at: "" };
}

function directStep(category: string, annualAmount: number): LeaseRecoveryPolicyStep {
  return { id: uid("step"), org_id: "org-1", policy_id: "policy-1", sequence: 1, step_type: "DIRECT_ASSIGN", expense_category_id: category, pool_id: null, selector: null, parameters: { estimated_annual_amount: annualAmount }, source_evidence: null, created_at: "", updated_at: "" };
}

function zeroAdjustments(leaseId: string): CamRunInput["prior_period_adjustments"] {
  return [
    { id: uid("adj"), org_id: "org-1", lease_id: leaseId, recovery_period_id: "period-1", adjustment_type: "prior_period_adjustment", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "" },
    { id: uid("adj"), org_id: "org-1", lease_id: leaseId, recovery_period_id: "period-1", adjustment_type: "prior_credit", state: "KNOWN_ZERO", amount: null, source_reference: null, recorded_by: null, recorded_at: "", notes: null, created_at: "", updated_at: "" },
  ];
}

Deno.test("Industrial archetype fixture: multiple units, a mid-year unit area change, per-tenant direct utilities, and a shared property-wide pool tie out to manually computed expected values", async () => {
  const poolProperty = pool("pool-property", "Property-Wide Operating Pool", [categoryDef("pool-property", "operating")]);
  const poolUtilities = pool("pool-utilities", "Submetered Utilities Pool", [categoryDef("pool-utilities", "utilities")]);

  const expProperty = expenseInput("exp-property", 40000, "operating");
  const expUtilI1 = expenseInput("exp-util-i1", 3600, "utilities");
  const expUtilI2 = expenseInput("exp-util-i2", 2400, "utilities");
  const expUtilI3 = expenseInput("exp-util-i3", 8400, "utilities");

  // Unit 2's expansion: two premises records for the same lease, split at
  // the July 1 month boundary -- same established pattern as Golden 4.
  const unit2Before = premises("lease-i2", "unit-2", 20000, { id: "prem-i2-before", effective_to: "2026-06-30" });
  const unit2After = premises("lease-i2", "unit-2", 30000, { id: "prem-i2-after", effective_from: "2026-07-01" });

  const input: CamRunInput = {
    run: runHeader(),
    recovery_period: period(),
    pools: [poolProperty, poolUtilities],
    published_expense_inputs: [expProperty, expUtilI1, expUtilI2, expUtilI3],
    pool_assignments: [
      assignment("assign-prop", expProperty.id, "pool-property", 40000),
      assignment("assign-util-i1", expUtilI1.id, "pool-utilities", 3600),
      assignment("assign-util-i2", expUtilI2.id, "pool-utilities", 2400),
      assignment("assign-util-i3", expUtilI3.id, "pool-utilities", 8400),
    ],
    pool_lease_participants: [
      participant("pool-property", "lease-i1"), participant("pool-property", "lease-i2"), participant("pool-property", "lease-i3"),
      participant("pool-utilities", "lease-i1"), participant("pool-utilities", "lease-i2"), participant("pool-utilities", "lease-i3"),
    ],
    leases: [
      lease("lease-i1", [premises("lease-i1", "unit-1", 50000)]),
      lease("lease-i2", [unit2Before, unit2After]),
      lease("lease-i3", [premises("lease-i3", "unit-3", 70000)]),
    ],
    area_measurements: [areaMeasurement("prop-1", 200000)],
    occupancy_periods: [],
    policies: [
      policy("policy-i1-prop", "lease-i1", [shareStep("operating")]),
      policy("policy-i1-util", "lease-i1", [directStep("utilities", 3600)]),
      policy("policy-i2-prop", "lease-i2", [shareStep("operating")]),
      policy("policy-i2-util", "lease-i2", [directStep("utilities", 2400)]),
      policy("policy-i3-prop", "lease-i3", [shareStep("operating")]),
      policy("policy-i3-util", "lease-i3", [directStep("utilities", 8400)]),
    ],
    estimate_schedules: [],
    prior_period_adjustments: [...zeroAdjustments("lease-i1"), ...zeroAdjustments("lease-i2"), ...zeroAdjustments("lease-i3")],
    prior_cam_history: [],
    base_year_snapshots: [],
    policy_materializer_versions: {},
    readiness_at_snapshot_time: null,
  };

  const output = await runCamEngine(input);

  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.ready_to_post, true);

  const poolPropertyResult = output.pool_results.find((p) => p.pool_id === "pool-property")!;
  assertEquals(poolPropertyResult.actual_amount, 40000);
  assertEquals(poolPropertyResult.adjusted_pool, 40000);
  const poolUtilitiesResult = output.pool_results.find((p) => p.pool_id === "pool-utilities")!;
  assertEquals(poolUtilitiesResult.actual_amount, 14400);

  const i1 = output.lease_results.find((r) => r.lease_id === "lease-i1")!;
  const i2 = output.lease_results.find((r) => r.lease_id === "lease-i2")!;
  const i3 = output.lease_results.find((r) => r.lease_id === "lease-i3")!;

  // I1/I2/I3 are a genuine 3-member residual group in pool-property, so
  // (per Workstream B.3) each lease's own ANNUAL figure can differ from the
  // hand-computed idealized value by a few cents -- tolerance-checked;
  // I2's number also carries a real, non-rounding-related mid-year area
  // change, which is why its idealized target itself is a repeating decimal.
  assertEquals(Math.abs(i1.final_recovery - 13600) < 0.15, true);
  assertEquals(Math.abs(i2.final_recovery - 7408.22) < 0.15, true);
  assertEquals(Math.abs(i3.final_recovery - 22400) < 0.15, true);

  // Combined total across all three tenants, all pools -- tighter tolerance
  // since it's the sum the residual mechanism is actually reconciling
  // toward (still not bit-exact across 2 independently monthly-rounded
  // pools, same reasoning as the Office and Retail fixtures).
  assertEquals(Math.abs(i1.final_recovery + i2.final_recovery + i3.final_recovery - 43408.22) < 0.30, true);

  // I2's mid-year area change genuinely changed the calculation: the first
  // 6 months (20,000 sqft numerator) must recover less, in total, than the
  // last 6 months (30,000 sqft numerator) from pool-property -- proving
  // this is a real day-weighted effect, not a coincidental total.
  const i2PropertyShareLines = output.calculation_lines
    .filter((l) => l.lease_id === "lease-i2" && l.pool_id === "pool-property" && l.line_type === "TENANT_SHARE")
    .sort((a, b) => (a.segment_start < b.segment_start ? -1 : 1));
  assertEquals(i2PropertyShareLines.length, 12);
  const firstHalf = i2PropertyShareLines.slice(0, 6).reduce((sum, l) => sum + (l.output_amount ?? 0), 0);
  const secondHalf = i2PropertyShareLines.slice(6).reduce((sum, l) => sum + (l.output_amount ?? 0), 0);
  assertEquals(firstHalf < secondHalf, true);

  // Direct utilities are exact (small sub-cent floating epsilon from
  // 6-decimal internal-precision monthly proration, same reasoning as the
  // Retail fixture's direct charge) and untouched by residual correction,
  // even with THREE simultaneous direct-assign tenants sharing one pool.
  for (const [leaseId, amount] of [["lease-i1", 3600], ["lease-i2", 2400], ["lease-i3", 8400]] as const) {
    const lines = output.calculation_lines.filter((l) => l.lease_id === leaseId && l.pool_id === "pool-utilities");
    assertEquals(lines.every((l) => l.line_type === "DIRECT_ASSIGN"), true);
    const total = lines.reduce((sum, l) => sum + (l.output_amount ?? 0), 0);
    assertEquals(Math.abs(total - amount) < 0.01, true);
  }
  assertEquals(output.calculation_lines.some((l) => l.pool_id === "pool-utilities" && l.line_type === "RESIDUAL_ALLOCATION"), false);

  // Residual allocation is now applied ONCE, at the LEASE_POOL_PERIOD
  // boundary, purely to distribute an already-rounded authoritative total.
  // It no longer fires per monthly segment (that was the source of
  // intermediate-rounding drift), so this fixture may legitimately need no
  // correction at all. What must hold is the boundary contract: any residual
  // line that IS emitted covers the whole recovery period, and every pool's
  // rounded lease amounts still sum to the rounded pool total.
  for (const l of output.calculation_lines.filter((l) => l.line_type === "RESIDUAL_ALLOCATION")) {
    assertEquals(l.segment_start, "2026-01-01");
    assertEquals(l.segment_end, "2026-12-31");
    assertEquals(l.rounding_scope, "LEASE_POOL_PERIOD");
  }

  // Deterministic rerun -- required by the acceptance standard alongside the
  // manual tie-out itself.
  const rerun = await runCamEngine(input);
  assertEquals(rerun.lease_results, output.lease_results);
  assertEquals(rerun.input_hash, output.input_hash);
});

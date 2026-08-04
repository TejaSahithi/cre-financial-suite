// Enterprise CAM & Budget Implementation Blueprint v1.0 — Workstream B.4.
//
// The "Retail Plaza" property archetype fixture — operating CAM, taxes,
// insurance, and marketing pools; an anchor tenant excluded from the
// marketing pool (a real-world retail lease convention, not a bug); and a
// tenant-specific direct charge that bypasses pool math entirely — with a
// MANUALLY computed expected result (shown in the comments below, not just
// asserted) run through the real orchestrator. Per the Phase 3B/4
// instructions, manually-tied-out expected values are the acceptance
// standard here, not V1 parity — no anonymized production retail property
// was available in this environment to run V1 against, which is disclosed
// plainly rather than fabricated.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import type { CamRunInput, CamRunLeaseContext, CamRunHeader, PoolAssignmentInput, CamExpenseInputRow } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type {
  RecoveryPeriod, RecoveryPool, RecoveryPoolCategory, RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy, LeaseRecoveryPolicyStep, LeasePremises, LeasePremisesSpace, LeasePremisesAreaPeriod,
  SpaceAreaMeasurement,
} from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

// --- Retail Plaza archetype fixture -----------------------------------------
//
// Property "Retail Plaza": single building, 100,000 sqft total rentable
// area. FY2026. No gross-up, base year, or cap in this fixture — those are
// already covered by the Golden suite and the Office fixture; this fixture
// isolates the retail-specific concepts the audit called out by name.
//
//   Pool "operating" ($50,000), Pool "taxes" ($30,000), Pool "insurance"
//   ($9,000): all three are property-wide, no gross-up, and all three
//   tenants below participate in all three.
//   Pool "marketing" ($6,500): property-wide, but the anchor tenant has NO
//   participation grant in this pool at all (a real retail lease
//   convention: anchors commonly negotiate out of the merchant marketing
//   fund) — per Phase 3B decision 2, explicit participation is the only
//   authority, so the anchor recovers exactly $0 from this pool, not a
//   spatially-inferred share.
//   Pool "direct" ($600, pest control): a tenant-specific DIRECT_ASSIGN
//   charge for Tenant R2 only, entirely independent of area pro-rata.
//
//   Every pool's denominator is the property's total area (100,000 sqft),
//   not the sum of participating tenants' areas — established by Golden
//   22b/22c — so the 47,000 sqft that is neither the anchor's nor R1's nor
//   R2's premises (vacant / no lease on record) is simply never recovered
//   from anyone, the same way an unleased suite behaves in Golden 22b.
//
//   Anchor (40,000 sqft = 40% of 100,000):
//     Operating = 50,000 * 40% = 20,000.00
//     Taxes     = 30,000 * 40% = 12,000.00
//     Insurance =  9,000 * 40% =  3,600.00
//     Marketing = $0 (no participation grant — anchor exclusion)
//     TOTAL ANCHOR = 20,000 + 12,000 + 3,600 = $35,600.00
//
//   Tenant R1 (5,000 sqft = 5% of 100,000):
//     Operating = 50,000 * 5% = 2,500.00
//     Taxes     = 30,000 * 5% = 1,500.00
//     Insurance =  9,000 * 5% =   450.00
//     Marketing =  6,500 * 5% =   325.00
//     TOTAL R1 = 2,500 + 1,500 + 450 + 325 = $4,775.00
//
//   Tenant R2 (8,000 sqft = 8% of 100,000):
//     Operating = 50,000 * 8% = 4,000.00
//     Taxes     = 30,000 * 8% = 2,400.00
//     Insurance =  9,000 * 8% =   720.00
//     Marketing =  6,500 * 8% =   520.00
//     Direct pest control (DIRECT_ASSIGN, fixed) = $600.00
//     TOTAL R2 = 4,000 + 2,400 + 720 + 520 + 600 = $8,240.00
//
//   Grand total recovered (all 3 tenants, all categories) = 35,600 + 4,775
//   + 8,240 = $48,615.00. Cross-check: (operating+taxes+insurance) *
//   (40%+5%+8% participating) + marketing * (5%+8% participating) + direct
//   = 89,000*0.53 + 6,500*0.13 + 600 = 47,170 + 845 + 600 = $48,615.00. ✓

let seq = 0;
const uid = (prefix: string) => `${prefix}-${++seq}`;

function runHeader(): CamRunHeader {
  return {
    id: "run-retail", org_id: "org-1", recovery_period_id: "period-1", scope_type: "property", scope_id: "prop-1",
    run_type: "standard", adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: "cam-engine-v2.0.0",
    currency: "USD", area_unit: "sqft",
    rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder" },
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
    id, amount, category, publication_status: "published", publication_version: 1, fiscal_year: 2026,
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

function premises(leaseId: string, sqft: number): LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] } {
  const id = uid("prem");
  return {
    id, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, premises_type: "primary",
    effective_from: "2026-01-01", effective_to: null, status: "approved", notes: null, created_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
    spaces: [{ id: uid("space"), org_id: "org-1", lease_premises_id: id, property_id: "prop-1", building_id: null, unit_id: null, allocation_weight: 1, created_at: "", updated_at: "" }],
    area_periods: [{ id: uid("areaper"), org_id: "org-1", lease_premises_id: id, area_basis: "rentable", contractual_area_sqft: sqft, recovery_area_sqft: sqft, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "" }],
  };
}

function lease(id: string, sqft: number): CamRunLeaseContext {
  return { id, premises: [premises(id, sqft)] };
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

Deno.test("Retail archetype fixture: operating/taxes/insurance/marketing pools, anchor marketing exclusion, and a direct charge tie out to manually computed expected values", async () => {
  const poolOperating = pool("pool-operating", "Operating Pool", [categoryDef("pool-operating", "operating")]);
  const poolTaxes = pool("pool-taxes", "Taxes Pool", [categoryDef("pool-taxes", "taxes")]);
  const poolInsurance = pool("pool-insurance", "Insurance Pool", [categoryDef("pool-insurance", "insurance")]);
  const poolMarketing = pool("pool-marketing", "Marketing Pool", [categoryDef("pool-marketing", "marketing")]);
  const poolDirect = pool("pool-direct", "Direct Charges Pool", [categoryDef("pool-direct", "pest_control")]);

  const expOperating = expenseInput("exp-operating", 50000, "operating");
  const expTaxes = expenseInput("exp-taxes", 30000, "taxes");
  const expInsurance = expenseInput("exp-insurance", 9000, "insurance");
  const expMarketing = expenseInput("exp-marketing", 6500, "marketing");
  const expDirect = expenseInput("exp-direct", 600, "pest_control");

  const input: CamRunInput = {
    run: runHeader(),
    recovery_period: period(),
    pools: [poolOperating, poolTaxes, poolInsurance, poolMarketing, poolDirect],
    published_expense_inputs: [expOperating, expTaxes, expInsurance, expMarketing, expDirect],
    pool_assignments: [
      assignment("assign-op", expOperating.id, "pool-operating", 50000),
      assignment("assign-tax", expTaxes.id, "pool-taxes", 30000),
      assignment("assign-ins", expInsurance.id, "pool-insurance", 9000),
      assignment("assign-mkt", expMarketing.id, "pool-marketing", 6500),
      assignment("assign-dir", expDirect.id, "pool-direct", 600),
    ],
    pool_lease_participants: [
      participant("pool-operating", "lease-anchor"), participant("pool-operating", "lease-r1"), participant("pool-operating", "lease-r2"),
      participant("pool-taxes", "lease-anchor"), participant("pool-taxes", "lease-r1"), participant("pool-taxes", "lease-r2"),
      participant("pool-insurance", "lease-anchor"), participant("pool-insurance", "lease-r1"), participant("pool-insurance", "lease-r2"),
      // Anchor exclusion: NO participant grant for lease-anchor in pool-marketing.
      participant("pool-marketing", "lease-r1"), participant("pool-marketing", "lease-r2"),
      participant("pool-direct", "lease-r2"),
    ],
    leases: [lease("lease-anchor", 40000), lease("lease-r1", 5000), lease("lease-r2", 8000)],
    area_measurements: [areaMeasurement("prop-1", 100000)],
    occupancy_periods: [],
    policies: [
      policy("policy-anchor-op", "lease-anchor", [shareStep("operating")]),
      policy("policy-anchor-tax", "lease-anchor", [shareStep("taxes")]),
      policy("policy-anchor-ins", "lease-anchor", [shareStep("insurance")]),
      policy("policy-r1-op", "lease-r1", [shareStep("operating")]),
      policy("policy-r1-tax", "lease-r1", [shareStep("taxes")]),
      policy("policy-r1-ins", "lease-r1", [shareStep("insurance")]),
      policy("policy-r1-mkt", "lease-r1", [shareStep("marketing")]),
      policy("policy-r2-op", "lease-r2", [shareStep("operating")]),
      policy("policy-r2-tax", "lease-r2", [shareStep("taxes")]),
      policy("policy-r2-ins", "lease-r2", [shareStep("insurance")]),
      policy("policy-r2-mkt", "lease-r2", [shareStep("marketing")]),
      policy("policy-r2-direct", "lease-r2", [directStep("pest_control", 600)]),
    ],
    estimate_schedules: [],
    prior_period_adjustments: [...zeroAdjustments("lease-anchor"), ...zeroAdjustments("lease-r1"), ...zeroAdjustments("lease-r2")],
    prior_cam_history: [],
    base_year_snapshots: [],
    policy_materializer_versions: {},
    readiness_at_snapshot_time: null,
  };

  const output = await runCamEngine(input);

  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.ready_to_post, true);

  // Pool-level totals are exact -- no gross-up in this fixture, so
  // adjusted_pool must equal the raw published amount for every pool.
  for (const [poolId, amount] of [["pool-operating", 50000], ["pool-taxes", 30000], ["pool-insurance", 9000], ["pool-marketing", 6500], ["pool-direct", 600]] as const) {
    const poolResult = output.pool_results.find((p) => p.pool_id === poolId)!;
    assertEquals(poolResult.actual_amount, amount);
    assertEquals(poolResult.adjusted_pool, amount);
  }

  const anchor = output.lease_results.find((r) => r.lease_id === "lease-anchor")!;
  const r1 = output.lease_results.find((r) => r.lease_id === "lease-r1")!;
  const r2 = output.lease_results.find((r) => r.lease_id === "lease-r2")!;

  // Operating/taxes/insurance are each a genuine 3-member residual group
  // (anchor+r1+r2) and marketing a 2-member group (r1+r2) -- per Workstream
  // B.3, each lease's own ANNUAL figure can differ from the hand-computed
  // idealized value by a few cents (legitimate monthly ledger rounding),
  // so individual totals are tolerance-checked; the direct charge is exact.
  assertEquals(Math.abs(anchor.final_recovery - 35600) < 0.15, true);
  assertEquals(Math.abs(r1.final_recovery - 4775) < 0.15, true);
  assertEquals(Math.abs(r2.final_recovery - 8240) < 0.15, true);

  // Grand total across all three tenants, all categories -- tighter
  // tolerance since it's the sum the residual mechanism is actually
  // reconciling toward (still not bit-exact across 4 independently
  // monthly-rounded pools, same reasoning as the Office fixture).
  assertEquals(Math.abs(anchor.final_recovery + r1.final_recovery + r2.final_recovery - 48615) < 0.30, true);

  // Anchor exclusion is a genuine absence, not a coincidental zero: the
  // anchor must have NO calculation lines at all against pool-marketing.
  const anchorLines = output.calculation_lines.filter((l) => l.lease_id === "lease-anchor");
  assertEquals(anchorLines.some((l) => l.pool_id === "pool-marketing"), false);

  // The direct charge is exact and untouched by residual correction, even
  // though R2 also participates in three genuine multi-member residual
  // groups (operating/taxes/insurance) in the very same run.
  const r2DirectLines = output.calculation_lines.filter((l) => l.lease_id === "lease-r2" && l.pool_id === "pool-direct");
  assertEquals(r2DirectLines.every((l) => l.line_type === "DIRECT_ASSIGN"), true);
  // Summed from 12 internal-precision (6-decimal) monthly lines, each
  // day-weighted-prorated -- not ledger-rounded per line -- so the raw sum
  // carries a sub-cent floating-point epsilon even though it is otherwise
  // fully deterministic and untouched by residual correction; only the
  // final lease-level total (checked above via r2.final_recovery) is
  // ledger-rounded to the cent.
  const r2DirectTotal = r2DirectLines.reduce((sum, l) => sum + (l.output_amount ?? 0), 0);
  assertEquals(Math.abs(r2DirectTotal - 600) < 0.01, true);
  assertEquals(output.calculation_lines.some((l) => l.pool_id === "pool-direct" && l.line_type === "RESIDUAL_ALLOCATION"), false);

  // Residual allocation genuinely engaged across the shared pools at some
  // point in the year (not merely present in the code but never triggered
  // by this fixture's numbers).
  const sharedPoolIds = ["pool-operating", "pool-taxes", "pool-insurance", "pool-marketing"];
  assertEquals(sharedPoolIds.some((poolId) => output.calculation_lines.some((l) => l.pool_id === poolId && l.line_type === "RESIDUAL_ALLOCATION")), true);

  // Deterministic rerun -- required by the acceptance standard alongside the
  // manual tie-out itself.
  const rerun = await runCamEngine(input);
  assertEquals(rerun.lease_results, output.lease_results);
  assertEquals(rerun.input_hash, output.input_hash);
});

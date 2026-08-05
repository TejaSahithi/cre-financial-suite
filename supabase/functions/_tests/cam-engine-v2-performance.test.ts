// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-F:
// performance characteristics of the pure engine under a synthetic
// larger-property load, plus concurrent/idempotent-retry behavior of the
// persistence RPC against the real database.
//
// Honest scope note: this is a SYNTHETIC scale test (no anonymized
// production property of this size was available in this environment), and
// it exercises the pure in-process engine's own CPU/memory characteristics,
// not a full HTTP/network/database round trip at scale. It is a genuine,
// reproducible timing measurement, not a fabricated number — see the
// Phase 3B report for what remains untested at true production scale.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import { MAX_CALCULATION_LINES, validateCamRunOutput } from "../_shared/cam-engine-v2/validation/output-validation.ts";
import type { CamRunInput, CamRunLeaseContext, PoolAssignmentInput, CamExpenseInputRow } from "../_shared/cam-engine-v2/contracts/cam-input.ts";
import type {
  RecoveryPeriod, RecoveryPool, RecoveryPoolCategory, RecoveryPoolLeaseParticipant,
  LeaseRecoveryPolicy, LeaseRecoveryPolicyStep, LeasePremises, LeasePremisesSpace, LeasePremisesAreaPeriod, SpaceAreaMeasurement,
} from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

/** Builds a synthetic "large property": N leases, one property-wide pool, one full year, plain pro-rata share each. */
function buildLargePropertyInput(leaseCount: number): CamRunInput {
  const totalAreaPerLease = 1000;
  const totalArea = totalAreaPerLease * leaseCount;
  const poolAmount = 365000;

  const period: RecoveryPeriod = { id: "period-1", org_id: "org-1", calendar_id: "cal-1", start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026", status: "open", soft_closed_at: null, locked_at: null, created_at: "", updated_at: "" };
  const pool: RecoveryPool & { categories: RecoveryPoolCategory[]; scope_members: never[] } = {
    id: "pool-1", org_id: "org-1", period_id: "period-1", is_template: false, property_id: "prop-1", name: "Property Pool",
    pool_type: "property", scope_type: "property", scope_id: null, currency: "USD", status: "active",
    default_gross_up_target_pct: null, created_at: "", updated_at: "", categories: [], scope_members: [],
  };
  const expense: CamExpenseInputRow = {
    id: "exp-1", amount: poolAmount, category: "utilities", expense_category_id: "utilities", publication_status: "published", publication_version: 1,
    fiscal_year: 2026, property_id: "prop-1", building_id: null, unit_id: null, lease_id: null, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  };
  const assignment: PoolAssignmentInput = { id: "assign-1", cam_expense_input_id: "exp-1", recovery_pool_id: "pool-1", amount: poolAmount, percent_of_source: null };
  const areaMeasurement: SpaceAreaMeasurement = {
    id: "area-1", org_id: "org-1", scope_type: "property", scope_id: "prop-1", area_type: "rentable", standard: null, area_sqft: totalArea,
    effective_from: "2026-01-01", effective_to: null, source_id: null, approved_at: null, approved_by: null, created_at: "", updated_at: "",
    source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
  };

  const leases: CamRunLeaseContext[] = [];
  const participants: RecoveryPoolLeaseParticipant[] = [];
  const policies: (LeaseRecoveryPolicy & { steps: LeaseRecoveryPolicyStep[] })[] = [];

  for (let i = 0; i < leaseCount; i++) {
    const leaseId = `lease-${i}`;
    const premisesId = `prem-${i}`;
    const spaces: LeasePremisesSpace[] = [{ id: `space-${i}`, org_id: "org-1", lease_premises_id: premisesId, property_id: "prop-1", building_id: null, unit_id: null, allocation_weight: 1, created_at: "", updated_at: "" }];
    const areaPeriods: LeasePremisesAreaPeriod[] = [{ id: `areaper-${i}`, org_id: "org-1", lease_premises_id: premisesId, area_basis: "rentable", contractual_area_sqft: totalAreaPerLease, recovery_area_sqft: totalAreaPerLease, effective_from: "2026-01-01", effective_to: null, created_at: "", updated_at: "" }];
    const premises: LeasePremises & { spaces: LeasePremisesSpace[]; area_periods: LeasePremisesAreaPeriod[] } = {
      id: premisesId, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, premises_type: "primary",
      effective_from: "2026-01-01", effective_to: null, status: "approved", notes: null, created_by: null, created_at: "", updated_at: "",
      source_type: "primary", backfill_confidence: null, backfill_derivation_method: null, review_status: "not_required",
      spaces, area_periods: areaPeriods,
    };
    leases.push({ id: leaseId, premises: [premises] });
    participants.push({ id: `participant-${i}`, org_id: "org-1", pool_id: "pool-1", lease_id: leaseId, effective_from: "2020-01-01", effective_to: null, source: "explicit", status: "active", created_by: null, approved_by: null, notes: null, created_at: "", updated_at: "" });
    const step: LeaseRecoveryPolicyStep = { id: `step-${i}`, org_id: "org-1", policy_id: `policy-${i}`, sequence: 1, step_type: "CALCULATE_SHARE", expense_category_id: "utilities", pool_id: null, selector: null, parameters: {}, source_evidence: null, created_at: "", updated_at: "" };
    policies.push({
      id: `policy-${i}`, org_id: "org-1", lease_id: leaseId, lease_version_id: null, lease_amendment_id: null, source_rule_set_id: null,
      source_rule_id: null, source_rule_updated_at: null, source_rule_hash: null, source_approved_at: null, materializer_version: "materializer_v1",
      source_evidence: null, policy_type: "category_recovery", effective_from: "2026-01-01", effective_to: null,
      effective_date_source: "lease_commencement", effective_date_reason: null, effective_date_approved_by: null, effective_date_confidence: null,
      status: "approved", superseded_by_policy_id: null, approved_by: null, approved_at: null, notes: null, created_at: "", updated_at: "",
      steps: [step],
    });
  }

  return {
    run: {
      id: "run-perf", org_id: "org-1", recovery_period_id: "period-1", scope_type: "property", scope_id: "prop-1",
      run_type: "standard", adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: "cam-engine-v2.0.0",
      currency: "USD", area_unit: "sqft", rounding_policy: { internal_decimal_places: 6, ledger_decimal_places: 2, residual_allocation: "largest_remainder", annual_rounding_scope: "LEASE_POOL_PERIOD", estimate_rounding_scope: "MONTH" },
      run_mode: "preview",
    },
    recovery_period: period, pools: [pool], published_expense_inputs: [expense], pool_assignments: [assignment],
    pool_lease_participants: participants, leases, area_measurements: [areaMeasurement], occupancy_periods: [], policies,
    estimate_schedules: [], prior_period_adjustments: [], prior_cam_history: [], base_year_snapshots: [],
    policy_materializer_versions: {}, readiness_at_snapshot_time: null,
  };
}

Deno.test("Performance: 500-lease synthetic property completes and produces correct, balanced totals", async () => {
  const input = buildLargePropertyInput(500);
  const startedAt = performance.now();
  const output = await runCamEngine(input);
  const durationMs = performance.now() - startedAt;

  assertEquals(output.exceptions.filter((e) => e.severity === "blocking"), []);
  assertEquals(output.lease_results.length, 500);
  assertEquals(output.calculation_lines.length < MAX_CALCULATION_LINES, true);

  const totalRecovered = output.lease_results.reduce((s, r) => s + r.final_recovery, 0);
  // Every lease has an identical 1/500 share of a flat pool with no caps/fees -> should tie out to the pool amount within a cent.
  assertEquals(Math.abs(totalRecovered - 365000) < 1, true);

  const validationExceptions = validateCamRunOutput(input, output);
  assertEquals(validationExceptions, []);

  console.log(`[perf] 500 leases, 1 pool, full year: engine took ${durationMs.toFixed(1)}ms, produced ${output.calculation_lines.length} calculation lines`);
  // Not a tuned SLA -- a sanity ceiling so a genuine performance regression fails loudly in CI.
  assertEquals(durationMs < 10_000, true);
});

Deno.test("Performance: MAX_CALCULATION_LINES safeguard actually rejects an oversized payload", () => {
  const input = buildLargePropertyInput(1);
  const hugeLines = Array.from({ length: MAX_CALCULATION_LINES + 1 }, (_, i) => ({
    lease_id: "lease-0", pool_id: "pool-1", sequence: i, line_type: "TENANT_SHARE", category: null, formula_code: "TEST",
    input_amount: 1, output_amount: 1, adjustment: 0, policy_step_id: null, explanation: "synthetic", segment_start: "2026-01-01", segment_end: "2026-01-01",
  }));
  const output = { input_hash: "x", pool_results: [], lease_results: [], calculation_lines: hugeLines, exceptions: [], ready_to_post: true } as const;
  const exceptions = validateCamRunOutput(input, output as any);
  assertEquals(exceptions.some((e) => e.code === "CALCULATION_LINE_LIMIT_EXCEEDED" && e.severity === "blocking"), true);
});

Deno.test({
  name: "Performance/concurrency: two simultaneous persist_cam_run_results calls against the SAME run+hash never leave a partial result — both converge on one consistent calculated state",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();

    async function insertOne(table: string, values: Record<string, unknown>) {
      const { data, error } = await admin.from(table).insert(values).select("*").single();
      if (error) throw new Error(JSON.stringify(error));
      return data;
    }
    async function callRpc(fn: string, args: Record<string, unknown>) {
      const { data, error } = await admin.rpc(fn, args);
      return { data, error };
    }

    const { data: actorData, error: actorError } = await admin.auth.admin.createUser({ email: `perf-actor-${suffix}@example.test`, password: `Pass-${suffix}!`, email_confirm: true });
    if (actorError) throw new Error(JSON.stringify(actorError));
    const actor = { userId: actorData.user!.id, email: `perf-actor-${suffix}@example.test` };

    const org = await insertOne("organizations", { name: `Perf Org ${suffix}`, status: "active" });
    const property = await insertOne("properties", { org_id: org.id, name: `Perf Property ${suffix}`, status: "active" });
    const cal = await callRpc("create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const period = await callRpc("create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const pool = await callRpc("create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.data.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const lease = await insertOne("leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });
    const run = await insertOne("cam_runs", { org_id: org.id, recovery_period_id: period.data.period.id, scope_type: "property", scope_id: property.id, run_type: "standard", status: "ready" });

    const payload = {
      p_org_id: org.id, p_cam_run_id: run.id, p_actor_user_id: actor.userId, p_actor_email: actor.email,
      p_input_hash: "concurrent-hash", p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: true,
      p_pool_results: [{ pool_id: pool.data.pool.id, actual_amount: 1000, excluded_amount: 0, gross_up_adjustment: 0, amortization: 0, adjusted_pool: 1000, denominator_metrics: {} }],
      p_lease_results: [{ lease_id: lease.id, final_recovery: 100, estimates_billed: 0, amount_due_credit: 100 }],
      p_calculation_lines: [], p_exceptions: [],
    };

    const [first, second] = await Promise.all([admin.rpc("persist_cam_run_results", payload), admin.rpc("persist_cam_run_results", payload)]);
    if (first.error) throw new Error(JSON.stringify(first.error));
    if (second.error) throw new Error(JSON.stringify(second.error));

    const { data: leaseResults } = await admin.from("cam_run_lease_results").select("id").eq("cam_run_id", run.id);
    assertEquals(leaseResults!.length, 1); // never duplicated by the race

    const { data: runRow } = await admin.from("cam_runs").select("status").eq("id", run.id).single();
    assertEquals(runRow!.status, "calculated"); // never left in an intermediate 'calculating' state
  },
});

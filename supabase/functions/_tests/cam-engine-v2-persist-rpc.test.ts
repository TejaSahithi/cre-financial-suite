// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, step 14
// (transactional persistence) and step 16 (idempotent rerun) integration
// tests for the persist_cam_run_results RPC, against the real local
// database. Not the calculation engine itself (that's covered by
// cam-engine-v2-golden.test.ts) — this only verifies the RPC correctly
// writes an already-computed CamRunOutput into the ledger tables, respects
// the existing cam_runs status/immutability triggers, and is idempotent.
import { assertEquals, assertExists, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
}

function assertNoError(error: unknown) {
  if (error) throw new Error(JSON.stringify(error));
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

async function callRpc(admin: ReturnType<typeof adminClient>, fn: string, args: Record<string, unknown>) {
  const { data, error } = await admin.rpc(fn, args);
  return { data, error };
}

async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-persist-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

async function setUpRunFixture(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `CAM Persist Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Persist Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });
  const calResult = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(calResult.error);
  const periodResult = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: calResult.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(periodResult.error);
  const poolResult = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: periodResult.data.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(poolResult.error);
  const run = await insertOne(admin, "cam_runs", {
    org_id: org.id, recovery_period_id: periodResult.data.period.id, scope_type: "property", scope_id: property.id,
    run_type: "standard", status: "ready",
  });
  return { org, property, lease, period: periodResult.data.period, pool: poolResult.data.pool, run, actor };
}

function samplePayload(pool: { id: string }, lease: { id: string }) {
  const poolResults = [{ pool_id: pool.id, actual_amount: 1000, excluded_amount: 0, gross_up_adjustment: 0, amortization: 0, adjusted_pool: 1000, denominator_metrics: {} }];
  const leaseResults = [{ lease_id: lease.id, final_recovery: 100, estimates_billed: 0, amount_due_credit: 100 }];
  const calculationLines = [
    { lease_id: null, pool_id: pool.id, sequence: 1, line_type: "POOL_SOURCE", category: null, formula_code: "POOL_ASSEMBLY", input_amount: 1000, output_amount: 1000, adjustment: 0, policy_step_id: null, explanation: "test line" },
    { lease_id: lease.id, pool_id: null, sequence: 2, line_type: "TENANT_SHARE", category: null, formula_code: "AREA_PRO_RATA", input_amount: 1000, output_amount: 100, adjustment: -900, policy_step_id: null, explanation: "test line" },
  ];
  const exceptions = [{ severity: "info", code: "TEST_INFO", entity_type: "test", entity_id: null, message: "informational only" }];
  return { poolResults, leaseResults, calculationLines, exceptions };
}

Deno.test({
  name: "persist_cam_run_results: writes pool/lease results and calculation lines, resolving FKs, and transitions the run to calculated",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, pool, lease, run, actor } = await setUpRunFixture(admin, suffix);
    const { poolResults, leaseResults, calculationLines, exceptions } = samplePayload(pool, lease);

    const { data, error } = await admin.rpc("persist_cam_run_results", {
      p_org_id: org.id, p_cam_run_id: run.id, p_actor_user_id: actor.userId, p_actor_email: actor.email,
      p_input_hash: "hash-1", p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: true,
      p_pool_results: poolResults, p_lease_results: leaseResults, p_calculation_lines: calculationLines, p_exceptions: exceptions,
    });
    assertNoError(error);
    assertEquals(data.status, "calculated");
    assertEquals(data.pool_result_count, 1);
    assertEquals(data.lease_result_count, 1);
    assertEquals(data.calculation_line_count, 2);
    assertEquals(data.exception_count, 1);
    assertEquals(data.idempotent_rerun, false);

    const { data: runRow } = await admin.from("cam_runs").select("status, input_hash, engine_version").eq("id", run.id).single();
    assertEquals(runRow!.status, "calculated");
    assertEquals(runRow!.input_hash, "hash-1");

    const { data: lines } = await admin.from("cam_run_calculation_lines").select("lease_result_id, pool_result_id, line_type").eq("cam_run_id", run.id).order("sequence");
    assertEquals(lines!.length, 2);
    assertEquals(lines![0].pool_result_id !== null, true); // POOL_SOURCE line resolved to the pool result row
    assertEquals(lines![0].lease_result_id, null);
    assertEquals(lines![1].lease_result_id !== null, true); // TENANT_SHARE line resolved to the lease result row
  },
});

Deno.test({
  name: "persist_cam_run_results: readiness failure (ready_to_post=false) persists results but transitions the run to readiness_failed, not calculated",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, pool, lease, run, actor } = await setUpRunFixture(admin, suffix);
    const { poolResults, leaseResults, calculationLines, exceptions } = samplePayload(pool, lease);

    const { data, error } = await admin.rpc("persist_cam_run_results", {
      p_org_id: org.id, p_cam_run_id: run.id, p_actor_user_id: actor.userId, p_actor_email: actor.email,
      p_input_hash: "hash-2", p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: false,
      p_pool_results: poolResults, p_lease_results: leaseResults, p_calculation_lines: calculationLines, p_exceptions: exceptions,
    });
    assertNoError(error);
    assertEquals(data.status, "readiness_failed");
  },
});

Deno.test({
  name: "persist_cam_run_results: idempotent rerun — identical input_hash against an already-calculated run skips the rewrite",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, pool, lease, run, actor } = await setUpRunFixture(admin, suffix);
    const { poolResults, leaseResults, calculationLines, exceptions } = samplePayload(pool, lease);
    const args = {
      p_org_id: org.id, p_cam_run_id: run.id, p_actor_user_id: actor.userId, p_actor_email: actor.email,
      p_input_hash: "hash-stable", p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: true,
      p_pool_results: poolResults, p_lease_results: leaseResults, p_calculation_lines: calculationLines, p_exceptions: exceptions,
    };
    const first = await admin.rpc("persist_cam_run_results", args);
    assertNoError(first.error);
    assertEquals(first.data.idempotent_rerun, false);

    const second = await admin.rpc("persist_cam_run_results", args);
    assertNoError(second.error);
    assertEquals(second.data.idempotent_rerun, true);
    assertEquals(second.data.lease_result_count, first.data.lease_result_count);

    const { data: lines } = await admin.from("cam_run_calculation_lines").select("id").eq("cam_run_id", run.id);
    assertEquals(lines!.length, 2); // not duplicated by the second call
  },
});

Deno.test({
  name: "persist_cam_run_results: a changed input_hash against an already-calculated run triggers a real recalculation rewrite, not a skip",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, pool, lease, run, actor } = await setUpRunFixture(admin, suffix);
    const { poolResults, leaseResults, calculationLines, exceptions } = samplePayload(pool, lease);
    const baseArgs = {
      p_org_id: org.id, p_cam_run_id: run.id, p_actor_user_id: actor.userId, p_actor_email: actor.email,
      p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: true,
      p_pool_results: poolResults, p_lease_results: leaseResults, p_calculation_lines: calculationLines, p_exceptions: exceptions,
    };
    const first = await admin.rpc("persist_cam_run_results", { ...baseArgs, p_input_hash: "hash-a" });
    assertNoError(first.error);

    const revisedLeaseResults = [{ ...leaseResults[0], final_recovery: 500 }];
    const second = await admin.rpc("persist_cam_run_results", { ...baseArgs, p_input_hash: "hash-b", p_lease_results: revisedLeaseResults });
    assertNoError(second.error);
    assertEquals(second.data.idempotent_rerun, false);

    const { data: leaseRow } = await admin.from("cam_run_lease_results").select("final_recovery").eq("cam_run_id", run.id).single();
    assertEquals(Number(leaseRow!.final_recovery), 500);
  },
});

Deno.test({
  name: "persist_cam_run_results: a posted run rejects any further persistence attempt (immutability)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, pool, lease, run, actor } = await setUpRunFixture(admin, suffix);
    const { poolResults, leaseResults, calculationLines, exceptions } = samplePayload(pool, lease);
    const args = {
      p_org_id: org.id, p_cam_run_id: run.id, p_actor_user_id: actor.userId, p_actor_email: actor.email,
      p_input_hash: "hash-1", p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: true,
      p_pool_results: poolResults, p_lease_results: leaseResults, p_calculation_lines: calculationLines, p_exceptions: exceptions,
    };
    assertNoError((await admin.rpc("persist_cam_run_results", args)).error);

    // Walk the run through the real status graph to 'posted' (calculated -> under_review -> submitted -> approved -> posted).
    for (const status of ["under_review", "submitted", "approved", "posted"]) {
      const { error } = await admin.from("cam_runs").update({ status }).eq("id", run.id);
      assertNoError(error);
    }

    const { error } = await admin.rpc("persist_cam_run_results", { ...args, p_input_hash: "hash-after-posted" });
    assertExists(error);
    assertMatch(String((error as { message?: string }).message ?? ""), /immutable|terminal/i);
  },
});

Deno.test({
  name: "persist_cam_run_results: cross-organization run id is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffixA = crypto.randomUUID();
    const suffixB = crypto.randomUUID();
    const fixtureA = await setUpRunFixture(admin, suffixA);
    const fixtureB = await setUpRunFixture(admin, suffixB);
    const { poolResults, leaseResults, calculationLines, exceptions } = samplePayload(fixtureA.pool, fixtureA.lease);

    const { error } = await admin.rpc("persist_cam_run_results", {
      p_org_id: fixtureB.org.id, // wrong org for fixtureA's run
      p_cam_run_id: fixtureA.run.id, p_actor_user_id: fixtureA.actor.userId, p_actor_email: fixtureA.actor.email,
      p_input_hash: "hash-x", p_engine_version: "cam-engine-v2.0.0", p_ready_to_post: true,
      p_pool_results: poolResults, p_lease_results: leaseResults, p_calculation_lines: calculationLines, p_exceptions: exceptions,
    });
    assertExists(error);
    assertMatch(String((error as { message?: string }).message ?? ""), /not found/i);
  },
});

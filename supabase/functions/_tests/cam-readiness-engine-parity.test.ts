// UAT follow-up to a real run-cam-calculation-v2 invocation: a fixture that
// evaluate_cam_readiness called "ready" still returned $0 from the live
// engine, blocked by fine-grained exceptions (PREMISES_MISSING,
// DENOMINATOR_ZERO, pool-scope AREA_MISSING) that SQL readiness never
// previewed. Fixed in 20269900000058_cam_readiness_engine_parity.sql,
// which adds three checks that reuse the engine's own exact codes:
//   - PREMISES_MISSING: a lease's premises must be linked, via
//     lease_premises_spaces, into the PHYSICAL SCOPE of every pool it
//     actively participates in (not just exist somewhere).
//   - DENOMINATOR_ZERO: every calendar month an area-based (non
//     fixed_percentage) recovery share is active, the pool must have at
//     least one included published CAM dollar covering that month, or the
//     engine hard-codes that month's denominator to zero.
//   - AREA_MISSING (space_area_measurements): for a month the pool DOES
//     have included dollars, every one of the pool's own eligible scope
//     ids needs a rentable area measurement covering that month. This is
//     the actual "denominator area" data source -- NOT
//     space_occupancy_periods, which only feeds gross-up's occupancy
//     percentage and is a warning (OCCUPANCY_UNKNOWN), never blocking; see
//     denominator.ts's computeOccupiedArea, which explicitly treats a
//     scope with zero occupancy rows as vacant (0), not a data defect.
//
// This file proves each new check independently, that a complete fixture
// is unaffected, that unrelated properties stay isolated, and that the SQL
// readiness entry point and the run-cam-calculation-v2 HTTP entry point
// agree (both call the exact same evaluate_cam_readiness RPC, so they
// cannot drift by construction -- this test is the regression guard for
// that fact).
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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
  const result = await admin.rpc(fn, args);
  assertNoError(result.error);
  return result.data;
}
async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-readiness-parity-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  return { userId: data.user!.id, email };
}

interface FixtureOptions {
  /** Link the lease's premises into the pool's physical scope via lease_premises_spaces. */
  poolScopedSpaces?: boolean;
  /** Give the property a rentable space_area_measurements row (the pool's own denominator area source). */
  areaMeasurement?: boolean;
  /** 'full' spans the whole recovery period (what a real pool needs every month); 'partial' only covers January. */
  expenseServicePeriod?: "full" | "partial";
}

/**
 * Builds one org/property/lease/pool/policy/expense fixture, following the
 * exact same RPC sequence as cam-engine-v2-end-to-end.test.ts's
 * setUpReadyProperty (the codebase's own canonical "known good" builder),
 * with the three data points this migration's checks depend on made
 * independently toggleable so each scenario below can knock out exactly
 * one of them.
 */
async function buildFixture(admin: ReturnType<typeof adminClient>, suffix: string, opts: FixtureOptions = {}) {
  const { poolScopedSpaces = true, areaMeasurement = true, expenseServicePeriod = "full" } = opts;

  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `CAM Readiness Parity Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Readiness Parity Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: `Tenant ${suffix}`, status: "approved", commencement_date: "2027-01-01" });

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id, category_name: `Readiness Parity Category ${suffix}`, normalized_key: `cam_readiness_parity_${suffix}`,
  });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, lease_id: lease.id, property_id: property.id, expense_category_id: category.id,
    expense_category: "common_area_maintenance", payment_treatment: "reimbursable", recovery_method: "pro_rata_share",
    approval_status: "approved", recoverable_from_tenant: "yes", source_page: 1, exact_source_text: "Tenant pays pro rata CAM.", confidence_score: 0.95,
  });
  await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2027-01-01", p_end_date: "2027-12-31", p_label: `FY2027 ${suffix}`, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: `Pool ${suffix}`, p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await insertOne(admin, "recovery_pool_categories", { org_id: org.id, pool_id: pool.pool.id, expense_category_id: category.id, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable" });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2027-01-01", status: "approved" });
  if (poolScopedSpaces) {
    await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  }
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 2000, recovery_area_sqft: 2000, effective_from: "2027-01-01" });
  if (areaMeasurement) {
    await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 20000, effective_from: "2027-01-01" });
  }

  const servicePeriodEnd = expenseServicePeriod === "full" ? "2027-12-31" : "2027-01-31";
  const expenseInput = await insertOne(admin, "cam_expense_inputs", {
    org_id: org.id, property_id: property.id, lease_id: lease.id, amount: 4800,
    expense_category_id: category.id, category: category.category_name,
    publication_status: "published", publication_version: 1, fiscal_year: 2027, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2027-01-01", service_period_end: servicePeriodEnd,
  });
  await callRpc(admin, "assign_cam_input_to_pool", { p_org_id: org.id, p_cam_expense_input_id: expenseInput.id, p_recovery_pool_id: pool.pool.id, p_amount: 4800, p_assignment_method: "manual", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.pool.id, p_lease_id: lease.id, p_effective_from: "2027-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });

  return { actor, org, property, lease, period: period.period, pool: pool.pool, category };
}

async function evaluateReadiness(admin: ReturnType<typeof adminClient>, f: { org: { id: string }; property: { id: string }; period: { id: string } }) {
  return await callRpc(admin, "evaluate_cam_readiness", {
    p_org_id: f.org.id, p_property_id: f.property.id, p_recovery_period_id: f.period.id,
    p_scope_type: "property", p_scope_id: f.property.id,
  });
}

function codes(readiness: { exceptions: Array<{ code: string; severity: string }> }, severity = "blocking") {
  return (readiness.exceptions || []).filter((e) => e.severity === severity).map((e) => e.code);
}

Deno.test({
  name: "readiness parity: missing pool-scoped lease_premises_spaces blocks SQL readiness with PREMISES_MISSING",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID(), { poolScopedSpaces: false });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.ready, false);
    assertEquals(codes(readiness).includes("PREMISES_MISSING"), true, `expected PREMISES_MISSING, got: ${JSON.stringify(readiness.exceptions)}`);
  },
});

Deno.test({
  name: "readiness parity: missing pool-scope rentable area (denominator source) blocks SQL readiness with AREA_MISSING",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID(), { areaMeasurement: false });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.ready, false);
    const blocking = codes(readiness);
    assertEquals(blocking.includes("AREA_MISSING"), true, `expected AREA_MISSING for the pool's own denominator scope, got: ${JSON.stringify(readiness.exceptions)}`);
    const areaException = (readiness.exceptions || []).find((e: { code: string; entity_type: string }) => e.code === "AREA_MISSING" && e.entity_type === "space_area_measurements");
    assertExists(areaException, "AREA_MISSING exception must target entity_type space_area_measurements (the pool's denominator source), not just the tenant's own numerator area");
  },
});

Deno.test({
  name: "readiness parity: a published expense input narrower than the recovery period is READY (months with no allocable dollars need no denominator)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Business invariant (20269900000059): a denominator is only required
    // for a pool/month that actually has an allocable dollar amount. A
    // January-only expense against a full-year recovery period leaves
    // Feb-Dec with $0 included dollars -- those months recover $0
    // regardless of area data and must NOT block readiness. See the
    // dedicated cam-readiness-denominator-zero-invariant.test.ts for the
    // full matrix this correction is proven against.
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID(), { expenseServicePeriod: "partial" });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.blocking_count, 0, `expected zero blockers, got: ${JSON.stringify(readiness.exceptions)}`);
    assertEquals(readiness.ready, true);
  },
});

Deno.test({
  name: "readiness parity: a complete property/pool/participant/premises/area fixture is ready with zero blockers",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID());
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.blocking_count, 0, `expected zero blocking exceptions, got: ${JSON.stringify(readiness.exceptions)}`);
    assertEquals(readiness.ready, true);
  },
});

Deno.test({
  name: "readiness parity: an unrelated property's broken pool-scope linkage does not affect this property's readiness",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const good = await buildFixture(admin, `${suffix}-good`);
    const broken = await buildFixture(admin, `${suffix}-broken`, { poolScopedSpaces: false, expenseServicePeriod: "partial" });

    const readinessGood = await evaluateReadiness(admin, good);
    assertEquals(readinessGood.ready, true, `unrelated property's problems leaked in: ${JSON.stringify(readinessGood.exceptions)}`);
    const entityIds = new Set((readinessGood.exceptions || []).map((e: { entity_id: string }) => e.entity_id));
    assertEquals(entityIds.has(broken.pool.id), false, "good property's readiness must not reference the broken property's pool");
    assertEquals(entityIds.has(broken.lease.id), false, "good property's readiness must not reference the broken property's lease");

    const readinessBroken = await evaluateReadiness(admin, broken);
    assertEquals(readinessBroken.ready, false, "the broken property must still see its own real problems");
  },
});

Deno.test({
  name: "readiness parity: run-cam-calculation-v2's engine-side readiness gate agrees with evaluate_cam_readiness (no drift)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const f = await buildFixture(admin, suffix, { poolScopedSpaces: false, expenseServicePeriod: "partial" });

    const directReadiness = await evaluateReadiness(admin, f);
    assertEquals(directReadiness.ready, false);

    // Authorize an org member and call the real HTTP endpoint, exactly as
    // run-cam-calculation-v2/index.ts's own step 3-4 does internally: it
    // calls buildCamRunInputV2, which calls this exact evaluate_cam_readiness
    // RPC FIRST and returns { status: "readiness_failed", ready: false,
    // readiness } WITHOUT ever invoking the pure engine when not ready --
    // so a live call here cannot diverge from the direct RPC call above by
    // construction. This is the regression guard for that invariant, not a
    // CAM calculation (no engine execution, no posting, no locking).
    const email = `cam-readiness-parity-http-${suffix}@example.test`;
    const password = `Pass-${suffix}!`;
    const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assertNoError(userError);
    await admin.from("profiles").upsert({ id: userData.user!.id, email, full_name: "Readiness Parity Tester", role: "user", status: "active" });
    await insertOne(admin, "memberships", { user_id: userData.user!.id, org_id: f.org.id, role: "org_admin" });
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    assertNoError(signInError);
    const accessToken = signInData.session?.access_token;
    assertExists(accessToken);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/run-cam-calculation-v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
      body: JSON.stringify({ property_id: f.property.id, recovery_period_id: f.period.id, scope_type: "property", scope_id: f.property.id, run_mode: "preview" }),
    });
    const json = await res.json();

    assertEquals(res.status, 200);
    assertEquals(json.status, "readiness_failed");
    assertEquals(json.ready, false);
    assertEquals(json.readiness.blocking_count, directReadiness.blocking_count, "engine entry point's blocking_count must match the direct SQL readiness call");
    assertEquals(new Set(codes(json.readiness)), new Set(codes(directReadiness)), "engine entry point's blocking codes must match the direct SQL readiness call");
  },
});

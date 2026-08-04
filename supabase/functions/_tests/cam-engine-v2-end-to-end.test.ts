// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-D
// integration tests: the full database -> engine -> ledger path via real
// HTTP calls to run-cam-calculation-v2 (and build-cam-run-input-v2
// standalone), against the real local database. This is the "one real/
// anonymized property runs database-to-engine-to-ledger end to end"
// acceptance-gate item.
import { assertEquals, assertExists, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
  const { data, error } = await admin.rpc(fn, args);
  return { data, error };
}

async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-e2e-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

async function createOrgUserWithToken(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `cam-e2e-http-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);
  await admin.from("profiles").upsert({ id: userId, email, full_name: "CAM E2E HTTP Tester", role: "user", status: "active" });
  await insertOne(admin, "memberships", { user_id: userId, org_id: orgId, role });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);
  return { userId, accessToken };
}

async function callEdge(fn: string, accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Full setup: org, property, lease, recovery calendar/period/pool, approved rule, materialized policy, published+assigned expense, explicit participation, KNOWN_ZERO prior adjustments. */
async function setUpReadyProperty(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `CAM E2E Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM E2E Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });

  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
    approval_status: "approved", source_page: 1, exact_source_text: "Tenant pays pro rata CAM.", confidence_score: 0.95,
    recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });

  const materialized = await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(materialized.error);

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(cal.error);
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(period.error);
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Property Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.data.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(pool.error);
  // Readiness (evaluate_cam_readiness POOL_CATEGORY_MISSING check) requires
  // an EXPLICIT recovery_pool_categories mapping for every category an
  // approved policy uses -- distinct from the engine's own "empty
  // categories = open pool" behavior, which is a separate, more permissive
  // concern (pool assembly, not readiness). No RPC exists for this yet;
  // insert directly as service role.
  await insertOne(admin, "recovery_pool_categories", { org_id: org.id, pool_id: pool.data.pool.id, expense_category_id: category.id, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable" });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
  await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 10000, recovery_area_sqft: 10000, effective_from: "2026-01-01" });
  await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 100000, effective_from: "2026-01-01" });

  const expenseInput = await insertOne(admin, "cam_expense_inputs", {
    org_id: org.id, property_id: property.id, lease_id: lease.id, amount: 12000, category: category.id,
    publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  });
  const assignResult = await callRpc(admin, "assign_cam_input_to_pool", { p_org_id: org.id, p_cam_expense_input_id: expenseInput.id, p_recovery_pool_id: pool.data.pool.id, p_amount: 12000, p_assignment_method: "manual", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(assignResult.error);

  const participantResult = await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.data.pool.id, p_lease_id: lease.id, p_effective_from: "2026-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(participantResult.error);

  for (const adjType of ["prior_period_adjustment", "prior_credit"]) {
    const adjResult = await callRpc(admin, "record_cam_prior_period_adjustment", {
      p_org_id: org.id, p_lease_id: lease.id, p_recovery_period_id: period.data.period.id, p_adjustment_type: adjType,
      p_state: "KNOWN_ZERO", p_actor_user_id: actor.userId, p_actor_email: actor.email,
    });
    assertNoError(adjResult.error);
  }

  return { actor, org, property, lease, period: period.data.period, pool: pool.data.pool, rule, category };
}

Deno.test({
  name: "run-cam-calculation-v2: full database -> engine -> ledger path for a real property, end to end",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpReadyProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const { status, json } = await callEdge("run-cam-calculation-v2", accessToken, {
      property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id,
      run_type: "standard", run_mode: "posting_eligible",
    });

    assertEquals(status, 200);
    assertEquals(json.status, "calculated");
    assertEquals(json.ready_to_post, true);
    assertEquals(json.pool_result_count, 1);
    assertEquals(json.lease_result_count, 1);
    assertEquals(json.calculation_line_count > 0, true);
    // 10% share (10000/100000) of the $12000 pool = $1200
    assertEquals(json.lease_results_summary[0].final_recovery, 1200);

    // Verify the ledger tables were actually populated, not just the response.
    const { data: leaseResults } = await admin.from("cam_run_lease_results").select("final_recovery, lease_id").eq("cam_run_id", json.run_id);
    assertEquals(leaseResults!.length, 1);
    assertEquals(Number(leaseResults![0].final_recovery), 1200);

    const { data: lines } = await admin.from("cam_run_calculation_lines").select("id").eq("cam_run_id", json.run_id);
    assertEquals(lines!.length > 0, true);

    const { data: runRow } = await admin.from("cam_runs").select("status, input_hash, engine_version").eq("id", json.run_id).single();
    assertEquals(runRow!.status, "calculated");
    assertExists(runRow!.input_hash);
    assertEquals(runRow!.engine_version, "cam-engine-v2.0.0");
  },
});

Deno.test({
  name: "run-cam-calculation-v2: idempotent retry — calling again with unchanged data skips the rewrite",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpReadyProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");
    const args = { property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id, run_type: "standard", run_mode: "posting_eligible" };

    const first = await callEdge("run-cam-calculation-v2", accessToken, args);
    assertEquals(first.status, 200);
    assertEquals(first.json.idempotent_rerun, false);

    const second = await callEdge("run-cam-calculation-v2", accessToken, args);
    assertEquals(second.status, 200);
    assertEquals(second.json.run_id, first.json.run_id);
    assertEquals(second.json.idempotent_rerun, true);
    assertEquals(second.json.input_hash, first.json.input_hash);
  },
});

Deno.test({
  name: "run-cam-calculation-v2: a blocking readiness failure (unassigned expense) transitions the run to readiness_failed without ever calling the engine",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `CAM E2E NotReady Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM E2E NotReady Property ${suffix}`, status: "active" });
    const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    assertNoError(cal.error);
    const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
    assertNoError(period.error);
    // Deliberately: no pools, no policies, nothing published -- readiness must fail.

    const { accessToken } = await createOrgUserWithToken(admin, suffix, org.id, "org_admin");
    const { status, json } = await callEdge("run-cam-calculation-v2", accessToken, {
      property_id: property.id, recovery_period_id: period.data.period.id, scope_type: "property", scope_id: property.id, run_type: "standard",
    });

    assertEquals(status, 200);
    assertEquals(json.status, "readiness_failed");
    assertEquals(json.ready, false);

    const { data: runRow } = await admin.from("cam_runs").select("status").eq("id", json.run_id).single();
    assertEquals(runRow!.status, "readiness_failed");
    // No ledger rows should exist for a run that never reached the engine.
    const { data: lines } = await admin.from("cam_run_calculation_lines").select("id").eq("cam_run_id", json.run_id);
    assertEquals(lines!.length, 0);
  },
});

Deno.test({
  name: "run-cam-calculation-v2: cross-organization property access is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpReadyProperty(admin, suffix);
    const otherOrg = await insertOne(admin, "organizations", { name: `CAM E2E Other Org ${suffix}`, status: "active" });
    const { accessToken } = await createOrgUserWithToken(admin, `${suffix}-other`, otherOrg.id, "org_admin");

    const { status, json } = await callEdge("run-cam-calculation-v2", accessToken, {
      property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id, run_type: "standard",
    });
    assertEquals(status >= 400, true);
    assertExists(json.error);
  },
});

Deno.test({
  name: "build-cam-run-input-v2: standalone preview call returns the exact CamRunInput shape with a stable input_hash",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpReadyProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const draft = await callRpc(admin, "get_or_create_draft_cam_run", {
      p_org_id: setup.org.id, p_recovery_period_id: setup.period.id, p_scope_type: "property", p_scope_id: setup.property.id,
      p_run_type: "preview", p_actor_user_id: setup.actor.userId, p_actor_email: setup.actor.email,
    });
    assertNoError(draft.error);

    const { status, json } = await callEdge("build-cam-run-input-v2", accessToken, {
      property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id,
      cam_run_id: draft.data.run.id,
    });

    assertEquals(status, 200);
    assertEquals(json.ready, true);
    assertEquals(json.snapshot_built, true);
    assertExists(json.input_hash);
    assertMatch(json.input_hash, /^[0-9a-f]{64}$/);
    assertEquals(json.input.pools.length, 1);
    assertEquals(json.input.leases.length, 1);
    assertEquals(json.input.published_expense_inputs.length, 1);
    assertEquals(json.input.pool_lease_participants.length, 1);

    const { data: markers } = await admin.from("cam_run_input_snapshots").select("id").eq("cam_run_id", draft.data.run.id);
    assertEquals(markers!.length > 0, true);
  },
});

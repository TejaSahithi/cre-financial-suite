// Enterprise CAM & Budget — CAM Setup UX pass: regression tests for the
// three confirmed-broken cam-setup-actions-v2 actions (wrong RPC parameter
// name, an invalid status value, a mismatched upsert conflict target) plus
// the new bulk-estimate action, against the real local database.
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
  return admin.rpc(fn, args);
}
async function createOrgUserWithToken(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `cam-setup-fixes-http-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);
  await admin.from("profiles").upsert({ id: userId, email, full_name: "Setup Fixes HTTP Tester", role: "user", status: "active" });
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

async function setUpMinimalProperty(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = { userId: (await admin.auth.admin.createUser({ email: `cam-setup-fixes-actor-${suffix}@example.test`, password: `Pass-${suffix}!`, email_confirm: true })).data.user!.id, email: `cam-setup-fixes-actor-${suffix}@example.test` };
  const org = await insertOne(admin, "organizations", { name: `Setup Fixes Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Setup Fixes Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(cal.error);
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(period.error);
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Property Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.data.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(pool.error);
  const participant = await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.data.pool.id, p_lease_id: lease.id, p_effective_from: "2026-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(participant.error);

  return { org, property, lease, pool: pool.data.pool, period: period.data.period, participant: participant.data.participant };
}

Deno.test({
  name: "resolve_missing_policy_value: no longer fails with an unknown parameter error (p_notes fix)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const { status, json } = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "resolve_missing_policy_value", lease_id: setup.lease.id, recovery_period_id: setup.period.id,
      adjustment_type: "prior_period_adjustment", state: "KNOWN_ZERO", evidence_note: "Confirmed with prior manager -- no carryover balance.",
    });
    assertEquals(status, 200);
    assertExists(json.adjustment);

    const { data: rows } = await admin.from("cam_prior_period_adjustments").select("state, notes").eq("lease_id", setup.lease.id);
    assertEquals(rows!.length, 1);
    assertEquals(rows![0].state, "KNOWN_ZERO");
    assertEquals(rows![0].notes, "Confirmed with prior manager -- no carryover balance.");
  },
});

Deno.test({
  name: "remove_pool_participant: requires a reason, sets status=ended (not the invalid 'removed'), and records the reason",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const noReason = await callEdge("cam-setup-actions-v2", accessToken, { action: "remove_pool_participant", participant_id: setup.participant.id });
    assertEquals(noReason.status, 400);

    const { status } = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "remove_pool_participant", participant_id: setup.participant.id, reason: "Tenant vacated early, confirmed via amendment.",
    });
    assertEquals(status, 200);

    const { data: row } = await admin.from("recovery_pool_lease_participants").select("status, effective_to, notes").eq("id", setup.participant.id).single();
    assertEquals(row!.status, "ended");
    assertExists(row!.effective_to);
    assertEquals(row!.notes, "Tenant vacated early, confirmed via amendment.");
  },
});

Deno.test({
  name: "assign_scope_member: upsert no longer fails (no matching unique constraint bug) and re-invoking updates in place",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");
    const building = await insertOne(admin, "buildings", { org_id: setup.org.id, property_id: setup.property.id, name: "Building A" });

    const first = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "assign_scope_member", pool_id: setup.pool.id, scope_type: "building", scope_id: building.id, effective_from: "2026-01-01",
    });
    assertEquals(first.status, 200);
    assertExists(first.json.scope_member);

    const second = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "assign_scope_member", pool_id: setup.pool.id, scope_type: "building", scope_id: building.id, effective_from: "2026-02-01", include_in_denominator: false,
    });
    assertEquals(second.status, 200);
    assertEquals(second.json.scope_member.id, first.json.scope_member.id);

    const { data: rows } = await admin.from("recovery_pool_scope_members").select("id").eq("pool_id", setup.pool.id).eq("scope_id", building.id);
    assertEquals(rows!.length, 1);
  },
});

Deno.test({
  name: "create_estimate_schedules_bulk: generates every monthly row in one call and is idempotent on rerun",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const rows = [
      { month_date: "2026-01-01", amount: 500 }, { month_date: "2026-02-01", amount: 500 }, { month_date: "2026-03-01", amount: 500 },
      { month_date: "2026-04-01", amount: 550 }, { month_date: "2026-05-01", amount: 550 },
    ];
    const { status, json } = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "create_estimate_schedules_bulk", lease_id: setup.lease.id, recovery_period_id: setup.period.id, rows, reason: "Two effective ranges: $500 Jan-Mar, $550 Apr-May",
    });
    assertEquals(status, 200);
    assertEquals(json.count, 5);

    const { data: dbRows } = await admin.from("cam_estimate_schedules").select("month_date, amount").eq("lease_id", setup.lease.id).order("month_date");
    assertEquals(dbRows!.length, 5);
    assertEquals(Number(dbRows![0].amount), 500);
    assertEquals(Number(dbRows![3].amount), 550);

    // Rerun with one amount changed -- upsert updates in place, no duplicates.
    const rerun = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "create_estimate_schedules_bulk", lease_id: setup.lease.id, recovery_period_id: setup.period.id,
      rows: [{ month_date: "2026-01-01", amount: 600 }],
    });
    assertEquals(rerun.status, 200);
    const { data: afterRerun } = await admin.from("cam_estimate_schedules").select("amount").eq("lease_id", setup.lease.id).eq("month_date", "2026-01-01").single();
    assertEquals(Number(afterRerun!.amount), 600);
    const { data: countCheck } = await admin.from("cam_estimate_schedules").select("id").eq("lease_id", setup.lease.id);
    assertEquals(countCheck!.length, 5);
  },
});

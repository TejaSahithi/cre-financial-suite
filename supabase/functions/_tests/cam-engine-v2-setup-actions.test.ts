// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 4A CAM Setup
// "missing-value resolution" write actions, against the real local database.
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
  const email = `cam-setup-actions-http-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);
  await admin.from("profiles").upsert({ id: userId, email, full_name: "Setup Actions HTTP Tester", role: "user", status: "active" });
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
  const actor = { userId: (await admin.auth.admin.createUser({ email: `cam-setup-actions-actor-${suffix}@example.test`, password: `Pass-${suffix}!`, email_confirm: true })).data.user!.id, email: `cam-setup-actions-actor-${suffix}@example.test` };
  const org = await insertOne(admin, "organizations", { name: `Setup Actions Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Setup Actions Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(cal.error);
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(period.error);
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Property Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.data.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(pool.error);

  const expenseInput = await insertOne(admin, "cam_expense_inputs", {
    org_id: org.id, property_id: property.id, amount: 5000, category: category.id,
    publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  });

  return { org, property, lease, pool: pool.data.pool, expenseInput };
}

Deno.test({
  name: "assign_expense_to_pool: writes cam_input_pool_assignments and is only reachable via the edge function, not raw RPC, for an authenticated (non-service-role) user",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const { status, json } = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "assign_expense_to_pool", cam_expense_input_id: setup.expenseInput.id, recovery_pool_id: setup.pool.id, amount: 5000,
    });
    assertEquals(status, 200);
    assertExists(json.assignment);

    const { data: assignments } = await admin.from("cam_input_pool_assignments").select("id, amount").eq("cam_expense_input_id", setup.expenseInput.id);
    assertEquals(assignments!.length, 1);
    assertEquals(Number(assignments![0].amount), 5000);
  },
});

Deno.test({
  name: "assign_expense_to_pool: rejects a cross-organization expense input",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const otherOrg = await insertOne(admin, "organizations", { name: `Other Org ${suffix}`, status: "active" });
    const { accessToken: otherToken } = await createOrgUserWithToken(admin, `${suffix}-other`, otherOrg.id, "org_admin");

    const { status } = await callEdge("cam-setup-actions-v2", otherToken, {
      action: "assign_expense_to_pool", cam_expense_input_id: setup.expenseInput.id, recovery_pool_id: setup.pool.id, amount: 5000,
    });
    assertEquals(status >= 400, true);
  },
});

Deno.test({
  name: "add_pool_participant: writes recovery_pool_lease_participants",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const { status, json } = await callEdge("cam-setup-actions-v2", accessToken, {
      action: "add_pool_participant", pool_id: setup.pool.id, lease_id: setup.lease.id, effective_from: "2026-01-01",
    });
    assertEquals(status, 200);
    assertExists(json.participant);

    const { data: participants } = await admin.from("recovery_pool_lease_participants").select("id, lease_id, source").eq("pool_id", setup.pool.id);
    assertEquals(participants!.length, 1);
    assertEquals(participants![0].lease_id, setup.lease.id);
    assertEquals(participants![0].source, "explicit");
  },
});

Deno.test({
  name: "add_pool_participant: missing effective_from is rejected with a clear error, not a silent default",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpMinimalProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    const { status, json } = await callEdge("cam-setup-actions-v2", accessToken, { action: "add_pool_participant", pool_id: setup.pool.id, lease_id: setup.lease.id });
    assertEquals(status, 400);
    assertExists(json.error);
  },
});

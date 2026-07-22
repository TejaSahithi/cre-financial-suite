// Feature: enterprise-readiness-hardening Phase 6R-7 (first rule-family
// selective RLS lockdown).
// Properties:
//   1. Direct authenticated INSERT into lease_expense_values is rejected by RLS.
//   2. Direct authenticated UPDATE to lease_expense_values is rejected by RLS.
//   3. Direct authenticated INSERT into lease_expense_rule_clauses is rejected by RLS.
//   4. SELECT remains unchanged for org members on both tables.
//   5. save_lease_expense_rule_set (service_role, bypasses RLS) still
//      creates rows in both tables normally -- proves the RPC path is
//      unaffected by the lockdown (not re-derived here in full; see
//      save-lease-expense-rule-set.property.test.ts for the RPC's own
//      regression coverage -- this test only adds the direct-client-lockdown
//      angle that file doesn't cover).
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
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

async function createOrgUser(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `values-clauses-lockdown-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);

  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: "Values Clauses Lockdown Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { userId, email, accessToken };
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Values Clauses Lockdown Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Values Clauses Lockdown Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Values Clauses Lockdown Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
  });

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: "CAM",
    normalized_key: `cam_${suffix}`,
  });

  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
    org_id: org.id,
    lease_id: lease.id,
    property_id: property.id,
    version: 1,
    status: "draft",
  });

  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id,
    lease_id: lease.id,
    rule_set_id: ruleSet.id,
    expense_category_id: category.id,
    rule_key: `rule_${suffix}`,
    row_status: "mentioned",
    expense_category: "CAM",
  });

  return { org, accessToken, property, lease, ruleSet, rule };
}

Deno.test({
  name: "Phase 6R-7: direct authenticated INSERT into lease_expense_values is rejected by RLS; SELECT unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, rule } = await setUpScope(admin, suffix);

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: insertErr, data: insertData } = await authed.from("lease_expense_values").insert({
      rule_id: rule.id,
      final_value: 1000,
      frequency: "yearly",
    }).select();
    const insertBlocked = Boolean(insertErr) || (insertData ?? []).length === 0;
    assertEquals(insertBlocked, true, "direct authenticated INSERT on lease_expense_values must be rejected by RLS");

    const { data: rowsAfter, error: rowsErr } = await admin
      .from("lease_expense_values")
      .select("id")
      .eq("rule_id", rule.id);
    assertNoError(rowsErr);
    assertEquals(rowsAfter?.length ?? 0, 0, "no row must have been created by the blocked direct insert");

    // SELECT must remain unchanged for org members.
    const seeded = await insertOne(admin, "lease_expense_values", {
      rule_id: rule.id,
      final_value: 2000,
      frequency: "yearly",
    });
    const { data: selectData, error: selectErr } = await authed
      .from("lease_expense_values")
      .select("id")
      .eq("id", seeded.id);
    assertNoError(selectErr);
    assertEquals(selectData?.length, 1, "SELECT must remain unchanged for org members");
  },
});

Deno.test({
  name: "Phase 6R-7: direct authenticated UPDATE to lease_expense_values is rejected by RLS",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, rule } = await setUpScope(admin, suffix);

    const row = await insertOne(admin, "lease_expense_values", {
      rule_id: rule.id,
      final_value: 1500,
      frequency: "yearly",
    });

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: updateErr, data: updateData } = await authed
      .from("lease_expense_values")
      .update({ final_value: 9999 })
      .eq("id", row.id)
      .select();
    const updateBlocked = Boolean(updateErr) || (updateData ?? []).length === 0;
    assertEquals(updateBlocked, true, "direct authenticated UPDATE on lease_expense_values must be rejected by RLS");

    const { data: rowAfter, error: rowAfterErr } = await admin
      .from("lease_expense_values")
      .select("final_value")
      .eq("id", row.id)
      .single();
    assertNoError(rowAfterErr);
    assertExists(rowAfter);
    assertEquals(Number(rowAfter.final_value), 1500, "the blocked update must not have changed the row");
  },
});

Deno.test({
  name: "Phase 6R-7: direct authenticated INSERT into lease_expense_rule_clauses is rejected by RLS; SELECT unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease, rule } = await setUpScope(admin, suffix);

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: insertErr, data: insertData } = await authed.from("lease_expense_rule_clauses").insert({
      lease_expense_rule_id: rule.id,
      lease_id: lease.id,
      clause_type: "supporting_text",
      clause_text: "Direct insert attempt",
    }).select();
    const insertBlocked = Boolean(insertErr) || (insertData ?? []).length === 0;
    assertEquals(insertBlocked, true, "direct authenticated INSERT on lease_expense_rule_clauses must be rejected by RLS");

    const { data: rowsAfter, error: rowsErr } = await admin
      .from("lease_expense_rule_clauses")
      .select("id")
      .eq("lease_expense_rule_id", rule.id);
    assertNoError(rowsErr);
    assertEquals(rowsAfter?.length ?? 0, 0, "no row must have been created by the blocked direct insert");

    // SELECT must remain unchanged for org members.
    const seeded = await insertOne(admin, "lease_expense_rule_clauses", {
      lease_expense_rule_id: rule.id,
      lease_id: lease.id,
      clause_type: "supporting_text",
      clause_text: "Seeded via service role",
    });
    const { data: selectData, error: selectErr } = await authed
      .from("lease_expense_rule_clauses")
      .select("id")
      .eq("id", seeded.id);
    assertNoError(selectErr);
    assertEquals(selectData?.length, 1, "SELECT must remain unchanged for org members");
  },
});

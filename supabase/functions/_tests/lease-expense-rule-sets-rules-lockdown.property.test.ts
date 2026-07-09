// Feature: enterprise-readiness-hardening Phase 6R-8 (lease_expense_rule_sets /
// lease_expense_rules INSERT/UPDATE lockdown) + Phase 6R-11 (DELETE lockdown
// for the same two tables).
// Properties:
//   1. Direct authenticated INSERT into lease_expense_rule_sets is rejected by RLS.
//   2. Direct authenticated UPDATE to lease_expense_rule_sets is rejected by RLS.
//   3. Direct authenticated INSERT into lease_expense_rules is rejected by RLS.
//   4. Direct authenticated UPDATE to lease_expense_rules is rejected by RLS.
//   5. SELECT remains unchanged for org members on both tables.
//   6. Direct authenticated DELETE is rejected by RLS on both tables
//      (Phase 6R-11 -- previously unchanged/open, now locked).
// RPC-path regression (save_lease_expense_rule_set,
// update_lease_expense_rule_set_status, update_lease_expense_rule,
// update_lease_expense_rule_amount all still succeed under this lockdown)
// is covered by save-lease-expense-rule-set.property.test.ts and
// lease-expense-rule-cluster-cleanup.property.test.ts -- not re-derived here.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

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
  const email = `rule-sets-rules-lockdown-${suffix}@example.test`;
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
    full_name: "Rule Sets Rules Lockdown Tester",
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
    name: `Rule Sets Rules Lockdown Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Rule Sets Rules Lockdown Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Rule Sets Rules Lockdown Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
  });

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: "CAM",
    normalized_key: `cam_${suffix}`,
  });

  return { org, accessToken, property, lease, category };
}

Deno.test({
  name: "Phase 6R-8: direct authenticated INSERT into lease_expense_rule_sets is rejected by RLS; SELECT unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpScope(admin, suffix);

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: insertErr, data: insertData } = await authed.from("lease_expense_rule_sets").insert({
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      version: 1,
      status: "draft",
    }).select();
    const insertBlocked = Boolean(insertErr) || (insertData ?? []).length === 0;
    assertEquals(insertBlocked, true, "direct authenticated INSERT on lease_expense_rule_sets must be rejected by RLS");

    const { data: rowsAfter, error: rowsErr } = await admin
      .from("lease_expense_rule_sets")
      .select("id")
      .eq("lease_id", lease.id);
    assertNoError(rowsErr);
    assertEquals(rowsAfter?.length ?? 0, 0, "no row must have been created by the blocked direct insert");

    // SELECT must remain unchanged for org members.
    const seeded = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      version: 1,
      status: "draft",
    });
    const { data: selectData, error: selectErr } = await authed
      .from("lease_expense_rule_sets")
      .select("id")
      .eq("id", seeded.id);
    assertNoError(selectErr);
    assertEquals(selectData?.length, 1, "SELECT must remain unchanged for org members");
  },
});

Deno.test({
  name: "Phase 6R-8/6R-11: direct authenticated UPDATE and DELETE to lease_expense_rule_sets are rejected by RLS",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpScope(admin, suffix);

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      version: 1,
      status: "draft",
    });

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: updateErr, data: updateData } = await authed
      .from("lease_expense_rule_sets")
      .update({ status: "approved" })
      .eq("id", ruleSet.id)
      .select();
    const updateBlocked = Boolean(updateErr) || (updateData ?? []).length === 0;
    assertEquals(updateBlocked, true, "direct authenticated UPDATE on lease_expense_rule_sets must be rejected by RLS");

    const { data: rowAfter, error: rowAfterErr } = await admin
      .from("lease_expense_rule_sets")
      .select("status")
      .eq("id", ruleSet.id)
      .single();
    assertNoError(rowAfterErr);
    assertExists(rowAfter);
    assertEquals(rowAfter.status, "draft", "the blocked update must not have changed the row");

    // DELETE must now be rejected by RLS (Phase 6R-11 locked it).
    const { error: deleteErr, data: deleteData } = await authed
      .from("lease_expense_rule_sets")
      .delete()
      .eq("id", ruleSet.id)
      .select();
    const deleteBlocked = Boolean(deleteErr) || (deleteData ?? []).length === 0;
    assertEquals(deleteBlocked, true, "direct authenticated DELETE on lease_expense_rule_sets must be rejected by RLS");

    const { data: rowStillThere } = await admin.from("lease_expense_rule_sets").select("id").eq("id", ruleSet.id).maybeSingle();
    assertExists(rowStillThere, "the row must still exist -- the blocked delete must not have removed it");
  },
});

Deno.test({
  name: "Phase 6R-8: direct authenticated INSERT into lease_expense_rules is rejected by RLS; SELECT unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease, category } = await setUpScope(admin, suffix);

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      version: 1,
      status: "draft",
    });

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: insertErr, data: insertData } = await authed.from("lease_expense_rules").insert({
      org_id: ruleSet.org_id,
      lease_id: lease.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      rule_key: `rule_${suffix}`,
      row_status: "mentioned",
      expense_category: "CAM",
    }).select();
    const insertBlocked = Boolean(insertErr) || (insertData ?? []).length === 0;
    assertEquals(insertBlocked, true, "direct authenticated INSERT on lease_expense_rules must be rejected by RLS");

    const { data: rowsAfter, error: rowsErr } = await admin
      .from("lease_expense_rules")
      .select("id")
      .eq("rule_set_id", ruleSet.id);
    assertNoError(rowsErr);
    assertEquals(rowsAfter?.length ?? 0, 0, "no row must have been created by the blocked direct insert");

    // SELECT must remain unchanged for org members.
    const seeded = await insertOne(admin, "lease_expense_rules", {
      org_id: ruleSet.org_id,
      lease_id: lease.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      rule_key: `rule_${suffix}_seed`,
      row_status: "mentioned",
      expense_category: "CAM",
    });
    const { data: selectData, error: selectErr } = await authed
      .from("lease_expense_rules")
      .select("id")
      .eq("id", seeded.id);
    assertNoError(selectErr);
    assertEquals(selectData?.length, 1, "SELECT must remain unchanged for org members");
  },
});

Deno.test({
  name: "Phase 6R-8/6R-11: direct authenticated UPDATE and DELETE to lease_expense_rules are rejected by RLS",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease, category } = await setUpScope(admin, suffix);

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      version: 1,
      status: "draft",
    });
    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: ruleSet.org_id,
      lease_id: lease.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      rule_key: `rule_${suffix}`,
      row_status: "mentioned",
      expense_category: "CAM",
      notes: "original",
    });

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: updateErr, data: updateData } = await authed
      .from("lease_expense_rules")
      .update({ notes: "direct update attempt" })
      .eq("id", rule.id)
      .select();
    const updateBlocked = Boolean(updateErr) || (updateData ?? []).length === 0;
    assertEquals(updateBlocked, true, "direct authenticated UPDATE on lease_expense_rules must be rejected by RLS");

    const { data: rowAfter, error: rowAfterErr } = await admin
      .from("lease_expense_rules")
      .select("notes")
      .eq("id", rule.id)
      .single();
    assertNoError(rowAfterErr);
    assertExists(rowAfter);
    assertEquals(rowAfter.notes, "original", "the blocked update must not have changed the row");

    // DELETE must now be rejected by RLS (Phase 6R-11 locked it).
    const { error: deleteErr, data: deleteData } = await authed
      .from("lease_expense_rules")
      .delete()
      .eq("id", rule.id)
      .select();
    const deleteBlocked = Boolean(deleteErr) || (deleteData ?? []).length === 0;
    assertEquals(deleteBlocked, true, "direct authenticated DELETE on lease_expense_rules must be rejected by RLS");

    const { data: rowStillThere } = await admin.from("lease_expense_rules").select("id").eq("id", rule.id).maybeSingle();
    assertExists(rowStillThere, "the row must still exist -- the blocked delete must not have removed it");
  },
});

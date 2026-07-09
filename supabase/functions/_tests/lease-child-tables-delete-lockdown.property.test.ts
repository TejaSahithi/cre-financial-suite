// Feature: enterprise-readiness-hardening Phase 6R-11 (DELETE lockdown for
// eligible lease child tables).
// Properties:
//   1. delete_lease_cascade (service_role, bypasses RLS) still deletes the
//      lease AND its child rows -- across lease_critical_dates,
//      lease_expense_rule_sets, lease_expense_rules, lease_expense_values,
//      lease_expense_rule_clauses, and expenses -- transactionally, fully
//      unaffected by this phase's DELETE lockdown.
//   2. Direct authenticated DELETE is rejected by RLS on
//      lease_critical_dates, lease_expense_rule_sets, lease_expense_rules.
//   3. Direct authenticated DELETE remains rejected (no policy, unchanged)
//      on lease_expense_values and lease_expense_rule_clauses.
//   4. SELECT remains unchanged on all three newly-locked tables.
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
  const email = `lease-child-delete-lockdown-${suffix}@example.test`;
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
    full_name: "Lease Child Delete Lockdown Tester",
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
    name: `Lease Child Delete Lockdown Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Lease Child Delete Lockdown Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Lease Child Delete Lockdown Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
  });

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: "CAM",
    normalized_key: `cam_${suffix}`,
  });

  return { org, accessToken, userId, email, property, lease, category };
}

Deno.test({
  name: "delete_lease_cascade: still deletes the lease and all child rows transactionally after DELETE lockdown",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, userId, email, property, lease, category } = await setUpScope(admin, suffix);

    const criticalDate = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      date_type: "custom",
      due_date: "2027-05-01",
      status: "open",
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

    const value = await insertOne(admin, "lease_expense_values", {
      rule_id: rule.id,
      final_value: 1000,
      frequency: "yearly",
    });

    const clause = await insertOne(admin, "lease_expense_rule_clauses", {
      lease_expense_rule_id: rule.id,
      lease_id: lease.id,
      clause_type: "supporting_text",
      clause_text: "Tenant shall pay CAM.",
    });

    const expense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      lease_id: lease.id,
      amount: 500,
      category: "CAM",
      vendor: "Test Vendor",
      expense_date: "2026-06-01",
    });

    const { error: deleteError } = await admin.rpc("delete_lease_cascade", {
      target_lease_id: lease.id,
      p_actor_user_id: userId,
      p_actor_email: email,
    });
    assertNoError(deleteError);

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertEquals(leaseAfter, null, "the lease row itself must be gone");

    const { data: criticalDateAfter } = await admin.from("lease_critical_dates").select("id").eq("id", criticalDate.id).maybeSingle();
    assertEquals(criticalDateAfter, null, "lease_critical_dates row must be cascade-deleted");

    const { data: ruleSetAfter } = await admin.from("lease_expense_rule_sets").select("id").eq("id", ruleSet.id).maybeSingle();
    assertEquals(ruleSetAfter, null, "lease_expense_rule_sets row must be cascade-deleted");

    const { data: ruleAfter } = await admin.from("lease_expense_rules").select("id").eq("id", rule.id).maybeSingle();
    assertEquals(ruleAfter, null, "lease_expense_rules row must be cascade-deleted");

    const { data: valueAfter } = await admin.from("lease_expense_values").select("id").eq("id", value.id).maybeSingle();
    assertEquals(valueAfter, null, "lease_expense_values row must be gone (cascade or FK ON DELETE CASCADE)");

    const { data: clauseAfter } = await admin.from("lease_expense_rule_clauses").select("id").eq("id", clause.id).maybeSingle();
    assertEquals(clauseAfter, null, "lease_expense_rule_clauses row must be cascade-deleted");

    const { data: expenseAfter } = await admin.from("expenses").select("id").eq("id", expense.id).maybeSingle();
    assertEquals(expenseAfter, null, "expenses row must be cascade-deleted");
  },
});

Deno.test({
  name: "Phase 6R-11: direct authenticated DELETE is rejected by RLS on lease_critical_dates, lease_expense_rule_sets, lease_expense_rules; SELECT unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, lease, category } = await setUpScope(admin, suffix);

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const criticalDate = await insertOne(admin, "lease_critical_dates", {
      org_id: (await admin.from("leases").select("org_id").eq("id", lease.id).single()).data?.org_id,
      lease_id: lease.id,
      property_id: property.id,
      date_type: "custom",
      due_date: "2027-05-01",
      status: "open",
    });
    const { error: cdDeleteErr, data: cdDeleteData } = await authed
      .from("lease_critical_dates").delete().eq("id", criticalDate.id).select();
    const cdBlocked = Boolean(cdDeleteErr) || (cdDeleteData ?? []).length === 0;
    assertEquals(cdBlocked, true, "direct authenticated DELETE on lease_critical_dates must be rejected by RLS");
    const { data: cdSelect, error: cdSelectErr } = await authed.from("lease_critical_dates").select("id").eq("id", criticalDate.id);
    assertNoError(cdSelectErr);
    assertEquals(cdSelect?.length, 1, "SELECT must remain unchanged for org members");
    const { data: cdAfter } = await admin.from("lease_critical_dates").select("id").eq("id", criticalDate.id).maybeSingle();
    assertExists(cdAfter, "the row must still exist -- the blocked delete must not have removed it");

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: (await admin.from("leases").select("org_id").eq("id", lease.id).single()).data?.org_id,
      lease_id: lease.id,
      property_id: property.id,
      version: 1,
      status: "draft",
    });
    const { error: rsDeleteErr, data: rsDeleteData } = await authed
      .from("lease_expense_rule_sets").delete().eq("id", ruleSet.id).select();
    const rsBlocked = Boolean(rsDeleteErr) || (rsDeleteData ?? []).length === 0;
    assertEquals(rsBlocked, true, "direct authenticated DELETE on lease_expense_rule_sets must be rejected by RLS");
    const { data: rsSelect, error: rsSelectErr } = await authed.from("lease_expense_rule_sets").select("id").eq("id", ruleSet.id);
    assertNoError(rsSelectErr);
    assertEquals(rsSelect?.length, 1, "SELECT must remain unchanged for org members");
    const { data: rsAfter } = await admin.from("lease_expense_rule_sets").select("id").eq("id", ruleSet.id).maybeSingle();
    assertExists(rsAfter, "the row must still exist -- the blocked delete must not have removed it");

    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: ruleSet.org_id,
      lease_id: lease.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      rule_key: `rule_${suffix}`,
      row_status: "mentioned",
      expense_category: "CAM",
    });
    const { error: rDeleteErr, data: rDeleteData } = await authed
      .from("lease_expense_rules").delete().eq("id", rule.id).select();
    const rBlocked = Boolean(rDeleteErr) || (rDeleteData ?? []).length === 0;
    assertEquals(rBlocked, true, "direct authenticated DELETE on lease_expense_rules must be rejected by RLS");
    const { data: rSelect, error: rSelectErr } = await authed.from("lease_expense_rules").select("id").eq("id", rule.id);
    assertNoError(rSelectErr);
    assertEquals(rSelect?.length, 1, "SELECT must remain unchanged for org members");
    const { data: rAfter } = await admin.from("lease_expense_rules").select("id").eq("id", rule.id).maybeSingle();
    assertExists(rAfter, "the row must still exist -- the blocked delete must not have removed it");
  },
});

Deno.test({
  name: "Phase 6R-11: direct authenticated DELETE remains rejected (no policy, unchanged) on lease_expense_values and lease_expense_rule_clauses",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease, category } = await setUpScope(admin, suffix);
    const orgId = (await admin.from("leases").select("org_id").eq("id", lease.id).single()).data?.org_id;

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: orgId,
      lease_id: lease.id,
      version: 1,
      status: "draft",
    });
    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: orgId,
      lease_id: lease.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      rule_key: `rule_${suffix}`,
      row_status: "mentioned",
      expense_category: "CAM",
    });
    const value = await insertOne(admin, "lease_expense_values", {
      rule_id: rule.id,
      final_value: 1000,
      frequency: "yearly",
    });
    const clause = await insertOne(admin, "lease_expense_rule_clauses", {
      lease_expense_rule_id: rule.id,
      lease_id: lease.id,
      clause_type: "supporting_text",
      clause_text: "Tenant shall pay CAM.",
    });

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    const { error: valueDeleteErr, data: valueDeleteData } = await authed
      .from("lease_expense_values").delete().eq("id", value.id).select();
    const valueBlocked = Boolean(valueDeleteErr) || (valueDeleteData ?? []).length === 0;
    assertEquals(valueBlocked, true, "direct authenticated DELETE on lease_expense_values must remain rejected");
    const { data: valueAfter } = await admin.from("lease_expense_values").select("id").eq("id", value.id).maybeSingle();
    assertExists(valueAfter, "the row must still exist");

    const { error: clauseDeleteErr, data: clauseDeleteData } = await authed
      .from("lease_expense_rule_clauses").delete().eq("id", clause.id).select();
    const clauseBlocked = Boolean(clauseDeleteErr) || (clauseDeleteData ?? []).length === 0;
    assertEquals(clauseBlocked, true, "direct authenticated DELETE on lease_expense_rule_clauses must remain rejected");
    const { data: clauseAfter } = await admin.from("lease_expense_rule_clauses").select("id").eq("id", clause.id).maybeSingle();
    assertExists(clauseAfter, "the row must still exist");
  },
});

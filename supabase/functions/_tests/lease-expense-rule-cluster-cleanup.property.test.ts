// Feature: enterprise-readiness-hardening Phase 6R-2 (lease-expense-rule cluster cleanup).
// Properties:
//   1. update_lease_expense_rule_set_status: succeeds, sets status +
//      approved_at (approved_at only when status='approved').
//   2. update_lease_expense_rule: succeeds, merges only the whitelisted
//      business fields, leaves other columns untouched.
//   3. update_lease_expense_rule_amount: succeeds, sets both
//      estimated_annual_amount and estimated_monthly_amount (amount/12).
//   4. A user without write access is blocked for each of the 3 RPCs, zero
//      side effects.
//   5. An unknown lease/rule/rule_set id is rejected for each of the 3 RPCs,
//      zero side effects.
//   6. Exactly one audit_logs row per successful call, for each RPC.
//   7. update_lease_expense_rule rejects a disallowed patch key (injection
//      resistance), zero side effects.
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
  const email = `lease-rule-cluster-${suffix}@example.test`;
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
    full_name: "Lease Rule Cluster Tester",
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

function callFn(fnName: string, accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Lease Rule Cluster Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Lease Rule Cluster Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Lease Rule Cluster Tenant ${suffix}`,
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
    notes: "original note",
    estimated_annual_amount: 1200,
    estimated_monthly_amount: 100,
  });

  return { org, accessToken, userId, email, property, lease, category, ruleSet, rule };
}

Deno.test({
  name: "update_lease_expense_rule_set_status: succeeds, sets approved_at only when approved",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, ruleSet } = await setUpScope(admin, suffix);

    const res = await callFn("update-lease-expense-rule-set-status", accessToken, {
      rule_set_id: ruleSet.id,
      lease_id: lease.id,
      status: "approved",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.status, "approved");
    assertExists(body.approved_at);
    assertExists(body.audit_log_id);

    const { data: ruleSetAfter, error } = await admin
      .from("lease_expense_rule_sets")
      .select("status, approved_at")
      .eq("id", ruleSet.id)
      .single();
    assertNoError(error);
    assertExists(ruleSetAfter);
    assertEquals(ruleSetAfter.status, "approved");
    assertExists(ruleSetAfter.approved_at);

    const draftRes = await callFn("update-lease-expense-rule-set-status", accessToken, {
      rule_set_id: ruleSet.id,
      lease_id: lease.id,
      status: "draft",
    });
    const draftBody = await draftRes.json();
    assertEquals(draftRes.status, 200, JSON.stringify(draftBody));
    assertEquals(draftBody.approved_at, null, "moving away from approved must clear approved_at");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRuleSet")
      .eq("entity_id", ruleSet.id)
      .eq("action", "lease_expense_rule_set_status_recalculated");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 2, "each successful status change writes exactly one audit row");
  },
});

Deno.test({
  name: "update_lease_expense_rule_set_status: user without write access blocked, unknown rule_set rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease, ruleSet } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const blockedRes = await callFn("update-lease-expense-rule-set-status", viewerToken, {
      rule_set_id: ruleSet.id,
      lease_id: lease.id,
      status: "approved",
    });
    const blockedBody = await blockedRes.json();
    assertEquals(blockedBody.error, true, `expected viewer to be blocked: ${JSON.stringify(blockedBody)}`);
    assertEquals([401, 403].includes(blockedRes.status), true, `expected 401/403, got ${blockedRes.status}`);

    const { accessToken } = await createOrgUser(admin, `${suffix}-admin2`, org.id, "org_admin");
    const unknownRes = await callFn("update-lease-expense-rule-set-status", accessToken, {
      rule_set_id: crypto.randomUUID(),
      lease_id: lease.id,
      status: "approved",
    });
    const unknownBody = await unknownRes.json();
    assertEquals(unknownBody.error, true, "expected a clear error for an unknown rule_set_id");
    assertEquals(unknownRes.status, 400, JSON.stringify(unknownBody));

    const { data: ruleSetAfter } = await admin
      .from("lease_expense_rule_sets")
      .select("status")
      .eq("id", ruleSet.id)
      .single();
    assertExists(ruleSetAfter);
    assertEquals(ruleSetAfter.status, "draft", "neither blocked nor rejected attempt may change status");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRuleSet")
      .eq("entity_id", ruleSet.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for a blocked/rejected attempt");
  },
});

Deno.test({
  name: "update_lease_expense_rule: succeeds, merges only whitelisted business fields",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, rule } = await setUpScope(admin, suffix);

    const res = await callFn("update-lease-expense-rule", accessToken, {
      rule_id: rule.id,
      lease_id: lease.id,
      patch: {
        expense_category: "Utilities",
        cap_percent: 5,
        notes: "updated via RPC",
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);
    assertEquals(body.rule.expense_category, "Utilities");
    assertEquals(Number(body.rule.cap_percent), 5);
    assertEquals(body.rule.notes, "updated via RPC");
    // Untouched sibling column must survive.
    assertEquals(body.rule.rule_key, rule.rule_key);

    const { data: ruleAfter, error } = await admin
      .from("lease_expense_rules")
      .select("expense_category, cap_percent, notes, rule_key")
      .eq("id", rule.id)
      .single();
    assertNoError(error);
    assertExists(ruleAfter);
    assertEquals(ruleAfter.expense_category, "Utilities");
    assertEquals(ruleAfter.notes, "updated via RPC");
    assertEquals(ruleAfter.rule_key, rule.rule_key);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRule")
      .eq("entity_id", rule.id)
      .eq("action", "lease_expense_rule_updated");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row per successful update");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "update_lease_expense_rule: disallowed patch key rejected, user without write access blocked, unknown rule rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, rule } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const disallowedRes = await callFn("update-lease-expense-rule", accessToken, {
      rule_id: rule.id,
      lease_id: lease.id,
      patch: { org_id: crypto.randomUUID() },
    });
    const disallowedBody = await disallowedRes.json();
    assertEquals(disallowedBody.error, true, "expected a disallowed patch key to be rejected");
    assertEquals(disallowedRes.status, 400, JSON.stringify(disallowedBody));

    const blockedRes = await callFn("update-lease-expense-rule", viewerToken, {
      rule_id: rule.id,
      lease_id: lease.id,
      patch: { notes: "should not persist" },
    });
    const blockedBody = await blockedRes.json();
    assertEquals(blockedBody.error, true, `expected viewer to be blocked: ${JSON.stringify(blockedBody)}`);
    assertEquals([401, 403].includes(blockedRes.status), true, `expected 401/403, got ${blockedRes.status}`);

    const unknownRes = await callFn("update-lease-expense-rule", accessToken, {
      rule_id: crypto.randomUUID(),
      lease_id: lease.id,
      patch: { notes: "should not persist" },
    });
    const unknownBody = await unknownRes.json();
    assertEquals(unknownBody.error, true, "expected a clear error for an unknown rule_id");
    assertEquals(unknownRes.status, 400, JSON.stringify(unknownBody));

    const { data: ruleAfter, error } = await admin
      .from("lease_expense_rules")
      .select("notes")
      .eq("id", rule.id)
      .single();
    assertNoError(error);
    assertExists(ruleAfter);
    assertEquals(ruleAfter.notes, "original note", "none of the 3 rejected attempts may change the row");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRule")
      .eq("entity_id", rule.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for any of the 3 rejected attempts");
  },
});

Deno.test({
  name: "update_lease_expense_rule_amount: succeeds, sets annual + monthly (amount/12), exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, rule } = await setUpScope(admin, suffix);

    const res = await callFn("update-lease-expense-rule-amount", accessToken, {
      rule_id: rule.id,
      lease_id: lease.id,
      amount: 6000,
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);
    assertEquals(Number(body.rule.estimated_annual_amount), 6000);
    assertEquals(Number(body.rule.estimated_monthly_amount), 500);

    const { data: ruleAfter, error } = await admin
      .from("lease_expense_rules")
      .select("estimated_annual_amount, estimated_monthly_amount")
      .eq("id", rule.id)
      .single();
    assertNoError(error);
    assertExists(ruleAfter);
    assertEquals(Number(ruleAfter.estimated_annual_amount), 6000);
    assertEquals(Number(ruleAfter.estimated_monthly_amount), 500);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRule")
      .eq("entity_id", rule.id)
      .eq("action", "lease_expense_rule_amount_updated");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row per successful amount update");
  },
});

Deno.test({
  name: "update_lease_expense_rule_amount: negative amount rejected, user without write access blocked, unknown rule rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, rule } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const negativeRes = await callFn("update-lease-expense-rule-amount", accessToken, {
      rule_id: rule.id,
      lease_id: lease.id,
      amount: -100,
    });
    const negativeBody = await negativeRes.json();
    assertEquals(negativeBody.error, true, "expected a negative amount to be rejected");
    assertEquals(negativeRes.status, 400, JSON.stringify(negativeBody));

    const blockedRes = await callFn("update-lease-expense-rule-amount", viewerToken, {
      rule_id: rule.id,
      lease_id: lease.id,
      amount: 999,
    });
    const blockedBody = await blockedRes.json();
    assertEquals(blockedBody.error, true, `expected viewer to be blocked: ${JSON.stringify(blockedBody)}`);
    assertEquals([401, 403].includes(blockedRes.status), true, `expected 401/403, got ${blockedRes.status}`);

    const unknownRes = await callFn("update-lease-expense-rule-amount", accessToken, {
      rule_id: crypto.randomUUID(),
      lease_id: lease.id,
      amount: 999,
    });
    const unknownBody = await unknownRes.json();
    assertEquals(unknownBody.error, true, "expected a clear error for an unknown rule_id");
    assertEquals(unknownRes.status, 400, JSON.stringify(unknownBody));

    const { data: ruleAfter, error } = await admin
      .from("lease_expense_rules")
      .select("estimated_annual_amount")
      .eq("id", rule.id)
      .single();
    assertNoError(error);
    assertExists(ruleAfter);
    assertEquals(Number(ruleAfter.estimated_annual_amount), 1200, "none of the 3 rejected attempts may change the row");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRule")
      .eq("entity_id", rule.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for any of the 3 rejected attempts");
  },
});

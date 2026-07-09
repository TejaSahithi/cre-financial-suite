// Feature: enterprise-readiness-hardening Phase 6X-2 (update_expense_amount).
// Properties:
//   1. A valid amount correction succeeds, exactly one canonical audit row.
//   2. A cross-org expense_id is rejected, zero side effects.
//   3. A user without write access is blocked, zero side effects.
//   4. A negative/non-finite amount is rejected, zero side effects.
//   5. An idempotent replay (same amount as current) is a safe no-op:
//      changed=false, no additional audit row.
//   6. An unknown expense_id is rejected, zero side effects.
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
  const email = `update-expense-amount-${suffix}@example.test`;
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
    full_name: "Update Expense Amount Tester",
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

function callFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/update-expense-amount`, {
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
    name: `Update Expense Amount Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Update Expense Amount Property ${suffix}`,
    status: "active",
  });

  const expense = await insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    category: "CAM",
    amount: 1000,
  });

  return { org, accessToken, property, expense };
}

Deno.test({
  name: "update_expense_amount: valid correction succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, expense } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, { expense_id: expense.id, amount: 1500 });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(Number(body.expense.amount), 1500);
    assertExists(body.audit_log_id);

    const { data: expenseAfter, error } = await admin
      .from("expenses")
      .select("amount")
      .eq("id", expense.id)
      .single();
    assertNoError(error);
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1500);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", expense.id)
      .eq("action", "expense_amount_corrected");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row for a real amount change");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
    assertEquals(Number((auditRows![0].metadata as Record<string, unknown>).previous_amount), 1000);
    assertEquals(Number((auditRows![0].metadata as Record<string, unknown>).new_amount), 1500);
  },
});

Deno.test({
  name: "update_expense_amount: cross-org expense_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Update Expense Amount Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property ${suffix}`,
      status: "active",
    });
    const otherExpense = await insertOne(admin, "expenses", {
      org_id: otherOrg.id,
      property_id: otherProperty.id,
      category: "CAM",
      amount: 500,
    });

    const res = await callFn(accessToken, { expense_id: otherExpense.id, amount: 999 });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org expense_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", otherExpense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 500, "the other org's expense must be unchanged");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Expense")
      .eq("entity_id", otherExpense.id)
      .eq("action", "expense_amount_corrected");
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for a rejected attempt");
  },
});

Deno.test({
  name: "update_expense_amount: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, expense } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, { expense_id: expense.id, amount: 2000 });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the blocked attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_amount: a negative amount is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, expense } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, { expense_id: expense.id, amount: -50 });
    const body = await res.json();
    assertEquals(body.error, true, "expected a negative amount to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_amount: idempotent replay (same amount) is a safe no-op, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, expense } = await setUpScope(admin, suffix);

    const firstRes = await callFn(accessToken, { expense_id: expense.id, amount: 1234 });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callFn(accessToken, { expense_id: expense.id, amount: 1234 });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay with the identical amount must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", expense.id)
      .eq("action", "expense_amount_corrected");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "update_expense_amount: unknown expense_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, { expense_id: crypto.randomUUID(), amount: 100 });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown expense_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

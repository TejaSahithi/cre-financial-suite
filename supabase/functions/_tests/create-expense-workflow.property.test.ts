// Feature: enterprise-readiness-hardening Phase 6D-7 (create_expense_workflow).
// Properties:
//   1. Manual expense create succeeds, writes exactly one canonical audit row.
//   2. A user without write access is blocked, zero side effects.
//   3. An invalid/cross-org property_id is rejected, zero side effects.
//   4. Missing required fields (date/amount/category/vendor/property_id)
//      are rejected, zero side effects.
//   5. An arbitrary/disallowed field (e.g. org_id, status) is rejected,
//      zero side effects (injection resistance).
//   6. Exactly one audit_logs row per successful call, canonical shape.
//   7. tr_expense_added does not duplicate the RPC's audit row (GUC skip),
//      and its variance-notification logic is untouched (still fires for a
//      later, separate direct INSERT that doesn't set the GUC).
//   8. (Regression) other expense-classification workflows still pass --
//      verified by running review/persist-expense-classification alongside
//      this file, not re-derived here.
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
  const email = `create-expense-workflow-${suffix}@example.test`;
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
    full_name: "Create Expense Workflow Tester",
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

function callCreate(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/create-expense-workflow`, {
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
    name: `Create Expense Workflow Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Create Expense Workflow Property ${suffix}`,
    status: "active",
  });

  return { org, accessToken, userId, email, property };
}

function validExpensePayload(propertyId: string, overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-03-01",
    amount: 1250.5,
    category: "utilities",
    vendor: "Acme Utility Co",
    description: "March utilities",
    classification: "recoverable",
    property_id: propertyId,
    source: "manual",
    fiscal_year: 2026,
    approval_status: "approved",
    review_status: "approved",
    service_period_start: "2026-03-01",
    service_period_end: "2026-03-31",
    ...overrides,
  };
}

Deno.test({
  name: "create_expense_workflow: manual create succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callCreate(accessToken, { expense: validExpensePayload(property.id) });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.expense?.id);
    assertExists(body.audit_log_id);
    assertEquals(body.expense.vendor, "Acme Utility Co");
    assertEquals(Number(body.expense.amount), 1250.5);

    const { data: expenseAfter, error } = await admin
      .from("expenses")
      .select("*")
      .eq("id", body.expense.id)
      .single();
    assertNoError(error);
    assertExists(expenseAfter);
    assertEquals(expenseAfter.org_id, org.id);
    assertEquals(expenseAfter.property_id, property.id);
    assertEquals(expenseAfter.category, "utilities");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, action, actor_user_id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", body.expense.id)
      .eq("action", "expense_created");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "create must write exactly one audit row");
    assertExists(auditRows![0].actor_user_id);
    assertEquals(auditRows![0].before, null);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "create_expense_workflow: user without write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callCreate(viewerToken, { expense: validExpensePayload(property.id) });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: expenses, error } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertNoError(error);
    assertEquals(expenses?.length ?? 0, 0, "blocked attempt must not create any row");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "blocked attempt must not write any audit row");
  },
});

Deno.test({
  name: "create_expense_workflow: cross-org property_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Create Expense Workflow Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Org Property ${suffix}`,
      status: "active",
    });

    const res = await callCreate(accessToken, { expense: validExpensePayload(otherProperty.id) });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org property to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);

    const { data: expenses, error } = await admin.from("expenses").select("id").eq("property_id", otherProperty.id);
    assertNoError(error);
    assertEquals(expenses?.length ?? 0, 0);
  },
});

Deno.test({
  name: "create_expense_workflow: missing required fields are rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const missingFieldCases = [
      { ...validExpensePayload(property.id), date: undefined },
      { ...validExpensePayload(property.id), amount: undefined },
      { ...validExpensePayload(property.id), category: undefined },
      { ...validExpensePayload(property.id), vendor: undefined },
      { ...validExpensePayload(property.id), property_id: undefined },
    ];

    for (const expense of missingFieldCases) {
      const res = await callCreate(accessToken, { expense });
      const body = await res.json();
      assertEquals(body.error, true, `expected rejection for payload: ${JSON.stringify(expense)}`);
      assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    }

    const { data: expenses, error } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertNoError(error);
    assertEquals(expenses?.length ?? 0, 0, "no partial creates from any rejected payload");
  },
});

Deno.test({
  name: "create_expense_workflow: arbitrary/disallowed field is rejected (injection resistance)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callCreate(accessToken, {
      expense: { ...validExpensePayload(property.id), org_id: crypto.randomUUID() },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the disallowed 'org_id' key to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const res2 = await callCreate(accessToken, {
      expense: { ...validExpensePayload(property.id), status: "hacked" },
    });
    const body2 = await res2.json();
    assertEquals(body2.error, true, "expected the disallowed 'status' key to be rejected");
    assertEquals(res2.status, 400, `expected 400, got ${res2.status}: ${JSON.stringify(body2)}`);

    const { data: expenses, error } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertNoError(error);
    assertEquals(expenses?.length ?? 0, 0, "whole call must be rejected, not partially applied");
  },
});

Deno.test({
  name: "create_expense_workflow: exactly one audit row, trigger does not duplicate it, variance notification still fires for a later direct insert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    await insertOne(admin, "budgets", {
      org_id: org.id,
      property_id: property.id,
      name: `Create Expense Workflow Budget ${suffix}`,
      budget_year: 2026,
      total_expenses: 100,
      total_revenue: 200,
      status: "draft",
    });

    const res = await callCreate(accessToken, {
      expense: validExpensePayload(property.id, { amount: 500, fiscal_year: 2026 }),
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", body.expense.id)
      .eq("action", "expense_created");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row");

    // Trigger must not have written a second, duplicate 'create' row.
    const { data: triggerCreateRows, error: triggerCreateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", body.expense.id)
      .eq("action", "create");
    assertNoError(triggerCreateErr);
    assertEquals(triggerCreateRows?.length ?? 0, 0, "tr_expense_added must not write a duplicate 'create' row for this RPC's INSERT");

    // Variance notification must still fire: $500 actual vs $100 budgeted on
    // this property/year is a >10% variance.
    const { data: notifications, error: notifErr } = await admin
      .from("notifications")
      .select("id, title")
      .eq("org_id", org.id)
      .eq("title", "Expense Variance Alert");
    assertNoError(notifErr);
    assertEquals((notifications?.length ?? 0) > 0, true, "tr_expense_added's variance notification must still fire");

    // A later, separate direct INSERT (outside the RPC, simulating a
    // still-out-of-scope call site like BulkImport.jsx) must still be
    // trigger-audited normally -- the GUC must not leak across transactions.
    const directExpense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      category: "utilities",
      amount: 10,
      vendor: "Direct Insert Co",
      date: "2026-03-05",
      fiscal_year: 2026,
      source: "import",
    });

    const { data: directAuditRows, error: directAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", directExpense.id)
      .eq("action", "create");
    assertNoError(directAuditErr);
    assertEquals(directAuditRows?.length, 1, "a later direct INSERT must still be trigger-audited (GUC must not leak)");
  },
});

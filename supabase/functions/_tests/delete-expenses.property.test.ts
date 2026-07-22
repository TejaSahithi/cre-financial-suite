// Feature: enterprise-readiness-hardening Phase 6X-4 (delete_expenses_workflow).
// Server-owns Expenses.jsx's single-delete and bulk-delete actions.
// Properties:
//   1. A single expense delete succeeds, exactly one audit row.
//   2. A bulk expense delete succeeds, one audit row per deleted expense.
//   3. A cross-org expense_id is rejected, zero side effects.
//   4. A mixed-org bulk request (one in-org + one cross-org) is rejected as
//      a whole -- the in-org expense is NOT deleted (atomicity).
//   5. A user without write access is blocked, zero side effects.
//   6. An unknown expense_id is rejected, zero side effects.
//   7. Dependent rows are handled exactly as the FK constraints intend:
//      expense_classifications cascade-deletes with the expense, and
//      expense_classification_cam_send_runs (which references the
//      classification with ON DELETE CASCADE) cascade-deletes along with
//      it -- verified empirically against local Postgres, not assumed
//      from expense_id's own (unreachable in this chain) SET NULL rule.
//   8. Duplicate ids in the same request are deduplicated, not double-deleted
//      or double-audited.
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
  const email = `delete-expenses-${suffix}@example.test`;
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
    full_name: "Delete Expenses Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/delete-expenses`, {
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
    name: `Delete Expenses Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Delete Expenses Property ${suffix}`,
    status: "active",
  });

  return { org, accessToken, property };
}

async function insertExpense(admin: ReturnType<typeof adminClient>, org: { id: string }, property: { id: string }, amount: number) {
  return insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    category: "CAM",
    amount,
    date: "2026-01-01",
  });
}

Deno.test({
  name: "delete_expenses_workflow: single delete succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);
    const expense = await insertExpense(admin, org, property, 500);

    const res = await callFn(accessToken, { expense_ids: [expense.id] });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.deleted_count, 1);
    assertEquals(body.deleted_ids, [expense.id]);

    const { data: expenseAfter } = await admin.from("expenses").select("id").eq("id", expense.id).maybeSingle();
    assertEquals(expenseAfter, null, "the expense row must be gone");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", expense.id)
      .eq("action", "expense_deleted");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row for a deleted expense");
    assertExists(auditRows![0].before);
    assertEquals(auditRows![0].after, null);
  },
});

Deno.test({
  name: "delete_expenses_workflow: bulk delete succeeds, one audit row per deleted expense",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);
    const expenseA = await insertExpense(admin, org, property, 100);
    const expenseB = await insertExpense(admin, org, property, 200);
    const expenseC = await insertExpense(admin, org, property, 300);

    const res = await callFn(accessToken, { expense_ids: [expenseA.id, expenseB.id, expenseC.id] });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.deleted_count, 3);

    const { data: remaining } = await admin
      .from("expenses")
      .select("id")
      .in("id", [expenseA.id, expenseB.id, expenseC.id]);
    assertEquals(remaining?.length ?? 0, 0, "all three expenses must be gone");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, entity_id, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("action", "expense_deleted")
      .in("entity_id", [expenseA.id, expenseB.id, expenseC.id]);
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 3, "exactly one audit row per deleted expense");
    for (const row of auditRows!) {
      assertEquals((row.metadata as Record<string, unknown>).batch_size, 3);
    }
  },
});

Deno.test({
  name: "delete_expenses_workflow: cross-org expense_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Delete Expenses Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property ${suffix}`,
      status: "active",
    });
    const otherExpense = await insertExpense(admin, otherOrg, otherProperty, 999);

    const res = await callFn(accessToken, { expense_ids: [otherExpense.id] });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org expense_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("id").eq("id", otherExpense.id).maybeSingle();
    assertExists(expenseAfter, "the other org's expense must still exist");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Expense")
      .eq("entity_id", otherExpense.id)
      .eq("action", "expense_deleted");
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for a rejected attempt");
  },
});

Deno.test({
  name: "delete_expenses_workflow: mixed-org bulk request is rejected transactionally, the in-org expense survives",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);
    const inOrgExpense = await insertExpense(admin, org, property, 400);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Delete Expenses Mixed Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Mixed Other Property ${suffix}`,
      status: "active",
    });
    const otherExpense = await insertExpense(admin, otherOrg, otherProperty, 401);

    const res = await callFn(accessToken, { expense_ids: [inOrgExpense.id, otherExpense.id] });
    const body = await res.json();
    assertEquals(body.error, true, "expected the mixed-org batch to be rejected as a whole");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: inOrgAfter } = await admin.from("expenses").select("id").eq("id", inOrgExpense.id).maybeSingle();
    assertExists(inOrgAfter, "the in-org expense must NOT have been deleted (no partial batch delete)");

    const { data: otherAfter } = await admin.from("expenses").select("id").eq("id", otherExpense.id).maybeSingle();
    assertExists(otherAfter, "the other org's expense must still exist");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Expense")
      .eq("action", "expense_deleted")
      .in("entity_id", [inOrgExpense.id, otherExpense.id]);
    assertEquals(auditRows?.length ?? 0, 0, "no audit rows for a fully-rejected batch");
  },
});

Deno.test({
  name: "delete_expenses_workflow: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");
    const expense = await insertExpense(admin, org, property, 250);

    const res = await callFn(viewerToken, { expense_ids: [expense.id] });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: expenseAfter } = await admin.from("expenses").select("id").eq("id", expense.id).maybeSingle();
    assertExists(expenseAfter, "the blocked attempt must not delete the row");
  },
});

Deno.test({
  name: "delete_expenses_workflow: unknown expense_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, { expense_ids: [crypto.randomUUID()] });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown expense_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "delete_expenses_workflow: dependent rows handled per FK intent (classifications and their cam_send_runs cascade)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);
    const expense = await insertExpense(admin, org, property, 700);

    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      expense_id: expense.id,
      property_id: property.id,
    });

    const camSendRun = await insertOne(admin, "expense_classification_cam_send_runs", {
      org_id: org.id,
      expense_id: expense.id,
      classification_id: classification.id,
      idempotency_key: `delete-expenses-test-${suffix}`,
      status: "completed",
    });

    const res = await callFn(accessToken, { expense_ids: [expense.id] });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: classificationAfter } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("id", classification.id)
      .maybeSingle();
    assertEquals(classificationAfter, null, "expense_classifications row must cascade-delete with its expense");

    // classification_id -> expense_classifications is itself ON DELETE
    // CASCADE, so once the classification is gone, this row cascades away
    // too -- its own expense_id ON DELETE SET NULL rule never gets a
    // chance to apply. Verified empirically against local Postgres.
    const { data: camSendRunAfter } = await admin
      .from("expense_classification_cam_send_runs")
      .select("id")
      .eq("id", camSendRun.id)
      .maybeSingle();
    assertEquals(camSendRunAfter, null, "the CAM send run cascades away with its classification");
  },
});

Deno.test({
  name: "delete_expenses_workflow: duplicate ids in the same request are deduplicated, not double-audited",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);
    const expense = await insertExpense(admin, org, property, 150);

    const res = await callFn(accessToken, { expense_ids: [expense.id, expense.id] });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.deleted_count, 1, "a duplicated id must be deduplicated, not counted twice");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", expense.id)
      .eq("action", "expense_deleted");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row despite the duplicate id");
  },
});

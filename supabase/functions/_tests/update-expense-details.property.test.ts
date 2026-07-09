// Feature: enterprise-readiness-hardening Phase 6X-3 (update_expense_details).
// Server-owns AddExpense.jsx's "Edit Expense" save path.
// Properties:
//   1. A valid edit succeeds, exactly one canonical audit row.
//   2. A cross-org expense_id is rejected, zero side effects.
//   3. A user without write access is blocked, zero side effects.
//   4. A cross-org property_id is rejected, zero side effects.
//   5. A cross-org vendor_id is rejected, zero side effects.
//   6. A building_id belonging to a different property is rejected.
//   7. A unit_id belonging to a different property is rejected.
//   8. A negative amount is rejected, zero side effects.
//   9. An idempotent replay (identical payload) is a safe no-op:
//      changed=false, no additional audit row.
//   10. An unknown field in the patch is rejected (whitelist enforcement).
//   11. An unknown expense_id is rejected.
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
  const email = `update-expense-details-${suffix}@example.test`;
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
    full_name: "Update Expense Details Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/update-expense-details`, {
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
    name: `Update Expense Details Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Update Expense Details Property ${suffix}`,
    status: "active",
  });

  const vendor = await insertOne(admin, "vendors", {
    org_id: org.id,
    name: `Update Expense Details Vendor ${suffix}`,
  });

  const expense = await insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    category: "CAM",
    vendor: "Original Vendor",
    vendor_id: vendor.id,
    amount: 1000,
    date: "2026-01-01",
  });

  return { org, accessToken, property, vendor, expense };
}

function basePatch(property: { id: string }, vendor: { id: string }) {
  return {
    date: "2026-02-15",
    amount: 1750,
    category: "CAM",
    vendor: "Updated Vendor",
    vendor_id: vendor.id,
    description: "Updated description",
    property_id: property.id,
    source: "manual",
    fiscal_year: 2026,
    service_period_start: "2026-02-15",
    service_period_end: "2026-02-15",
  };
}

Deno.test({
  name: "update_expense_details: valid edit succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, vendor, expense } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: basePatch(property, vendor),
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(Number(body.expense.amount), 1750);
    assertEquals(body.expense.vendor, "Updated Vendor");
    assertExists(body.audit_log_id);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", expense.id)
      .eq("action", "expense_details_updated");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row for a real change");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "update_expense_details: cross-org expense_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, vendor } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Update Expense Details Other Org ${suffix}`,
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
      date: "2026-01-01",
    });

    const res = await callFn(accessToken, {
      expense_id: otherExpense.id,
      expense: basePatch(property, vendor),
    });
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
      .eq("action", "expense_details_updated");
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for a rejected attempt");
  },
});

Deno.test({
  name: "update_expense_details: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, vendor, expense } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      expense_id: expense.id,
      expense: basePatch(property, vendor),
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the blocked attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: cross-org property_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, vendor, expense } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Update Expense Details Other Org Prop ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Cross Org Property ${suffix}`,
      status: "active",
    });

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: { ...basePatch(otherProperty, vendor), property_id: otherProperty.id },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org property_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount, property_id").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: cross-org vendor_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, expense } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Update Expense Details Other Org Vendor ${suffix}`,
      status: "active",
    });
    const otherVendor = await insertOne(admin, "vendors", {
      org_id: otherOrg.id,
      name: `Cross Org Vendor ${suffix}`,
    });

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: basePatch(property, otherVendor),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org vendor_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: building_id from a different property is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, vendor, expense } = await setUpScope(admin, suffix);

    const otherProperty = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Sibling Property ${suffix}`,
      status: "active",
    });
    const otherBuilding = await insertOne(admin, "buildings", {
      org_id: org.id,
      property_id: otherProperty.id,
      name: `Sibling Building ${suffix}`,
    });

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: { ...basePatch(property, vendor), building_id: otherBuilding.id },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a mismatched building_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: unit_id from a different property is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, vendor, expense } = await setUpScope(admin, suffix);

    const otherProperty = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Sibling Property Unit ${suffix}`,
      status: "active",
    });
    const otherUnit = await insertOne(admin, "units", {
      org_id: org.id,
      property_id: otherProperty.id,
      unit_number: `U-${suffix}`,
    });

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: { ...basePatch(property, vendor), unit_id: otherUnit.id },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a mismatched unit_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: a negative amount is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, vendor, expense } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: { ...basePatch(property, vendor), amount: -25 },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a negative amount to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: idempotent replay (identical payload) is a safe no-op, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, vendor, expense } = await setUpScope(admin, suffix);
    const patch = basePatch(property, vendor);

    const firstRes = await callFn(accessToken, { expense_id: expense.id, expense: patch });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callFn(accessToken, { expense_id: expense.id, expense: patch });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay with an identical payload must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("entity_id", expense.id)
      .eq("action", "expense_details_updated");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "update_expense_details: an unknown field in the patch is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, vendor, expense } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expense_id: expense.id,
      expense: { ...basePatch(property, vendor), approval_status: "approved" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unrecognized field to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the rejected attempt must not change the row");
  },
});

Deno.test({
  name: "update_expense_details: unknown expense_id is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, vendor } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expense_id: crypto.randomUUID(),
      expense: basePatch(property, vendor),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown expense_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

// Feature: enterprise-readiness-hardening Phase 6X-5 (bulk_create_expenses_workflow).
// Server-owns BulkImport.jsx's CSV/Excel expense import loop.
// Properties:
//   1. A valid bulk import creates all rows, one audit row per created expense.
//   2. A row missing amount rejects the whole batch, zero rows created.
//   3. A row missing category rejects the whole batch, zero rows created.
//   4. A negative amount rejects the whole batch, zero rows created.
//   5. A cross-org property_id rejects the whole batch, zero rows created.
//   6. A cross-org vendor id is not applicable (no vendor_id field) --
//      covered instead by cross-org lease_id/tenant_id/portfolio_id.
//   7. A user without write access is blocked, zero rows created.
//   8. gl_code/invoice_number are persisted when present (the field
//      create_expense_workflow's whitelist is missing).
//   9. A row missing property_id/building_id/unit_id (org-wide import) is
//      allowed -- these are NOT required, matching BulkImport's own
//      client-side validation.
//   10. An unrecognized field is rejected (whitelist enforcement).
//   11. Empty/non-array expenses payload is rejected.
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
  const email = `bulk-create-expenses-${suffix}@example.test`;
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
    full_name: "Bulk Create Expenses Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/bulk-create-expenses`, {
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
    name: `Bulk Create Expenses Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Bulk Create Expenses Property ${suffix}`,
    status: "active",
  });

  return { org, accessToken, property };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-01-15",
    category: "hvac_maintenance",
    amount: 1250,
    vendor: "AZ Air Systems",
    description: "Monthly HVAC service",
    classification: "recoverable",
    source: "import",
    ...overrides,
  };
}

Deno.test({
  name: "bulk_create_expenses_workflow: valid batch creates all rows, one audit row per expense",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [
        row({ property_id: property.id, amount: 100 }),
        row({ property_id: property.id, amount: 200 }),
        row({ property_id: property.id, amount: 300 }),
      ],
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.created_count, 3);
    assertEquals(body.created_ids.length, 3);

    const { data: created, error } = await admin
      .from("expenses")
      .select("id, amount, org_id")
      .in("id", body.created_ids);
    assertNoError(error);
    assertEquals(created?.length, 3);
    for (const e of created!) {
      assertEquals(e.org_id, org.id);
    }

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, entity_id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "Expense")
      .eq("action", "expense_created")
      .in("entity_id", body.created_ids);
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 3, "exactly one audit row per created expense");
    for (const r of auditRows!) {
      assertEquals(r.before, null);
      assertExists(r.after);
    }
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: a row missing amount rejects the whole batch, zero rows created",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [
        row({ property_id: property.id, amount: 100 }),
        row({ property_id: property.id, amount: undefined }),
      ],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the batch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "no rows should be created when any row is invalid");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: a row missing category rejects the whole batch, zero rows created",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [
        row({ property_id: property.id, category: "" }),
      ],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the batch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "no rows should be created");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: a negative amount rejects the whole batch, zero rows created",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [
        row({ property_id: property.id, amount: 100 }),
        row({ property_id: property.id, amount: -50 }),
      ],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the batch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "no rows should be created, including the valid first row");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: a cross-org property_id rejects the whole batch, zero rows created",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Bulk Create Expenses Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property ${suffix}`,
      status: "active",
    });

    const res = await callFn(accessToken, {
      expenses: [
        row({ property_id: property.id }),
        row({ property_id: otherProperty.id }),
      ],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org property_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "no rows should be created");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: cross-org lease_id and portfolio_id are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Bulk Create Expenses Other Org Lease ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property Lease ${suffix}`,
      status: "active",
    });
    const otherLease = await insertOne(admin, "leases", {
      org_id: otherOrg.id,
      property_id: otherProperty.id,
    });

    const leaseRes = await callFn(accessToken, {
      expenses: [row({ property_id: property.id, lease_id: otherLease.id })],
    });
    const leaseBody = await leaseRes.json();
    assertEquals(leaseBody.error, true, "expected a cross-org lease_id to be rejected");
    assertEquals(leaseRes.status, 400, JSON.stringify(leaseBody));

    const otherPortfolio = await insertOne(admin, "portfolios", {
      org_id: otherOrg.id,
      name: `Other Portfolio ${suffix}`,
    });
    const portfolioRes = await callFn(accessToken, {
      expenses: [row({ property_id: property.id, portfolio_id: otherPortfolio.id })],
    });
    const portfolioBody = await portfolioRes.json();
    assertEquals(portfolioBody.error, true, "expected a cross-org portfolio_id to be rejected");
    assertEquals(portfolioRes.status, 400, JSON.stringify(portfolioBody));

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "no rows should be created from either rejected batch");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: user without write access is blocked, zero rows created",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      expenses: [row({ property_id: property.id })],
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "the blocked attempt must not create any rows");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: gl_code and invoice_number are persisted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [row({ property_id: property.id, gl_code: "5400", invoice_number: "INV-2026-001" })],
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: created } = await admin
      .from("expenses")
      .select("gl_code, invoice_number")
      .eq("id", body.created_ids[0])
      .single();
    assertEquals(created?.gl_code, "5400");
    assertEquals(created?.invoice_number, "INV-2026-001");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: org-wide import with no property/building/unit is allowed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [row()],
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success with no property scope: ${JSON.stringify(body)}`);
    assertEquals(body.created_count, 1);

    const { data: created } = await admin
      .from("expenses")
      .select("property_id")
      .eq("id", body.created_ids[0])
      .single();
    assertEquals(created?.property_id, null);
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: an unrecognized field is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      expenses: [row({ property_id: property.id, approval_status: "approved" })],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unrecognized field to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: existing } = await admin.from("expenses").select("id").eq("org_id", org.id);
    assertEquals(existing?.length ?? 0, 0, "no rows should be created");
  },
});

Deno.test({
  name: "bulk_create_expenses_workflow: empty expenses array is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, { expenses: [] });
    const body = await res.json();
    assertEquals(body.error, true, "expected an empty batch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

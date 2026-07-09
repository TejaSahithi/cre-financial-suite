// Feature: enterprise-readiness-hardening Phase 6X-6 (manual_override_expense_classification).
// Server-owns LeaseExpenseClassification.jsx's markManualOverride action.
// Properties:
//   1. A valid manual override succeeds, exactly one canonical audit row,
//      override_reason/type/previous/new captured in audit metadata.
//   2. A cross-org classification_id is rejected, zero side effects.
//   3. A user without write access is blocked, zero side effects.
//   4. An idempotent replay (same actor, already-finalized row) is a safe
//      no-op: changed=false, no additional audit row.
//   5. A missing override_reason is rejected.
//   6. An unknown classification_id is rejected.
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
  const email = `manual-override-classification-${suffix}@example.test`;
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
    full_name: "Manual Override Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/manual-override-expense-classification`, {
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
    name: `Manual Override Classification Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Manual Override Classification Property ${suffix}`,
    status: "active",
  });

  const expense = await insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    category: "CAM",
    amount: 500,
    date: "2026-01-01",
  });

  const classification = await insertOne(admin, "expense_classifications", {
    org_id: org.id,
    expense_id: expense.id,
    property_id: property.id,
  });

  return { org, accessToken, property, expense, classification };
}

const overridePayload = () => ({
  override_reason: "Tenant lease amendment allows recovery despite base-year exclusion",
  override_type: "cam_eligibility",
  override_previous_value: { cam_eligible: "no", recoverability_result: "non_recoverable" },
  override_new_value: { cam_eligible: "yes", recoverability_result: "recoverable" },
});

Deno.test({
  name: "manual_override_expense_classification: valid override succeeds, exactly one audit row with metadata",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      classification_id: classification.id,
      ...overridePayload(),
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(body.classification.classification_status, "finalized");
    assertExists(body.audit_log_id);

    const { data: classificationAfter } = await admin
      .from("expense_classifications")
      .select("classification_status, reviewed_by, approved_by")
      .eq("id", classification.id)
      .single();
    assertEquals(classificationAfter?.classification_status, "finalized");
    assertExists(classificationAfter?.reviewed_by);
    assertExists(classificationAfter?.approved_by);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id)
      .eq("action", "expense_classification_manual_override");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row for a real override");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
    const metadata = auditRows![0].metadata as Record<string, unknown>;
    assertEquals(metadata.override_reason, overridePayload().override_reason);
    assertEquals(metadata.override_type, "cam_eligibility");
    assertExists(metadata.override_previous_value);
    assertExists(metadata.override_new_value);
  },
});

Deno.test({
  name: "manual_override_expense_classification: cross-org classification_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Manual Override Other Org ${suffix}`,
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
      amount: 900,
      date: "2026-01-01",
    });
    const otherClassification = await insertOne(admin, "expense_classifications", {
      org_id: otherOrg.id,
      expense_id: otherExpense.id,
      property_id: otherProperty.id,
    });

    const res = await callFn(accessToken, {
      classification_id: otherClassification.id,
      ...overridePayload(),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org classification_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: classificationAfter } = await admin
      .from("expense_classifications")
      .select("classification_status")
      .eq("id", otherClassification.id)
      .single();
    assertEquals(classificationAfter?.classification_status, "draft", "the other org's row must be unchanged");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", otherClassification.id)
      .eq("action", "expense_classification_manual_override");
    assertEquals(auditRows?.length ?? 0, 0, "no audit row for a rejected attempt");
  },
});

Deno.test({
  name: "manual_override_expense_classification: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, classification } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      classification_id: classification.id,
      ...overridePayload(),
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: classificationAfter } = await admin
      .from("expense_classifications")
      .select("classification_status")
      .eq("id", classification.id)
      .single();
    assertEquals(classificationAfter?.classification_status, "draft", "the blocked attempt must not change the row");
  },
});

Deno.test({
  name: "manual_override_expense_classification: idempotent replay (same actor) is a safe no-op, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const firstRes = await callFn(accessToken, {
      classification_id: classification.id,
      ...overridePayload(),
    });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callFn(accessToken, {
      classification_id: classification.id,
      ...overridePayload(),
    });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay by the same actor on an already-finalized row must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id)
      .eq("action", "expense_classification_manual_override");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "manual_override_expense_classification: missing override_reason is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      classification_id: classification.id,
      override_reason: "",
      override_type: "cam_eligibility",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a missing override_reason to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

Deno.test({
  name: "manual_override_expense_classification: unknown classification_id is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      classification_id: crypto.randomUUID(),
      ...overridePayload(),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown classification_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

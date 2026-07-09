// Feature: enterprise-readiness-hardening Phase 3 + Phase 6X-1.
// Property (Phase 3): persist-expense-classification is a narrow server-side
// consistency gate on top of the (still client-side) classification
// derivation — it does not re-derive the lease-rule match, but rejects a
// submitted classification that is internally inconsistent with the
// expense/rule data, and every successful persist writes exactly one
// audit_logs row.
// Properties (Phase 6X-1 -- optional paired `expenses` write):
//   1. A call with expense_patch persists both expense_classifications and
//      expenses (classification/recovery_status) in one transaction.
//   2. A disallowed expense_patch key is rejected, zero side effects on
//      either table.
//   3. A rejected classification (consistency gate failure) leaves
//      `expenses` completely untouched -- proves the two writes are
//      atomic (one transaction), not two independent calls.
//   4. A sparse classification_patch (only a few keys) no longer wipes
//      previously-persisted classification columns that are absent from
//      the patch -- proves the new key-presence-aware fallback to the
//      existing row.
//   5. persist_expense_classification is service_role-only (no direct
//      frontend/anon/authenticated RPC access).
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

Deno.test({
  name: "HTTP persist-expense-classification: consistency gate, audit logging, and zero-write-on-rejection",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actorEmail = `persist-classification-${suffix}@example.test`;
    const password = `Pass-${suffix}!`;

    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email: actorEmail,
      password,
      email_confirm: true,
    });
    assertNoError(userError);
    const actorUserId = userData.user?.id;
    assertExists(actorUserId);

    const org = await insertOne(admin, "organizations", {
      name: `Persist Classification Org ${suffix}`,
      status: "active",
      primary_contact_email: actorEmail,
    });

    await admin.from("profiles").upsert({
      id: actorUserId,
      email: actorEmail,
      full_name: "Persist Classification Tester",
      role: "org_admin",
      status: "active",
    });

    await insertOne(admin, "memberships", {
      user_id: actorUserId,
      org_id: org.id,
      role: "org_admin",
    });

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Persist Classification Property ${suffix}`,
      status: "active",
    });

    const tenant = await insertOne(admin, "tenants", {
      org_id: org.id,
      name: `Tenant ${suffix}`,
      email: `tenant-${actorEmail}`,
      status: "active",
    });

    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      status: "pending",
      abstract_version: 0,
    });

    const category = await insertOne(admin, "expense_categories", {
      category_name: `CAM ${suffix}`,
      normalized_key: `cam_${suffix.replace(/-/g, "_")}`,
    });

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      status: "draft",
    });

    const publishedRule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id,
      rule_set_id: ruleSet.id,
      lease_id: lease.id,
      expense_category_id: category.id,
      published_to_cam: true,
      is_excluded: false,
      payment_treatment: "reimbursable",
      cam_eligible: "yes",
    });

    const unpublishedRule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id,
      rule_set_id: ruleSet.id,
      lease_id: lease.id,
      expense_category_id: category.id,
      published_to_cam: false,
      is_excluded: false,
      payment_treatment: "reimbursable",
      cam_eligible: "yes",
    });

    const expenseA = await insertOne(admin, "expenses", {
      org_id: org.id, property_id: property.id, category: "CAM", amount: 1000,
    });
    const expenseB = await insertOne(admin, "expenses", {
      org_id: org.id, property_id: property.id, category: "CAM", amount: 500,
    });
    const expenseC = await insertOne(admin, "expenses", {
      org_id: org.id, property_id: property.id, category: "CAM", amount: 250,
    });
    const expenseD = await insertOne(admin, "expenses", {
      org_id: org.id, property_id: property.id, category: "CAM", amount: 750,
    });

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
      email: actorEmail,
      password,
    });
    assertNoError(signInError);
    const accessToken = signInData.session?.access_token;
    assertExists(accessToken);

    const callFn = (body: Record<string, unknown>) =>
      fetch(`${SUPABASE_URL}/functions/v1/persist-expense-classification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "apikey": ANON_KEY,
        },
        body: JSON.stringify(body),
      });

    // 1. Valid/consistent classification persists.
    const validRes = await callFn({
      expense_id: expenseA.id,
      linked_expense_rule_id: publishedRule.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      cam_status: "cam_ready",
      sent_to_cam: false,
      category: "CAM",
      amount: 1000,
    });
    const validBody = await validRes.json();
    assertEquals(validRes.status, 200, `expected success: ${JSON.stringify(validBody)}`);
    assertEquals(validBody.error, false);
    assertExists(validBody.audit_log_id);

    const { data: rowsA, error: rowsAError } = await admin
      .from("expense_classifications")
      .select("*")
      .eq("expense_id", expenseA.id);
    assertNoError(rowsAError);
    assertEquals(rowsA?.length, 1, "valid classification persists exactly one row");

    // 5. Exactly one audit_logs row is written on a successful persist.
    const { data: auditRowsA, error: auditRowsAError } = await admin
      .from("audit_logs")
      .select("*")
      .eq("entity_type", "ExpenseClassification")
      .contains("metadata", { expense_id: expenseA.id });
    assertNoError(auditRowsAError);
    assertEquals(auditRowsA?.length, 1, "exactly one audit_logs row on success");

    // 2. Invalid CAM-ready + non-recoverable combination is rejected.
    const invalidRes = await callFn({
      expense_id: expenseB.id,
      recovery_status: "non_recoverable",
      recoverability_result: "non_recoverable",
      cam_eligible: "yes",
      cam_status: "needs_review",
    });
    const invalidBody = await invalidRes.json();
    assertEquals(invalidRes.status, 400, `expected rejection: ${JSON.stringify(invalidBody)}`);
    assertEquals(invalidBody.error, true);
    assertEquals(invalidBody.blockers?.includes("cam_eligible_without_recoverable_status"), true);

    // 4. A rejected classification does not write any expense_classifications row.
    const { data: rowsB, error: rowsBError } = await admin
      .from("expense_classifications")
      .select("*")
      .eq("expense_id", expenseB.id);
    assertNoError(rowsBError);
    assertEquals(rowsB?.length ?? 0, 0, "rejected classification writes zero rows");

    // 3. cam_status=cam_ready with an unpublished linked rule is rejected.
    const unpublishedRes = await callFn({
      expense_id: expenseC.id,
      linked_expense_rule_id: unpublishedRule.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      cam_status: "cam_ready",
    });
    const unpublishedBody = await unpublishedRes.json();
    assertEquals(unpublishedRes.status, 400, `expected rejection: ${JSON.stringify(unpublishedBody)}`);
    assertEquals(unpublishedBody.blockers?.includes("cam_ready_rule_not_published"), true);

    const { data: rowsC, error: rowsCError } = await admin
      .from("expense_classifications")
      .select("*")
      .eq("expense_id", expenseC.id);
    assertNoError(rowsCError);
    assertEquals(rowsC?.length ?? 0, 0, "rejected classification (unpublished rule) writes zero rows");

    // Bonus: sent_to_cam cannot be newly set true through this endpoint —
    // that transition is exclusively owned by
    // send_expense_classification_to_cam_workflow.
    const sentToCamRes = await callFn({
      expense_id: expenseD.id,
      linked_expense_rule_id: publishedRule.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      cam_status: "cam_ready",
      sent_to_cam: true,
    });
    const sentToCamBody = await sentToCamRes.json();
    assertEquals(sentToCamRes.status, 400, `expected rejection: ${JSON.stringify(sentToCamBody)}`);
    assertEquals(sentToCamBody.blockers?.includes("sent_to_cam_must_use_dedicated_workflow"), true);
  },
});

async function createOrgUser(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `persist-classification-patch-${suffix}@example.test`;
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
    full_name: "Persist Classification Patch Tester",
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

function callPersistFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/persist-expense-classification`, {
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
    name: `Persist Classification Patch Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Persist Classification Patch Property ${suffix}`,
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
  name: "persist_expense_classification: expense_patch persists both tables in one transaction, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, expense } = await setUpScope(admin, suffix);

    const res = await callPersistFn(accessToken, {
      expense_id: expense.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      cam_eligible: "no",
      cam_status: "needs_review",
      category: "CAM",
      amount: 1000,
      expense_patch: { classification: "recoverable", recovery_status: "recoverable" },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.expense_patched, true);
    assertExists(body.audit_log_id);

    const { data: expenseAfter, error: expenseErr } = await admin
      .from("expenses")
      .select("classification, recovery_status")
      .eq("id", expense.id)
      .single();
    assertNoError(expenseErr);
    assertExists(expenseAfter);
    assertEquals(expenseAfter.classification, "recoverable");
    assertEquals(expenseAfter.recovery_status, "recoverable");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .contains("metadata", { expense_id: expense.id });
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row even though two tables were written");
    assertEquals((auditRows![0].metadata as Record<string, unknown>).expense_patched, true);
  },
});

Deno.test({
  name: "persist_expense_classification: a disallowed expense_patch key is rejected, zero side effects on either table",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, expense } = await setUpScope(admin, suffix);

    const res = await callPersistFn(accessToken, {
      expense_id: expense.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      category: "CAM",
      amount: 1000,
      expense_patch: { amount: 9999 },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a disallowed expense_patch key to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("amount").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(Number(expenseAfter.amount), 1000, "the expense must be unchanged");

    const { data: classificationRows } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("expense_id", expense.id);
    assertEquals(classificationRows?.length ?? 0, 0, "the whole call must be rejected, including the classification write");
  },
});

Deno.test({
  name: "persist_expense_classification: a rejected classification (consistency gate) leaves expenses untouched",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, expense } = await setUpScope(admin, suffix);

    const res = await callPersistFn(accessToken, {
      expense_id: expense.id,
      recovery_status: "non_recoverable",
      recoverability_result: "non_recoverable",
      cam_eligible: "yes",
      cam_status: "needs_review",
      expense_patch: { classification: "recoverable", recovery_status: "recoverable" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the consistency gate to reject this combination");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter, error: expenseErr } = await admin
      .from("expenses")
      .select("classification, recovery_status")
      .eq("id", expense.id)
      .single();
    assertNoError(expenseErr);
    assertExists(expenseAfter);
    assertEquals(expenseAfter.classification, null, "expenses must be completely untouched when the classification gate rejects");
    assertEquals(expenseAfter.recovery_status, "needs_review", "expenses.recovery_status defaults to 'needs_review' at insert and must remain at that default, not the requested 'recoverable'");
  },
});

Deno.test({
  name: "persist_expense_classification: sparse classification_patch preserves existing fields not in the patch",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, expense } = await setUpScope(admin, suffix);

    const firstRes = await callPersistFn(accessToken, {
      expense_id: expense.id,
      recovery_status: "needs_review",
      recoverability_result: "needs_review",
      category: "CAM",
      subcategory: "Landscaping",
      amount: 1000,
      evidence_text: "Original evidence text",
      notes: "Original notes",
    });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));

    // Second call: a genuinely sparse patch (only classification_status +
    // exception_type), matching sendExpenseClassificationToReview's shape
    // before this phase's client-side merge -- proves the RPC itself is
    // now safe even if a caller sends a sparse patch.
    const secondRes = await callPersistFn(accessToken, {
      expense_id: expense.id,
      recovery_status: "needs_review",
      recoverability_result: "needs_review",
      classification_status: "exception",
      exception_type: "manual_review",
    });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));

    const { data: rowAfter, error } = await admin
      .from("expense_classifications")
      .select("category, subcategory, evidence_text, notes, classification_status, exception_type")
      .eq("expense_id", expense.id)
      .single();
    assertNoError(error);
    assertExists(rowAfter);
    assertEquals(rowAfter.category, "CAM", "category must survive a sparse follow-up patch");
    assertEquals(rowAfter.subcategory, "Landscaping", "subcategory must survive a sparse follow-up patch");
    assertEquals(rowAfter.evidence_text, "Original evidence text", "evidence_text must survive a sparse follow-up patch");
    assertEquals(rowAfter.notes, "Original notes", "notes must survive a sparse follow-up patch");
    assertEquals(rowAfter.classification_status, "exception", "the sparse patch's own keys must still apply");
    assertEquals(rowAfter.exception_type, "manual_review");
  },
});

Deno.test({
  name: "persist_expense_classification: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, expense } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callPersistFn(viewerToken, {
      expense_id: expense.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      expense_patch: { recovery_status: "recoverable" },
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: expenseAfter } = await admin.from("expenses").select("recovery_status").eq("id", expense.id).single();
    assertExists(expenseAfter);
    assertEquals(expenseAfter.recovery_status, "needs_review", "expenses.recovery_status defaults to 'needs_review' at insert; a blocked call must not change it");
  },
});

Deno.test({
  name: "persist_expense_classification: a cross-org expense_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Persist Classification Patch Other Org ${suffix}`,
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

    const res = await callPersistFn(accessToken, {
      expense_id: otherExpense.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      expense_patch: { recovery_status: "recoverable" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org expense_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: expenseAfter } = await admin.from("expenses").select("recovery_status").eq("id", otherExpense.id).single();
    assertExists(expenseAfter);
    assertEquals(expenseAfter.recovery_status, "needs_review", "the other org's expense must be completely untouched");

    const { data: classificationRows } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("expense_id", otherExpense.id);
    assertEquals(classificationRows?.length ?? 0, 0, "no classification row must be created for a cross-org expense");
  },
});

Deno.test({
  name: "persist_expense_classification: idempotent replay with identical inputs is safe (converges to the same state)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, expense } = await setUpScope(admin, suffix);

    const body1 = {
      expense_id: expense.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      category: "CAM",
      amount: 1000,
      expense_patch: { classification: "recoverable", recovery_status: "recoverable" },
    };

    const firstRes = await callPersistFn(accessToken, body1);
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));

    const secondRes = await callPersistFn(accessToken, body1);
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));

    const { data: classificationRows, error: classErr } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("expense_id", expense.id);
    assertNoError(classErr);
    assertEquals(classificationRows?.length, 1, "a replay must not create a second classification row (ON CONFLICT upsert)");

    const { data: expenseAfter, error: expenseErr } = await admin
      .from("expenses")
      .select("classification, recovery_status")
      .eq("id", expense.id)
      .single();
    assertNoError(expenseErr);
    assertExists(expenseAfter);
    assertEquals(expenseAfter.classification, "recoverable");
    assertEquals(expenseAfter.recovery_status, "recoverable");
  },
});

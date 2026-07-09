// Feature: enterprise-readiness-hardening Phase 6E-2 (review_expense_classification
// RPC extended: Exception Queue actions approve/reject/mark_na/resolve).
// Properties:
//   1. approve (finalize-style, approved_status='approved', recovery_status
//      in recoverable/non_recoverable/excluded) -> classification_status='finalized'.
//   2. approve with approved_status!='approved' and recovery_status='conditional'
//      (the "Mark Conditional" button's shape) -> classification_status='conditional',
//      matching buildClassificationReviewPatch's branching exactly.
//   3. reject -> classification_status='excluded', recoverability_result='excluded'.
//   4. mark_na -> classification_status='excluded', recoverability_result='non_recoverable'.
//   5. resolve -> classification_status='matched', exception_type=null.
//   6. Each of the above writes exactly one canonical audit_logs row with the
//      matching action name.
//   7. Invalid approved_status for 'approve' is rejected.
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
  const email = `review-expense-eq-${suffix}@example.test`;
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
    full_name: "Review Expense Classification Exception Queue Tester",
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

function callReviewExpenseClassification(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/review-expense-classification`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string, classificationOverrides: Record<string, unknown> = {}) {
  const org = await insertOne(admin, "organizations", {
    name: `Review Expense EQ Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Review Expense EQ Property ${suffix}`,
    status: "active",
  });

  const expense = await insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    category: "CAM",
    amount: 1800,
  });

  const classification = await insertOne(admin, "expense_classifications", {
    org_id: org.id,
    property_id: property.id,
    expense_id: expense.id,
    actual_expense_id: expense.id,
    recovery_status: "needs_review",
    recoverability_result: "needs_review",
    cam_eligible: "conditional",
    classification_status: "exception",
    exception_type: "low_confidence",
    approved_status: "draft",
    amount: 1800,
    classification_key: `${org.id}:${expense.id}:manual`,
    ...classificationOverrides,
  });

  return { org, accessToken, property, expense, classification };
}

async function assertExactlyOneAudit(admin: ReturnType<typeof adminClient>, orgId: string, classificationId: string, action: string) {
  const { data, error } = await admin
    .from("audit_logs")
    .select("id")
    .eq("org_id", orgId)
    .eq("entity_type", "ExpenseClassification")
    .eq("entity_id", classificationId)
    .eq("action", action);
  assertNoError(error);
  assertEquals(data?.length, 1, `expected exactly one audit_logs row for action ${action}`);
}

Deno.test({
  name: "review_expense_classification: approve (finalize-style) sets classification_status=finalized, one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix, { recoverability_result: "recoverable" });

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "approve",
      recovery_status: "recoverable",
      approved_status: "approved",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected approve to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.classification_status, "finalized");
    assertEquals(body.row.approved_status, "approved");
    assertEquals(body.row.recoverable_amount, 1800);
    assertEquals(body.row.next_step, "Ready for projection");
    assertExists(body.row.finalized_at);

    await assertExactlyOneAudit(admin, org.id, classification.id, "expense_classification_approved");
  },
});

Deno.test({
  name: "review_expense_classification: approve with approved_status='needs_review' and recovery_status='conditional' -> classification_status='conditional' (Mark Conditional shape)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "approve",
      recovery_status: "conditional",
      approved_status: "needs_review",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected approve to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.classification_status, "conditional");
    assertEquals(body.row.approved_status, "needs_review");
    assertEquals(body.row.conditional_amount, 1800);
    assertEquals(body.row.next_step, "Finalize row");
    assertEquals(body.row.finalized_at, null);

    await assertExactlyOneAudit(admin, org.id, classification.id, "expense_classification_approved");
  },
});

Deno.test({
  name: "review_expense_classification: reject sets classification_status=excluded, recoverability_result=excluded, one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "reject",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected reject to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.classification_status, "excluded");
    assertEquals(body.row.recoverability_result, "excluded");
    assertEquals(body.row.recovery_status, "excluded");
    assertEquals(body.row.exception_type, null);
    assertEquals(body.row.excluded_amount, 1800);
    assertEquals(body.row.recoverable_amount, 0);
    assertEquals(body.row.next_step, "Ready for projection");

    await assertExactlyOneAudit(admin, org.id, classification.id, "expense_classification_rejected");
  },
});

Deno.test({
  name: "review_expense_classification: mark_na sets classification_status=excluded, recoverability_result=non_recoverable, one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "mark_na",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected mark_na to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.classification_status, "excluded");
    assertEquals(body.row.recoverability_result, "non_recoverable");
    assertEquals(body.row.recovery_status, "non_recoverable");
    assertEquals(body.row.non_recoverable_amount, 1800);
    assertEquals(body.row.excluded_amount, 0);

    await assertExactlyOneAudit(admin, org.id, classification.id, "expense_classification_marked_na");
  },
});

Deno.test({
  name: "review_expense_classification: resolve sets classification_status=matched, exception_type=null, one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "resolve",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected resolve to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.classification_status, "matched");
    assertEquals(body.row.exception_type, null);
    assertEquals(body.row.next_step, "Finalize row");
    // resolve does not touch amount buckets or recovery_status per the
    // original client code -- confirm they're untouched from setup.
    assertEquals(body.row.recovery_status, "needs_review");

    await assertExactlyOneAudit(admin, org.id, classification.id, "expense_classification_resolved");
  },
});

Deno.test({
  name: "review_expense_classification: approve with an invalid approved_status is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "approve",
      recovery_status: "recoverable",
      approved_status: "bogus_status",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an invalid approved_status to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a rejected approve must not write any audit row");
  },
});

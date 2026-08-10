// Feature: enterprise-readiness-hardening Phase 6E-1 (review_expense_classification
// RPC: Finalize + Reopen only), hardened by UAT Finding A
// (20269900000055_finalize_requires_resolved_canonical_decision.sql).
// Properties:
//   1. finalize succeeds for a genuinely resolved classification: updates
//      expenses + expense_classifications with exactly the fields the old
//      client code wrote, writes exactly one canonical audit_logs row
//      (action: 'expense_classification_finalized').
//   2. reopen succeeds: resets expense_classifications state, writes exactly
//      one canonical audit_logs row (action: 'expense_classification_reopened').
//   3. A user without write access to LeaseExpenseClassification is blocked
//      (401/403), and no row/audit change occurs.
//   4. A non-existent classification_id is rejected with a clear error, no
//      row/audit change.
//   5. An invalid action value is fully rejected (atomicity) — no partial
//      writes, no audit row.
//   6. Existing behavior for other expense actions is unaffected — verified
//      by the full regression suite, not re-tested here.
//   7. (UAT Finding A) An unmatched classification (no canonical category,
//      no linked rule) cannot be finalized as recoverable, no matter what
//      recovery_status the caller claims — the classic exploit reproduced
//      against 7 real rows in the UAT.
//   8. A classification with recoverability "conditional" cannot finalize.
//   9. A classification flagged exception_type "policy_conflict" cannot
//      finalize.
//  10. Property-wide Pooled CAM: a classification with NO single linked
//      rule can still finalize as recoverable when real approved/effective
//      pooled recovery-policy coverage exists for its canonical category on
//      its property.
//  11. Direct Recovery: a rule whose recovery_method is 'direct_recovery'
//      can only finalize when the classification has a tenant_id or
//      lease_id; without either, finalize is rejected (needs_tenant_lease).
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
  const email = `review-expense-classification-${suffix}@example.test`;
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
    full_name: "Review Expense Classification Tester",
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

async function setUpOrgAndProperty(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Review Expense Classification Org ${suffix}`,
    status: "active",
  });
  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");
  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Review Expense Classification Property ${suffix}`,
    status: "active",
  });
  return { org, accessToken, userId, email, property };
}

// Baseline fixture: a genuinely RESOLVED classification -- real canonical
// category, real approved pooled-recovery rule linked to it, real service
// period. This is what "finalize succeeds" should look like after the UAT
// Finding A hardening; the pre-hardening version of this test built a
// classification with no category and no rule at all and asserted finalize
// still succeeded, which was exactly the exploit.
async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string) {
  const { org, accessToken, userId, email, property } = await setUpOrgAndProperty(admin, suffix);

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: `CAM ${suffix}`,
    normalized_key: `cam_${suffix}`,
    is_active: true,
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Tester Tenant ${suffix}`,
    status: "approved",
  });

  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id,
    lease_id: lease.id,
    property_id: property.id,
    expense_category_id: category.id,
    expense_category: "common_area_maintenance",
    payment_treatment: "reimbursable",
    recovery_method: "pro_rata_share",
    approval_status: "approved",
    recoverable_from_tenant: "yes",
  });

  const expense = await insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    lease_id: lease.id,
    expense_category_id: category.id,
    category: "CAM",
    amount: 2500,
    service_period_start: "2026-01-01",
    service_period_end: "2026-01-31",
  });

  const classification = await insertOne(admin, "expense_classifications", {
    org_id: org.id,
    property_id: property.id,
    lease_id: lease.id,
    expense_id: expense.id,
    actual_expense_id: expense.id,
    expense_category_id: category.id,
    linked_expense_rule_id: rule.id,
    lease_expense_rule_id: rule.id,
    service_period_start: "2026-01-01",
    service_period_end: "2026-01-31",
    recovery_status: "needs_review",
    recoverability_result: "needs_review",
    cam_eligible: "yes",
    classification_status: "matched",
    approved_status: "draft",
    amount: 2500,
    classification_key: `${org.id}:${expense.id}:manual`,
  });

  return { org, accessToken, userId, email, property, lease, category, rule, expense, classification };
}

Deno.test({
  name: "review_expense_classification: finalize succeeds for a resolved Pooled CAM classification, exactly one audit row, correct field shape",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, expense, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected finalize to succeed: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);
    assertEquals(body.row.classification_status, "finalized");
    assertEquals(body.row.recoverability_result, "recoverable");
    assertEquals(body.row.recovery_status, "recoverable");
    assertEquals(body.row.approved_status, "approved");
    assertExists(body.row.finalized_at);
    assertEquals(body.row.recoverable_amount, 2500);
    assertEquals(body.row.non_recoverable_amount, 0);
    assertEquals(body.row.next_step, "Send to CAM");

    const { data: expenseAfter, error: expenseErr } = await admin
      .from("expenses")
      .select("recovery_status, recoverability_result, classification, classification_updated_by")
      .eq("id", expense.id)
      .single();
    assertNoError(expenseErr);
    assertExists(expenseAfter);
    assertEquals(expenseAfter.recovery_status, "recoverable");
    assertEquals(expenseAfter.recoverability_result, "recoverable");
    assertEquals(expenseAfter.classification, "recoverable");
    assertExists(expenseAfter.classification_updated_by);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, action, actor_user_id, actor_email, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id)
      .eq("action", "expense_classification_finalized");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "finalize must write exactly one audit_logs row");
    assertExists(auditRows![0].actor_user_id);
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "review_expense_classification: reopen succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const finalizeRes = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    assertEquals(finalizeRes.status, 200);

    const reopenRes = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "reopen",
    });
    const reopenBody = await reopenRes.json();
    assertEquals(reopenRes.status, 200, `expected reopen to succeed: ${JSON.stringify(reopenBody)}`);
    assertEquals(reopenBody.row.classification_status, "matched");
    assertEquals(reopenBody.row.finalized_at, null);
    assertEquals(reopenBody.row.cam_status, null);
    assertEquals(reopenBody.row.next_step, "Finalize row");

    const { data: reopenAuditRows, error: reopenAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id)
      .eq("action", "expense_classification_reopened");
    assertNoError(reopenAuditErr);
    assertEquals(reopenAuditRows?.length, 1, "reopen must write exactly one audit_logs row");

    const { data: allAuditRows, error: allAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id);
    assertNoError(allAuditErr);
    assertEquals(allAuditRows?.length, 2, "finalize + reopen together must total exactly two audit rows, no duplicates");
  },
});

Deno.test({
  name: "review_expense_classification: user without LeaseExpenseClassification write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, classification } = await setUpScope(admin, suffix);

    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callReviewExpenseClassification(viewerToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "blocked attempt must not write any audit row");
  },
});

Deno.test({
  name: "review_expense_classification: missing classification returns a clear error, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: crypto.randomUUID(),
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for a missing classification");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a not-found attempt must not write any audit row for this org");
  },
});

Deno.test({
  name: "review_expense_classification: invalid action is fully rejected (atomicity), no partial writes",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, classification } = await setUpScope(admin, suffix);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "bogus_action",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an invalid action to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: classificationAfter, error: classErr } = await admin
      .from("expense_classifications")
      .select("classification_status, finalized_at, recovery_status")
      .eq("id", classification.id)
      .single();
    assertNoError(classErr);
    assertExists(classificationAfter);
    assertEquals(classificationAfter.classification_status, "matched", "no partial write must occur on a rejected action");
    assertEquals(classificationAfter.finalized_at, null);
    assertEquals(classificationAfter.recovery_status, "needs_review");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a rejected action must not write any audit row");
  },
});

// ---------------------------------------------------------------------------
// UAT Finding A: finalize must reject unresolved classifications, never
// trust p_recovery_status alone.
// ---------------------------------------------------------------------------

Deno.test({
  name: "UAT Finding A: an unmatched classification (no category, no rule) cannot finalize as recoverable",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property } = await setUpOrgAndProperty(admin, suffix);

    // Mirrors the 7 real Riverfront Commerce Center rows this UAT found:
    // property-level expense, no lease, no canonical category, no rule.
    const expense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      category: "unclassified_utility",
      amount: 1000,
    });
    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      linked_expense_rule_id: null,
      recovery_status: "needs_review",
      recoverability_result: "needs_review",
      cam_eligible: "needs_review",
      classification_status: "unmatched",
      exception_type: "unmatched",
      approved_status: "draft",
      amount: 1000,
      classification_key: `${org.id}:${expense.id}:manual`,
    });

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected finalize to be rejected: ${JSON.stringify(body)}`);
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not resolved|needs_category/i.test(body.message || ""), true, `expected an unresolved-decision message: ${JSON.stringify(body)}`);

    const { data: classificationAfter } = await admin
      .from("expense_classifications")
      .select("classification_status, recoverability_result, finalized_at")
      .eq("id", classification.id)
      .single();
    assertEquals(classificationAfter?.classification_status, "unmatched", "rejected finalize must not change classification_status");
    assertEquals(classificationAfter?.recoverability_result, "needs_review", "rejected finalize must not fabricate recoverable");
    assertEquals(classificationAfter?.finalized_at, null);
  },
});

Deno.test({
  name: "UAT Finding A: a conditional classification cannot finalize",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, classification } = await setUpScope(admin, suffix);

    await admin.from("expense_classifications").update({ recoverability_result: "conditional" }).eq("id", classification.id);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected finalize to be rejected: ${JSON.stringify(body)}`);
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/conditional_review/i.test(body.message || ""), true, `expected a conditional_review message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "UAT Finding A: a policy_conflict classification cannot finalize",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, classification } = await setUpScope(admin, suffix);

    await admin.from("expense_classifications").update({ exception_type: "policy_conflict" }).eq("id", classification.id);

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected finalize to be rejected: ${JSON.stringify(body)}`);
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/policy_conflict/i.test(body.message || ""), true, `expected a policy_conflict message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "UAT Finding A: property-wide Pooled CAM can finalize without a single linked rule when valid pooled policy coverage exists",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId, email, property, category, rule } = await setUpScope(admin, suffix);

    // Materialize the SAME approved rule into a real recovery policy via the
    // existing RPC (not a hand-built policy row), then classify a SECOND,
    // property-level expense with NO single linked rule against that
    // category -- exactly the "pooled CAM aggregates across the property"
    // shape the instruction requires.
    const { data: materializeResult, error: materializeError } = await admin.rpc("materialize_lease_recovery_policy", {
      p_org_id: org.id,
      p_rule_id: rule.id,
      p_actor_user_id: userId,
      p_actor_email: email,
    });
    assertNoError(materializeError);
    assertExists(materializeResult);

    const pooledExpense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      expense_category_id: category.id,
      category: "CAM",
      amount: 800,
      service_period_start: "2026-01-05",
      service_period_end: "2026-01-25",
    });
    const pooledClassification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: pooledExpense.id,
      actual_expense_id: pooledExpense.id,
      expense_category_id: category.id,
      linked_expense_rule_id: null,
      service_period_start: "2026-01-05",
      service_period_end: "2026-01-25",
      recovery_status: "needs_review",
      recoverability_result: "needs_review",
      cam_eligible: "yes",
      classification_status: "matched",
      approved_status: "draft",
      amount: 800,
      classification_key: `${org.id}:${pooledExpense.id}:manual`,
    });

    const res = await callReviewExpenseClassification(accessToken, {
      classification_id: pooledClassification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected pooled-without-rule finalize to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.classification_status, "finalized");
    assertEquals(body.row.recoverability_result, "recoverable");
  },
});

Deno.test({
  name: "UAT Finding A: Direct Recovery requires a tenant or lease -- rejected without one, accepted with one",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, category } = await setUpScope(admin, suffix);

    const directLease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Direct Recovery Tenant ${suffix}`,
      status: "approved",
    });
    const directRule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id,
      lease_id: directLease.id,
      property_id: property.id,
      expense_category_id: category.id,
      expense_category: "utilities",
      payment_treatment: "reimbursable",
      recovery_method: "direct_recovery",
      approval_status: "approved",
      recoverable_from_tenant: "yes",
    });

    // No tenant_id / lease_id on the classification -- must be rejected.
    const noTenantExpense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      expense_category_id: category.id,
      category: "utilities",
      amount: 500,
      service_period_start: "2026-02-01",
      service_period_end: "2026-02-28",
    });
    const noTenantClassification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: noTenantExpense.id,
      actual_expense_id: noTenantExpense.id,
      expense_category_id: category.id,
      linked_expense_rule_id: directRule.id,
      lease_id: null,
      tenant_id: null,
      service_period_start: "2026-02-01",
      service_period_end: "2026-02-28",
      recovery_status: "needs_review",
      recoverability_result: "needs_review",
      cam_eligible: "yes",
      classification_status: "matched",
      approved_status: "draft",
      amount: 500,
      classification_key: `${org.id}:${noTenantExpense.id}:manual`,
    });

    const rejectedRes = await callReviewExpenseClassification(accessToken, {
      classification_id: noTenantClassification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const rejectedBody = await rejectedRes.json();
    assertEquals(rejectedBody.error, true, `expected direct-recovery-without-tenant to be rejected: ${JSON.stringify(rejectedBody)}`);
    assertEquals(rejectedRes.status, 400, `expected 400, got ${rejectedRes.status}: ${JSON.stringify(rejectedBody)}`);
    assertEquals(/needs_tenant_lease/i.test(rejectedBody.message || ""), true, `expected a needs_tenant_lease message: ${JSON.stringify(rejectedBody)}`);

    // Same rule, same category, but WITH a lease_id -- must succeed.
    const withLeaseExpense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      lease_id: directLease.id,
      expense_category_id: category.id,
      category: "utilities",
      amount: 500,
      service_period_start: "2026-02-01",
      service_period_end: "2026-02-28",
    });
    const withLeaseClassification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      lease_id: directLease.id,
      expense_id: withLeaseExpense.id,
      actual_expense_id: withLeaseExpense.id,
      expense_category_id: category.id,
      linked_expense_rule_id: directRule.id,
      service_period_start: "2026-02-01",
      service_period_end: "2026-02-28",
      recovery_status: "needs_review",
      recoverability_result: "needs_review",
      cam_eligible: "yes",
      classification_status: "matched",
      approved_status: "draft",
      amount: 500,
      classification_key: `${org.id}:${withLeaseExpense.id}:manual`,
    });

    const acceptedRes = await callReviewExpenseClassification(accessToken, {
      classification_id: withLeaseClassification.id,
      action: "finalize",
      recovery_status: "recoverable",
    });
    const acceptedBody = await acceptedRes.json();
    assertEquals(acceptedRes.status, 200, `expected direct-recovery-with-lease to succeed: ${JSON.stringify(acceptedBody)}`);
    assertEquals(acceptedBody.row.classification_status, "finalized");
  },
});

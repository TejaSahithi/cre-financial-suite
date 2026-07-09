// Feature: enterprise-readiness-hardening Phase 6D-1 (save_lease_expense_rule_set).
// Properties:
//   1. Create path (p_rule_set_id null): creates a lease_expense_rule_set,
//      upserts rules (matching rule_key), inserts values/clauses matched by
//      rule_key, writes exactly one canonical audit_logs row.
//   2. Update path (existing p_rule_set_id): reuses the rule_set row,
//      re-saving with a changed rule_key set replaces
//      lease_expense_values/lease_expense_rule_clauses scoped to the saved
//      rules (no stale leftovers from a prior save under the same rule_set).
//   3. A user without LeaseExpenseRules/LeaseReview write access is blocked
//      (401/403), and no row/audit change occurs.
//   4. An unknown lease_id (wrong org boundary) is rejected with a clear
//      error, no side effects.
//   5. Atomicity: a malformed rule row that violates a NOT NULL/type
//      constraint mid-transaction rolls back the whole save -- no partial
//      rule_set/rules/values/clauses state, no audit row.
//   6. Exactly one audit_logs row per successful save, with before/after and
//      rule/value/clause counts in metadata.
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
  const email = `save-lease-rule-set-${suffix}@example.test`;
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
    full_name: "Save Lease Rule Set Tester",
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

function callSaveRuleSet(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/save-lease-expense-rule-set`, {
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
    name: `Save Lease Rule Set Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Save Lease Rule Set Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Save Lease Rule Set Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
  });

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: "CAM",
    normalized_key: `cam_${suffix}`,
  });

  return { org, accessToken, userId, email, property, lease, category };
}

function buildRule(overrides: Record<string, unknown> = {}) {
  return {
    rule_key: overrides.rule_key || `rule_${crypto.randomUUID()}`,
    rule_type: "cam",
    row_status: "mentioned",
    expense_category: "CAM",
    review_status: "needs_review",
    approval_status: "draft",
    recoverable_from_tenant: "yes",
    cam_eligible: "yes",
    payment_treatment: "reimbursable",
    billing_treatment: "prorated",
    estimated_annual_amount: 12000,
    estimated_monthly_amount: 1000,
    ...overrides,
  };
}

Deno.test({
  name: "save_lease_expense_rule_set: create path creates rule_set + rules + values + clauses, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, property, category } = await setUpScope(admin, suffix);

    const ruleKey = `rule_${suffix}_a`;
    const res = await callSaveRuleSet(accessToken, {
      lease_id: lease.id,
      rule_set_id: null,
      version: 1,
      status: "draft",
      extraction_version: "lease_rule_pipeline_v3",
      property_id: property.id,
      rules: [buildRule({ rule_key: ruleKey, expense_category_id: category.id })],
      values: [{ rule_key: ruleKey, extracted_value: 5000, final_value: 5000, frequency: "yearly" }],
      clauses: [{ rule_key: ruleKey, page_number: 3, clause_type: "supporting_text", clause_text: "Tenant shall pay CAM.", confidence: 0.9 }],
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected create to succeed: ${JSON.stringify(body)}`);
    assertExists(body.rule_set_id);
    assertEquals(body.rule_count, 1);
    assertEquals(body.value_count, 1);
    assertEquals(body.clause_count, 1);
    assertExists(body.audit_log_id);

    const { data: ruleSet, error: ruleSetErr } = await admin
      .from("lease_expense_rule_sets")
      .select("*")
      .eq("id", body.rule_set_id)
      .single();
    assertNoError(ruleSetErr);
    assertExists(ruleSet);
    assertEquals(ruleSet.org_id, org.id);
    assertEquals(ruleSet.lease_id, lease.id);
    assertEquals(ruleSet.status, "draft");
    assertEquals(ruleSet.version, 1);

    const { data: rules, error: rulesErr } = await admin
      .from("lease_expense_rules")
      .select("*")
      .eq("rule_set_id", body.rule_set_id);
    assertNoError(rulesErr);
    assertEquals(rules?.length, 1);
    assertEquals(rules![0].rule_key, ruleKey);
    assertEquals(rules![0].expense_category_id, category.id);

    const { data: values, error: valuesErr } = await admin
      .from("lease_expense_values")
      .select("*")
      .eq("rule_id", rules![0].id);
    assertNoError(valuesErr);
    assertEquals(values?.length, 1);
    assertEquals(Number(values![0].final_value), 5000);

    const { data: clauses, error: clausesErr } = await admin
      .from("lease_expense_rule_clauses")
      .select("*")
      .eq("lease_expense_rule_id", rules![0].id);
    assertNoError(clausesErr);
    assertEquals(clauses?.length, 1);
    assertEquals(clauses![0].clause_text, "Tenant shall pay CAM.");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, action, actor_user_id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRuleSet")
      .eq("entity_id", body.rule_set_id)
      .eq("action", "lease_expense_rule_set_saved");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "create must write exactly one audit_logs row");
    assertExists(auditRows![0].actor_user_id);
    assertEquals(auditRows![0].before, null);
    assertExists(auditRows![0].after);
    assertEquals((auditRows![0].metadata as Record<string, unknown>).rule_set_action, "created");
  },
});

Deno.test({
  name: "save_lease_expense_rule_set: update path reuses rule_set, replaces values/clauses scoped to saved rules",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, property, category } = await setUpScope(admin, suffix);

    const ruleKeyA = `rule_${suffix}_a`;
    const createRes = await callSaveRuleSet(accessToken, {
      lease_id: lease.id,
      rule_set_id: null,
      version: 1,
      status: "draft",
      property_id: property.id,
      rules: [buildRule({ rule_key: ruleKeyA, expense_category_id: category.id })],
      values: [{ rule_key: ruleKeyA, final_value: 1000, frequency: "yearly" }],
      clauses: [],
    });
    const createBody = await createRes.json();
    assertEquals(createRes.status, 200, JSON.stringify(createBody));
    const ruleSetId = createBody.rule_set_id;

    const { data: firstRule } = await admin
      .from("lease_expense_rules")
      .select("id")
      .eq("rule_set_id", ruleSetId)
      .eq("rule_key", ruleKeyA)
      .single();
    assertExists(firstRule);

    const ruleKeyB = `rule_${suffix}_b`;
    const updateRes = await callSaveRuleSet(accessToken, {
      lease_id: lease.id,
      rule_set_id: ruleSetId,
      status: "draft",
      property_id: property.id,
      rules: [
        buildRule({ rule_key: ruleKeyA, expense_category_id: category.id, estimated_annual_amount: 9999 }),
        buildRule({ rule_key: ruleKeyB, expense_category_id: category.id }),
      ],
      values: [
        { rule_key: ruleKeyA, final_value: 2000, frequency: "yearly" },
        { rule_key: ruleKeyB, final_value: 3000, frequency: "yearly" },
      ],
      clauses: [],
    });
    const updateBody = await updateRes.json();
    assertEquals(updateRes.status, 200, JSON.stringify(updateBody));
    assertEquals(updateBody.rule_set_id, ruleSetId, "update must reuse the same rule_set id");
    assertEquals(updateBody.rule_count, 2);

    const { data: rulesAfter, error: rulesAfterErr } = await admin
      .from("lease_expense_rules")
      .select("id, rule_key, estimated_annual_amount")
      .eq("rule_set_id", ruleSetId);
    assertNoError(rulesAfterErr);
    assertEquals(rulesAfter?.length, 2, "reused rule_key must update in place, not duplicate");
    const ruleA = rulesAfter!.find((r: Record<string, unknown>) => r.rule_key === ruleKeyA);
    assertExists(ruleA);
    assertEquals(Number(ruleA!.estimated_annual_amount), 9999);
    assertEquals(ruleA!.id, firstRule!.id, "the same rule_key must update the existing row, not create a new one");

    const { data: valuesAfter, error: valuesAfterErr } = await admin
      .from("lease_expense_values")
      .select("final_value, rule_id")
      .in("rule_id", rulesAfter!.map((r: Record<string, unknown>) => r.id));
    assertNoError(valuesAfterErr);
    assertEquals(valuesAfter?.length, 2, "values must be replaced, not accumulated, across saves");

    const { data: allAuditRows, error: allAuditErr } = await admin
      .from("audit_logs")
      .select("id, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRuleSet")
      .eq("entity_id", ruleSetId)
      .eq("action", "lease_expense_rule_set_saved");
    assertNoError(allAuditErr);
    assertEquals(allAuditRows?.length, 2, "create + update together must total exactly two audit rows");
    const updateAudit = allAuditRows!.find((r: Record<string, unknown>) => (r.metadata as Record<string, unknown>).rule_set_action === "updated");
    assertExists(updateAudit);
  },
});

Deno.test({
  name: "save_lease_expense_rule_set: user without LeaseExpenseRules write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease, property, category } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callSaveRuleSet(viewerToken, {
      lease_id: lease.id,
      rule_set_id: null,
      status: "draft",
      property_id: property.id,
      rules: [buildRule({ expense_category_id: category.id })],
      values: [],
      clauses: [],
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: ruleSets, error: ruleSetsErr } = await admin
      .from("lease_expense_rule_sets")
      .select("id")
      .eq("lease_id", lease.id);
    assertNoError(ruleSetsErr);
    assertEquals(ruleSets?.length ?? 0, 0, "blocked attempt must not create a rule_set row");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRuleSet");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "blocked attempt must not write any audit row");
  },
});

Deno.test({
  name: "save_lease_expense_rule_set: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, category } = await setUpScope(admin, suffix);

    const bogusLeaseId = crypto.randomUUID();
    const res = await callSaveRuleSet(accessToken, {
      lease_id: bogusLeaseId,
      rule_set_id: null,
      status: "draft",
      rules: [buildRule({ expense_category_id: category.id })],
      values: [],
      clauses: [],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);

    const { data: ruleSets, error: ruleSetsErr } = await admin
      .from("lease_expense_rule_sets")
      .select("id")
      .eq("org_id", org.id);
    assertNoError(ruleSetsErr);
    assertEquals(ruleSets?.length ?? 0, 0, "a not-found lease must not create a rule_set row");
  },
});

Deno.test({
  name: "save_lease_expense_rule_set: p_superseded_rule_ids deletes stale rows as part of the same save",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, property, category } = await setUpScope(admin, suffix);

    const ruleKeyStale = `rule_${suffix}_stale`;
    const createRes = await callSaveRuleSet(accessToken, {
      lease_id: lease.id,
      rule_set_id: null,
      version: 1,
      status: "draft",
      property_id: property.id,
      rules: [buildRule({ rule_key: ruleKeyStale, expense_category_id: category.id })],
      values: [],
      clauses: [],
    });
    const createBody = await createRes.json();
    assertEquals(createRes.status, 200, JSON.stringify(createBody));
    const ruleSetId = createBody.rule_set_id;

    const { data: staleRule } = await admin
      .from("lease_expense_rules")
      .select("id")
      .eq("rule_set_id", ruleSetId)
      .eq("rule_key", ruleKeyStale)
      .single();
    assertExists(staleRule);

    const ruleKeyFresh = `rule_${suffix}_fresh`;
    const updateRes = await callSaveRuleSet(accessToken, {
      lease_id: lease.id,
      rule_set_id: ruleSetId,
      status: "draft",
      property_id: property.id,
      rules: [buildRule({ rule_key: ruleKeyFresh, expense_category_id: category.id })],
      values: [],
      clauses: [],
      superseded_rule_ids: [staleRule!.id],
    });
    const updateBody = await updateRes.json();
    assertEquals(updateRes.status, 200, JSON.stringify(updateBody));
    assertEquals(updateBody.superseded_count, 1);

    const { data: rulesAfter, error: rulesAfterErr } = await admin
      .from("lease_expense_rules")
      .select("id, rule_key")
      .eq("rule_set_id", ruleSetId);
    assertNoError(rulesAfterErr);
    assertEquals(rulesAfter?.length, 1, "the superseded rule must be gone, only the fresh rule remains");
    assertEquals(rulesAfter![0].rule_key, ruleKeyFresh);
  },
});

Deno.test({
  name: "save_lease_expense_rule_set: atomicity - a malformed rule rolls back the whole save, no partial state, no audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);

    // expense_category_id is NOT NULL on lease_expense_rules -- omitting it
    // (no valid category resolved) must fail the whole transaction, not
    // just skip this one row.
    const ruleKey = `rule_${suffix}_bad`;
    const { data, error } = await admin.rpc("save_lease_expense_rule_set", {
      p_org_id: org.id,
      p_lease_id: lease.id,
      p_actor_user_id: (await admin.auth.admin.listUsers()).data.users[0]?.id,
      p_actor_email: "atomicity-test@example.test",
      p_rule_set_id: null,
      p_version: 1,
      p_status: "draft",
      p_extraction_version: "lease_rule_pipeline_v3",
      p_property_id: null,
      p_rules: [{ rule_key: ruleKey, row_status: "mentioned" }],
      p_values: [],
      p_clauses: [],
    });
    assertExists(error, "a NOT NULL violation on expense_category_id must surface as an error");
    assertEquals(data, null);

    const { data: ruleSets, error: ruleSetsErr } = await admin
      .from("lease_expense_rule_sets")
      .select("id")
      .eq("lease_id", lease.id);
    assertNoError(ruleSetsErr);
    assertEquals(ruleSets?.length ?? 0, 0, "the whole transaction (including the rule_set insert) must roll back");

    const { data: rules, error: rulesErr } = await admin
      .from("lease_expense_rules")
      .select("id")
      .eq("lease_id", lease.id);
    assertNoError(rulesErr);
    assertEquals(rules?.length ?? 0, 0);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseExpenseRuleSet");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a rolled-back save must not leave an audit row");
  },
});

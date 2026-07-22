// Feature: enterprise-readiness-hardening Phase 6X-6 (save_lease_rule_amount_cam_input).
// Server-owns LeaseExpenseClassification.jsx's createLeaseRuleAmountCamInput
// classification-write step (the "rule_missing_actual" CAM bookkeeping case).
// Properties:
//   1. Create branch: no existing row -> a new rule_missing_actual row is
//      created (this is the branch that was silently broken before this
//      phase, since expense_classifications.expense_id was NOT NULL).
//   2. Update branch: an existing rule_missing_actual row for the same
//      rule is updated in place, not duplicated.
//   3. Cross-org property/building/unit/lease/tenant references rejected.
//   4. A rule that is not published_to_cam is rejected.
//   5. Idempotent replay (identical payload) is a safe no-op.
//   6. Exactly one audit row for a real change.
//   7. A user without write access is blocked, zero side effects.
//   8. An unknown rule_id is rejected.
//   9. A negative amount is rejected.
//   10. An unrecognized field in the classification patch is rejected.
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
  const email = `save-rule-amount-cam-input-${suffix}@example.test`;
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
    full_name: "Save Rule Amount CAM Input Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/save-lease-rule-amount-cam-input`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function insertRule(admin: ReturnType<typeof adminClient>, org: { id: string }, lease: { id: string }, property: { id: string }, overrides: Record<string, unknown> = {}) {
  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: `Rule Amount Category ${crypto.randomUUID()}`,
    normalized_key: `rule_amount_category_${crypto.randomUUID()}`,
  });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
    org_id: org.id,
    lease_id: lease.id,
  });
  return insertOne(admin, "lease_expense_rules", {
    org_id: org.id,
    rule_set_id: ruleSet.id,
    expense_category_id: category.id,
    lease_id: lease.id,
    property_id: property.id,
    published_to_cam: true,
    ...overrides,
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Save Rule Amount CAM Input Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Save Rule Amount CAM Input Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
  });

  const rule = await insertRule(admin, org, lease, property);

  return { org, accessToken, property, lease, rule };
}

function classificationPatch(overrides: Record<string, unknown> = {}) {
  return {
    classification_key: `rule_amount:test:${crypto.randomUUID()}`,
    category: "cam_maintenance",
    amount: 1250,
    fiscal_year: 2026,
    ...overrides,
  };
}

Deno.test({
  name: "save_lease_rule_amount_cam_input: create branch creates a new rule_missing_actual row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease, rule } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id }),
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(body.classification.row_type, "rule_missing_actual");
    assertEquals(body.classification.expense_id, null);
    assertEquals(Number(body.classification.amount), 1250);
    assertEquals(body.classification.cam_status, "cam_ready");
    assertEquals(body.classification.classification_status, "finalized");

    const { data: rows, error } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("org_id", org.id)
      .eq("lease_expense_rule_id", rule.id)
      .eq("row_type", "rule_missing_actual");
    assertNoError(error);
    assertEquals(rows?.length, 1, "exactly one row_type=rule_missing_actual row must exist");
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: update branch updates the existing row in place, does not duplicate",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease, rule } = await setUpScope(admin, suffix);

    const firstRes = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id, amount: 1000 }),
    });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));

    const secondRes = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id, amount: 2000 }),
    });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, true);
    assertEquals(Number(secondBody.classification.amount), 2000);
    assertEquals(secondBody.classification.id, firstBody.classification.id, "must update the same row, not create a second one");

    const { data: rows, error } = await admin
      .from("expense_classifications")
      .select("id, amount")
      .eq("org_id", org.id)
      .eq("lease_expense_rule_id", rule.id)
      .eq("row_type", "rule_missing_actual");
    assertNoError(error);
    assertEquals(rows?.length, 1, "still exactly one row after the update");
    assertEquals(Number(rows![0].amount), 2000);
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: cross-org property/lease references are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, rule } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Save Rule Amount Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property ${suffix}`,
      status: "active",
    });

    const propRes = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: otherProperty.id }),
    });
    const propBody = await propRes.json();
    assertEquals(propBody.error, true, "expected a cross-org property_id to be rejected");
    assertEquals(propRes.status, 400, JSON.stringify(propBody));

    const otherLease = await insertOne(admin, "leases", {
      org_id: otherOrg.id,
      property_id: otherProperty.id,
    });
    const leaseRes = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ lease_id: otherLease.id }),
    });
    const leaseBody = await leaseRes.json();
    assertEquals(leaseBody.error, true, "expected a cross-org lease_id to be rejected");
    assertEquals(leaseRes.status, 400, JSON.stringify(leaseBody));
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: a rule that is not published_to_cam is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpScope(admin, suffix);
    const unpublishedRule = await insertRule(admin, org, lease, property, { published_to_cam: false });

    const res = await callFn(accessToken, {
      rule_id: unpublishedRule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id }),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unpublished rule to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: rows } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("lease_expense_rule_id", unpublishedRule.id);
    assertEquals(rows?.length ?? 0, 0, "no row should be created for an unpublished rule");
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: idempotent replay (identical payload) is a safe no-op, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease, rule } = await setUpScope(admin, suffix);
    const patch = classificationPatch({ property_id: property.id, lease_id: lease.id });

    const firstRes = await callFn(accessToken, { rule_id: rule.id, classification: patch });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callFn(accessToken, { rule_id: rule.id, classification: patch });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay with an identical payload must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("action", "expense_classification_rule_amount_saved")
      .eq("entity_id", firstBody.classification.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: exactly one audit row for a real change (create)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease, rule } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id }),
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("action", "expense_classification_rule_amount_saved")
      .eq("entity_id", body.classification.id);
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1);
    assertEquals(auditRows![0].before, null, "before must be null for a genuine create");
    assertExists(auditRows![0].after);
    assertEquals((auditRows![0].metadata as Record<string, unknown>).rule_id, rule.id);
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease, rule } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id }),
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: rows } = await admin
      .from("expense_classifications")
      .select("id")
      .eq("lease_expense_rule_id", rule.id);
    assertEquals(rows?.length ?? 0, 0, "the blocked attempt must not create any row");
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: unknown rule_id is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      rule_id: crypto.randomUUID(),
      classification: classificationPatch(),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown rule_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: a negative amount is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, lease, rule } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id, amount: -100 }),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a negative amount to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

Deno.test({
  name: "save_lease_rule_amount_cam_input: an unrecognized field is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, property, lease, rule } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      rule_id: rule.id,
      classification: classificationPatch({ property_id: property.id, lease_id: lease.id, cam_status: "cam_ready" }),
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unrecognized field to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

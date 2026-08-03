// CAM Publication Boundary — corrected, narrow-scope PR (see
// 20260904000000_cam_publication_boundary.sql, 20260905000000_cam_publication_rpcs.sql,
// 20260906000000_cam_publication_remainder_columns.sql,
// 20260907000000_cam_publication_remainder_checks.sql, and the compute-cam
// publication-boundary fix in compute-cam/index.ts).
//
// This is the real-database test list required by the corrected PR scope:
// "Add real-database tests for unpublished exclusion, one-time publication,
// duplicate publication, withdrawal, republishing, stale CAM runs, locked
// CAM runs, allocation balancing, hierarchy validation, and cross-organization
// access."
//
// Explicitly OUT of scope / not testable in this narrow PR (documented, not
// silently skipped):
//   - "rule outside effective dates is rejected": lease_expense_rules has no
//     effective-date columns in this schema — nothing to test.
//   - "multiple allocation lines" as a first-class feature: NOT built (see
//     migration header comments) — Part B17 below proves the current model
//     structurally BLOCKS a second classification row per expense
//     (UNIQUE(org_id, expense_id)), which is the honest current behavior,
//     not a simulation of a feature that doesn't exist.
//
// PART A reproduces compute-cam/index.ts's exact modified functions
// (fetchCamReadyInputs's query chain, buildCamReadyExpenses verbatim) against
// a minimal fake admin client — the same pattern cam-scope-awareness.test.ts
// already established for this exact file, because Deno.serve() at
// compute-cam/index.ts's top level is an import-time side effect and the
// file cannot be imported directly in a test.
//
// PART B calls the real, deployed edge functions
// (send-expense-classification-to-cam, review-expense-classification,
// withdraw-cam-expense-input) over HTTP against the real local database.

import {
  assertEquals,
  assertExists,
  assertNotEquals,
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
  const email = `cam-publication-boundary-${suffix}@example.test`;
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
    full_name: "CAM Publication Boundary Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", { user_id: userId, org_id: orgId, role });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { userId, email, accessToken };
}

function callSendToCam(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/send-expense-classification-to-cam`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}`, "apikey": ANON_KEY },
    body: JSON.stringify(body),
  });
}

function callReview(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/review-expense-classification`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}`, "apikey": ANON_KEY },
    body: JSON.stringify(body),
  });
}

function callWithdraw(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/withdraw-cam-expense-input`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${accessToken}`, "apikey": ANON_KEY },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
async function setUpOrgPropertyLease(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", { name: `CAM Pub Org ${suffix}`, status: "active" });
  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Pub Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id });
  return { org, accessToken, userId, email, property, lease };
}

async function insertExpense(admin: ReturnType<typeof adminClient>, org: { id: string }, property: { id: string }, overrides: Record<string, unknown> = {}) {
  return insertOne(admin, "expenses", {
    org_id: org.id,
    property_id: property.id,
    category: "CAM",
    amount: 5000,
    approval_status: "approved",
    approved_status: "approved",
    ...overrides,
  });
}

async function insertRule(admin: ReturnType<typeof adminClient>, org: { id: string }, lease: { id: string }, property: { id: string }, overrides: Record<string, unknown> = {}) {
  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id,
    category_name: `CAM Pub Category ${crypto.randomUUID()}`,
    normalized_key: `cam_pub_category_${crypto.randomUUID()}`,
  });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  return insertOne(admin, "lease_expense_rules", {
    org_id: org.id,
    rule_set_id: ruleSet.id,
    expense_category_id: category.id,
    lease_id: lease.id,
    property_id: property.id,
    published_to_cam: true,
    approval_status: "approved",
    payment_treatment: "recoverable",
    is_excluded: false,
    rule_type: "expense_recovery",
    ...overrides,
  });
}

// Fully CAM-ready ("automatic", no manual reason needed): finalized,
// recoverable, cam_eligible=yes, approved expense + approved rule, amount
// fully allocated (no remainder), service_period_start inside fiscal 2026
// (so send-to-cam's fiscal_year derivation lands on 2026, matching the
// computation_snapshots fixtures used by the stale/locked tests below).
async function insertReadyClassification(
  admin: ReturnType<typeof adminClient>,
  org: { id: string },
  property: { id: string },
  lease: { id: string },
  expense: { id: string; amount: number },
  rule: { id: string } | null,
  overrides: Record<string, unknown> = {},
) {
  return insertOne(admin, "expense_classifications", {
    org_id: org.id,
    property_id: property.id,
    lease_id: lease.id,
    expense_id: expense.id,
    actual_expense_id: expense.id,
    lease_expense_rule_id: rule?.id ?? null,
    classification_key: `cam-pub:${crypto.randomUUID()}`,
    classification_status: "finalized",
    approved_status: "approved",
    recovery_status: "recoverable",
    recoverability_result: "recoverable",
    cam_eligible: "yes",
    condition_resolved: true,
    amount: expense.amount,
    service_period_start: "2026-03-15",
    ...overrides,
  });
}

// ===========================================================================
// PART A — compute-cam publication boundary (reproduced verbatim from
// compute-cam/index.ts; see that file for the live source).
// ===========================================================================

function makeFakeAdmin(seed: Record<string, any[]>) {
  const tables: Record<string, any[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));

  function selectBuilder(rows: any[]) {
    let filtered = [...rows];
    const builder: any = {
      eq(col: string, val: any) {
        filtered = filtered.filter((r) => r[col] === val);
        return builder;
      },
      then(resolve: any) {
        resolve({ data: filtered, error: null });
      },
    };
    return builder;
  }

  return {
    from(table: string) {
      tables[table] = tables[table] ?? [];
      return { select(_cols?: string) { return selectBuilder(tables[table]); } };
    },
  };
}

// Verbatim reproduction of compute-cam/index.ts's fetchCamReadyInputs query
// chain (the exact publication-boundary fix: .eq("publication_status", "published")
// replacing the old .eq("status", "cam_ready")).
async function fetchCamReadyInputsQuery(admin: any, orgId: string, propertyId: string) {
  const { data } = await admin
    .from("cam_expense_inputs")
    .select("*")
    .eq("org_id", orgId)
    .eq("property_id", propertyId)
    .eq("publication_status", "published");
  return data ?? [];
}

// Verbatim reproduction of compute-cam/index.ts's camReadyRowMatchesScope,
// camReadyExpenseFromRow, buildCamReadyExpenses (property-scope only, the
// subset this test needs).
function normalizeText(value: unknown) {
  return String(value || "").trim().toLowerCase();
}
function asNumber(value: unknown) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}
function camReadyExpenseFromRow(row: any, sourceLabel: string) {
  const camInputType = normalizeText(row?.cam_input_type || row?.source || sourceLabel);
  return {
    id: String(row?.id || row?.classification_result_id || row?.actual_expense_id || row?.lease_expense_rule_id),
    property_id: row?.property_id,
    amount: asNumber(row?.amount),
    category: row?.category,
    allocation_meta: { cam_input_type: camInputType },
  };
}
function buildCamReadyExpenses({ inputs, propertyId }: { inputs: any[]; propertyId: string }) {
  const rows: any[] = [];
  const seen = new Set<string>();
  const addRow = (row: any, sourceLabel: string) => {
    const inputType = normalizeText(row?.cam_input_type || row?.source || sourceLabel);
    if (row?.publication_status && row.publication_status !== "published") return;
    if (row?.property_id && row.property_id !== propertyId) return;
    if (!["actual_expense", "lease_rule_amount"].includes(inputType)) return;
    const dedupeKey = row?.classification_result_id
      ? `classification:${row.classification_result_id}`
      : `row:${row.id}`;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    rows.push(camReadyExpenseFromRow(row, sourceLabel));
  };
  for (const input of inputs) addRow(input, normalizeText(input?.source || "cam_expense_input"));
  return rows.filter((row) => row.amount > 0 && row.category);
}

Deno.test("compute-cam boundary: fetchCamReadyInputs query only returns publication_status=published rows", async () => {
  const admin = makeFakeAdmin({
    cam_expense_inputs: [
      { id: "row-published", org_id: "org-A", property_id: "prop-1", publication_status: "published", amount: 100, category: "CAM", cam_input_type: "actual_expense" },
      { id: "row-withdrawn", org_id: "org-A", property_id: "prop-1", publication_status: "withdrawn", amount: 200, category: "CAM", cam_input_type: "actual_expense" },
      { id: "row-superseded", org_id: "org-A", property_id: "prop-1", publication_status: "superseded", amount: 300, category: "CAM", cam_input_type: "actual_expense" },
    ],
  });
  const rows = await fetchCamReadyInputsQuery(admin, "org-A", "prop-1");
  assertEquals(rows.length, 1, "only the published row must be returned");
  assertEquals(rows[0].id, "row-published");
});

Deno.test("compute-cam boundary: buildCamReadyExpenses defense-in-depth skips a non-published row even if it reaches this stage", () => {
  const inputs = [
    { id: "a", classification_result_id: "c1", property_id: "prop-1", publication_status: "published", amount: 100, category: "CAM", cam_input_type: "actual_expense" },
    { id: "b", classification_result_id: "c2", property_id: "prop-1", publication_status: "withdrawn", amount: 999, category: "CAM", cam_input_type: "actual_expense" },
  ];
  const result = buildCamReadyExpenses({ inputs, propertyId: "prop-1" });
  assertEquals(result.length, 1, "withdrawn row must never contribute to the recoverable pool, even as a defense-in-depth check");
  assertEquals(result[0].amount, 100);
});

Deno.test("compute-cam boundary: a published actual_expense row is correctly included with its amount/category", () => {
  const inputs = [
    { id: "a", classification_result_id: "c1", property_id: "prop-1", publication_status: "published", amount: 1234.56, category: "Utilities", cam_input_type: "actual_expense" },
  ];
  const result = buildCamReadyExpenses({ inputs, propertyId: "prop-1" });
  assertEquals(result.length, 1);
  assertEquals(result[0].amount, 1234.56);
  assertEquals(result[0].category, "Utilities");
});

// ===========================================================================
// PART B — real database + real HTTP tests against the deployed edge
// functions and RPCs.
// ===========================================================================

Deno.test({
  name: "B1: an unapproved expense cannot enter CAM (expense_not_approved blocker, no cam_expense_inputs row)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property, { approval_status: "pending", approved_status: "draft" });
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const res = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(body.error, true);
    assertEquals(body.blockers?.includes("expense_not_approved"), true, `expected expense_not_approved blocker: ${JSON.stringify(body)}`);

    const { data: inputs } = await admin.from("cam_expense_inputs").select("id").eq("classification_result_id", classification.id);
    assertEquals(inputs?.length ?? 0, 0, "an unapproved expense must never produce a cam_expense_inputs row");
  },
});

Deno.test({
  name: "B2: an unapproved lease rule cannot enter CAM (rule_not_approved blocker, no cam_expense_inputs row)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property, { approval_status: "needs_review" });
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const res = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(body.blockers?.includes("rule_not_approved"), true, `expected rule_not_approved blocker: ${JSON.stringify(body)}`);

    const { data: inputs } = await admin.from("cam_expense_inputs").select("id").eq("classification_result_id", classification.id);
    assertEquals(inputs?.length ?? 0, 0, "an unapproved rule must never produce a cam_expense_inputs row");
  },
});

Deno.test({
  name: "B3: a finalized, fully approved classification publishes successfully (one published cam_expense_inputs row, version 1)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const res = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));
    assertExists(body.cam_input_id);
    assertEquals(body.already_sent, false);

    const { data: input, error } = await admin.from("cam_expense_inputs").select("*").eq("id", body.cam_input_id).single();
    assertNoError(error);
    assertEquals(input.publication_status, "published");
    assertEquals(input.publication_version, 1);
    assertEquals(Number(input.amount), 5000);
    assertEquals(input.fiscal_year, 2026);

    const { data: classAfter } = await admin.from("expense_classifications").select("sent_to_cam, cam_status").eq("id", classification.id).single();
    assertExists(classAfter);
    assertEquals(classAfter.sent_to_cam, true);
    assertEquals(classAfter.cam_status, "cam_ready");
  },
});

Deno.test({
  name: "B4: a non-finalized classification is blocked from publication (not_finalized blocker)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule, { classification_status: "matched" });

    const res = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(body.blockers?.includes("not_finalized"), true, JSON.stringify(body));
  },
});

Deno.test({
  name: "B5: a conditional classification with an unresolved condition blocks publication",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule, {
      recovery_status: "conditional",
      recoverability_result: "conditional",
      condition_resolved: false,
    });

    const res = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(body.blockers?.includes("unresolved_conditional"), true, JSON.stringify(body));

    const { data: inputs } = await admin.from("cam_expense_inputs").select("id").eq("classification_result_id", classification.id);
    assertEquals(inputs?.length ?? 0, 0);
  },
});

Deno.test({
  name: "B6: duplicate publication is idempotent as a BUSINESS STATE (different idempotency keys, same already-published row, no second insert)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const firstRes = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));

    // A DIFFERENT idempotency key — proves this is "already published" as a
    // business state, not merely a replay of the same request.
    const secondRes = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.already_sent, true);
    assertEquals(secondBody.cam_input_id, firstBody.cam_input_id, "must return the SAME published row, not create a second one");

    const { data: inputs } = await admin.from("cam_expense_inputs").select("id").eq("classification_result_id", classification.id);
    assertEquals(inputs?.length, 1, "exactly one cam_expense_inputs row must exist after two publish attempts");
  },
});

Deno.test({
  name: "B7: cross-organization access to send-to-cam is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const otherOrg = await insertOne(admin, "organizations", { name: `CAM Pub Other Org ${suffix}`, status: "active" });
    const { accessToken: otherToken } = await createOrgUser(admin, `${suffix}-other`, otherOrg.id, "org_admin");

    const res = await callSendToCam(otherToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(body.error, true, JSON.stringify(body));
    assertEquals([403, 404].includes(res.status), true, `expected 403/404, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: inputs } = await admin.from("cam_expense_inputs").select("id").eq("classification_result_id", classification.id);
    assertEquals(inputs?.length ?? 0, 0, "cross-org attempt must not publish anything");
  },
});

Deno.test({
  name: "B8: allocation total greater than the expense amount blocks finalization",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertExpense(admin, org, property, { amount: 1000 });
    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      classification_key: `cam-pub:${crypto.randomUUID()}`,
      classification_status: "matched",
      amount: 1500, // exceeds the expense's own amount of 1000
    });

    const res = await callReview(accessToken, { classification_id: classification.id, action: "finalize", recovery_status: "recoverable" });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/exceeds the approved expense amount/i.test(body.message || ""), true, JSON.stringify(body));

    const { data: classAfter } = await admin.from("expense_classifications").select("classification_status").eq("id", classification.id).single();
    assertExists(classAfter);
    assertEquals(classAfter.classification_status, "matched", "no partial write on a rejected finalize");
  },
});

Deno.test({
  name: "B9: allocation total greater than the expense amount blocks publication (defense-in-depth against post-finalize drift)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property, { amount: 1000 });
    // Simulate data drift AFTER finalize (e.g. the expense amount was
    // corrected downward post-finalization) by directly seeding a row that
    // is already "finalized" with an amount that now exceeds the expense —
    // finalize's own check (B8) cannot catch this, since it never ran again;
    // only send_expense_classification_to_cam_workflow's independent check can.
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule, { amount: 1500 });

    const res = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/exceeds the approved expense amount/i.test(body.message || ""), true, JSON.stringify(body));

    const { data: inputs } = await admin.from("cam_expense_inputs").select("id").eq("classification_result_id", classification.id);
    assertEquals(inputs?.length ?? 0, 0);
  },
});

Deno.test({
  name: "B10: an unresolved remainder (partial allocation without acceptance) blocks finalization",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertExpense(admin, org, property, { amount: 1000 });
    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      classification_key: `cam-pub:${crypto.randomUUID()}`,
      classification_status: "matched",
      amount: 700, // deliberate partial allocation, remainder = 300
    });

    const res = await callReview(accessToken, { classification_id: classification.id, action: "finalize", recovery_status: "recoverable" });
    const body = await res.json();
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/unallocated/i.test(body.message || ""), true, JSON.stringify(body));

    const { data: classAfter } = await admin.from("expense_classifications").select("classification_status").eq("id", classification.id).single();
    assertExists(classAfter);
    assertEquals(classAfter.classification_status, "matched");
  },
});

Deno.test({
  name: "B11: remainder_accepted=true with a reason allows a deliberate partial allocation to finalize",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertExpense(admin, org, property, { amount: 1000 });
    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      classification_key: `cam-pub:${crypto.randomUUID()}`,
      classification_status: "matched",
      amount: 700,
    });

    const res = await callReview(accessToken, {
      classification_id: classification.id,
      action: "finalize",
      recovery_status: "recoverable",
      remainder_accepted: true,
      remainder_reason: "Vendor credit covers the remaining $300; confirmed with AP.",
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));
    assertEquals(body.row.classification_status, "finalized");
    assertEquals(body.row.remainder_accepted, true);
    assertEquals(body.row.remainder_reason, "Vendor credit covers the remaining $300; confirmed with AP.");
    assertEquals(Number(body.row.recoverable_amount), 700);
  },
});

Deno.test({
  name: "B12: withdrawal preserves history (old row marked withdrawn, not deleted) and resets the classification for review",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const sendRes = await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const sendBody = await sendRes.json();
    assertEquals(sendRes.status, 200, JSON.stringify(sendBody));
    const publishedId = sendBody.cam_input_id;

    const withdrawRes = await callWithdraw(accessToken, { classification_id: classification.id, reason: "Vendor invoice was corrected after publication." });
    const withdrawBody = await withdrawRes.json();
    assertEquals(withdrawRes.status, 200, JSON.stringify(withdrawBody));
    assertEquals(withdrawBody.cam_expense_input.id, publishedId);
    assertEquals(withdrawBody.cam_expense_input.publication_status, "withdrawn");

    const { data: rowAfter, error } = await admin.from("cam_expense_inputs").select("*").eq("id", publishedId).single();
    assertNoError(error);
    assertExists(rowAfter, "the withdrawn row must still exist — history is preserved, never deleted");
    assertEquals(rowAfter.publication_status, "withdrawn");
    assertExists(rowAfter.withdrawn_at);
    assertEquals(rowAfter.withdrawal_reason, "Vendor invoice was corrected after publication.");

    const { data: classAfter } = await admin.from("expense_classifications").select("classification_status, sent_to_cam, cam_status").eq("id", classification.id).single();
    assertExists(classAfter);
    assertEquals(classAfter.classification_status, "matched");
    assertEquals(classAfter.sent_to_cam, false);
    assertEquals(classAfter.cam_status, null);
  },
});

Deno.test({
  name: "B13: republishing after withdrawal creates a NEW version, linked to the withdrawn version",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const firstSend = await (await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() })).json();
    assertExists(firstSend.cam_input_id);

    const withdraw = await (await callWithdraw(accessToken, { classification_id: classification.id, reason: "Reopening to correct the amount." })).json();
    assertEquals(withdraw.cam_expense_input.publication_status, "withdrawn");

    // Republishing requires re-finalizing first (withdraw resets
    // classification_status to 'matched', and send-to-cam requires 'finalized').
    const refinalize = await (await callReview(accessToken, { classification_id: classification.id, action: "finalize", recovery_status: "recoverable" })).json();
    assertEquals(refinalize.row.classification_status, "finalized");

    const secondSend = await (await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() })).json();
    assertExists(secondSend.cam_input_id);
    assertNotEquals(secondSend.cam_input_id, firstSend.cam_input_id, "republishing must create a NEW row, not reuse the withdrawn one");

    const { data: v2, error } = await admin.from("cam_expense_inputs").select("*").eq("id", secondSend.cam_input_id).single();
    assertNoError(error);
    assertEquals(v2.publication_status, "published");
    assertEquals(v2.publication_version, 2);
    assertEquals(v2.previous_version_id, firstSend.cam_input_id, "v2 must point back to the withdrawn v1 row");

    const { data: allVersions } = await admin.from("cam_expense_inputs").select("id, publication_status, publication_version").eq("classification_result_id", classification.id).order("publication_version");
    assertEquals(allVersions?.length, 2, "both versions must exist — history is never deleted");
    assertEquals(allVersions![0].publication_status, "withdrawn");
    assertEquals(allVersions![1].publication_status, "published");
  },
});

Deno.test({
  name: "B14: an affected, UNLOCKED CAM snapshot becomes stale when its input is withdrawn",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const snapshot = await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "cam",
      fiscal_year: 2026,
      scope_level: "property",
      scope_id: property.id,
      status: "completed",
      locked_at: null,
    });

    await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const withdrawRes = await callWithdraw(accessToken, { classification_id: classification.id, reason: "Testing stale snapshot cascade." });
    const withdrawBody = await withdrawRes.json();
    assertEquals(withdrawRes.status, 200, JSON.stringify(withdrawBody));
    assertEquals(withdrawBody.stale_snapshot_count, 1);
    assertEquals(withdrawBody.restatement_required_snapshot_count, 0);

    const { data: snapAfter } = await admin.from("computation_snapshots").select("stale, stale_reason, restatement_required, status").eq("id", snapshot.id).single();
    assertExists(snapAfter);
    assertEquals(snapAfter.stale, true);
    assertExists(snapAfter.stale_reason);
    assertEquals(snapAfter.restatement_required, false);
    assertEquals(snapAfter.status, "completed", "stale marking must not change the snapshot's own status");
  },
});

Deno.test({
  name: "B15: a LOCKED CAM snapshot is never mutated by withdrawal — flagged restatement_required instead, status/outputs/locked_at untouched",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const lockedAt = new Date().toISOString();
    const snapshot = await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "cam",
      fiscal_year: 2026,
      scope_level: "property",
      scope_id: property.id,
      status: "completed",
      locked_at: lockedAt,
      outputs: { total_cam: 42424.24 },
    });

    // Read back the DB's own canonical string form (Postgres reformats
    // "...Z" to "...+00:00" on round-trip) rather than comparing against
    // the literal we inserted — this test is about whether withdrawal
    // MUTATES the column, not about string formatting.
    const { data: snapBefore } = await admin.from("computation_snapshots").select("locked_at").eq("id", snapshot.id).single();
    assertExists(snapBefore);

    await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() });
    const withdrawRes = await callWithdraw(accessToken, { classification_id: classification.id, reason: "Testing locked snapshot immutability." });
    const withdrawBody = await withdrawRes.json();
    assertEquals(withdrawRes.status, 200, JSON.stringify(withdrawBody));
    assertEquals(withdrawBody.stale_snapshot_count, 0, "a locked snapshot must never be marked stale");
    assertEquals(withdrawBody.restatement_required_snapshot_count, 1);

    const { data: snapAfter } = await admin.from("computation_snapshots").select("*").eq("id", snapshot.id).single();
    assertExists(snapAfter);
    assertEquals(snapAfter.restatement_required, true);
    assertExists(snapAfter.restatement_reason);
    assertEquals(snapAfter.stale, false, "a locked snapshot must never be marked stale, only flagged for restatement");
    assertEquals(snapAfter.status, "completed", "locked snapshot's status must remain untouched");
    assertEquals(snapAfter.locked_at, snapBefore.locked_at, "locked_at must remain untouched");
    assertEquals(snapAfter.outputs.total_cam, 42424.24, "a locked snapshot's outputs must remain immutable");
  },
});

Deno.test({
  name: "B16: reopening a published classification cascades to withdraw its CAM input and mark affected snapshots stale",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const snapshot = await insertOne(admin, "computation_snapshots", {
      org_id: org.id,
      property_id: property.id,
      engine_type: "cam",
      fiscal_year: 2026,
      scope_level: "property",
      scope_id: property.id,
      status: "completed",
      locked_at: null,
    });

    const sendBody = await (await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() })).json();
    assertExists(sendBody.cam_input_id);

    const reopenRes = await callReview(accessToken, { classification_id: classification.id, action: "reopen" });
    const reopenBody = await reopenRes.json();
    assertEquals(reopenRes.status, 200, JSON.stringify(reopenBody));
    assertEquals(reopenBody.row.classification_status, "matched");
    assertEquals(reopenBody.stale_snapshot_count, 1, `reopen must cascade to mark the affected snapshot stale: ${JSON.stringify(reopenBody)}`);

    const { data: inputAfter } = await admin.from("cam_expense_inputs").select("publication_status, withdrawal_reason").eq("id", sendBody.cam_input_id).single();
    assertExists(inputAfter);
    assertEquals(inputAfter.publication_status, "withdrawn");
    assertEquals(/reopened/i.test(inputAfter.withdrawal_reason || ""), true, JSON.stringify(inputAfter));

    const { data: snapAfter } = await admin.from("computation_snapshots").select("stale").eq("id", snapshot.id).single();
    assertExists(snapAfter);
    assertEquals(snapAfter.stale, true);
  },
});

Deno.test({
  name: "B16b: reopening a classification that was NEVER published is a silent no-op for the CAM cascade (common case)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, null);

    const finalizeRes = await callReview(accessToken, { classification_id: classification.id, action: "finalize", recovery_status: "recoverable" });
    assertEquals(finalizeRes.status, 200);

    const reopenRes = await callReview(accessToken, { classification_id: classification.id, action: "reopen" });
    const reopenBody = await reopenRes.json();
    assertEquals(reopenRes.status, 200, JSON.stringify(reopenBody));
    assertEquals(reopenBody.stale_snapshot_count ?? undefined, undefined, "no withdraw cascade metadata should be present when nothing was published");
  },
});

Deno.test({
  name: "B17: multiple allocation lines for the same expense are structurally blocked (UNIQUE(org_id, expense_id)) — documents the current model's real limit",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertExpense(admin, org, property, { amount: 1000 });

    await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      classification_key: `cam-pub:${crypto.randomUUID()}`,
      classification_status: "matched",
      amount: 600,
    });

    const { data, error } = await admin
      .from("expense_classifications")
      .insert({
        org_id: org.id,
        property_id: property.id,
        expense_id: expense.id, // same expense — a second "allocation line"
        actual_expense_id: expense.id,
        classification_key: `cam-pub:${crypto.randomUUID()}`,
        classification_status: "matched",
        amount: 400,
      })
      .select("*")
      .single();

    assertEquals(data, null, "a second classification row for the same expense must be rejected");
    assertExists(error, "expected a unique-constraint violation");
    assertEquals(/duplicate key|unique/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "B18: cross-organization withdrawal is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const rule = await insertRule(admin, org, lease, property);
    const expense = await insertExpense(admin, org, property);
    const classification = await insertReadyClassification(admin, org, property, lease, expense, rule);

    const sendBody = await (await callSendToCam(accessToken, { classification_id: classification.id, idempotency_key: crypto.randomUUID() })).json();
    assertExists(sendBody.cam_input_id);

    const otherOrg = await insertOne(admin, "organizations", { name: `CAM Pub Other Org ${suffix}`, status: "active" });
    const { accessToken: otherToken } = await createOrgUser(admin, `${suffix}-other-withdraw`, otherOrg.id, "org_admin");

    const res = await callWithdraw(otherToken, { classification_id: classification.id, reason: "Cross-org attempt." });
    const body = await res.json();
    assertEquals(body.error, true, JSON.stringify(body));
    assertEquals([403, 404].includes(res.status), true, `expected 403/404, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: inputAfter } = await admin.from("cam_expense_inputs").select("publication_status").eq("id", sendBody.cam_input_id).single();
    assertExists(inputAfter);
    assertEquals(inputAfter.publication_status, "published", "a cross-org withdrawal attempt must never change the real row's status");
  },
});

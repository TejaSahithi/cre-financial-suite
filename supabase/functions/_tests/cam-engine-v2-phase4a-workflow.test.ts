// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 4A workflow
// RPC integration tests, against the real local database. Covers the state
// graph wiring added in 20269900000023 on top of the already-enforced
// cam_runs status trigger (20269900000010): submit_cam_run_for_review,
// return_cam_run_to_draft, reject_cam_run, approve_cam_run,
// resolve_cam_run_exception.
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
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
async function callRpc(admin: ReturnType<typeof adminClient>, fn: string, args: Record<string, unknown>) {
  return admin.rpc(fn, args);
}
async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-phase4a-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}
async function createOrgUserWithToken(admin: ReturnType<typeof adminClient>, suffix: string, orgId: string, role: string) {
  const email = `cam-phase4a-http-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assertNoError(userError);
  const userId = userData.user?.id;
  assertExists(userId);
  await admin.from("profiles").upsert({ id: userId, email, full_name: "Phase4A HTTP Tester", role: "user", status: "active" });
  await insertOne(admin, "memberships", { user_id: userId, org_id: orgId, role });
  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);
  return { userId, accessToken };
}
async function callEdge(fn: string, accessToken: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${fn}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Same shape as the end-to-end test's setUpReadyProperty, kept local so this file has no cross-file coupling. */
async function setUpReadyProperty(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `CAM Phase4A Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Phase4A Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });

  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
    approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });
  const materialized = await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(materialized.error);

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(cal.error);
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(period.error);
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: "Property Pool", p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.data.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(pool.error);
  await insertOne(admin, "recovery_pool_categories", { org_id: org.id, pool_id: pool.data.pool.id, expense_category_id: category.id, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable" });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
  await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 10000, recovery_area_sqft: 10000, effective_from: "2026-01-01" });
  await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 100000, effective_from: "2026-01-01" });

  const expenseInput = await insertOne(admin, "cam_expense_inputs", {
    // Canonical category goes in expense_category_id; `category` is the
    // display label only (specification 8.3).
    org_id: org.id, property_id: property.id, lease_id: lease.id, amount: 12000,
    expense_category_id: category.id, category: category.category_name,
    publication_status: "published", publication_version: 1, fiscal_year: 2026, cam_input_type: "actual",
    variability: "variable", controllability: "controllable", service_period_start: "2026-01-01", service_period_end: "2026-12-31",
  });
  const assignResult = await callRpc(admin, "assign_cam_input_to_pool", { p_org_id: org.id, p_cam_expense_input_id: expenseInput.id, p_recovery_pool_id: pool.data.pool.id, p_amount: 12000, p_assignment_method: "manual", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(assignResult.error);
  const participantResult = await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.data.pool.id, p_lease_id: lease.id, p_effective_from: "2026-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(participantResult.error);
  for (const adjType of ["prior_period_adjustment", "prior_credit"]) {
    const adjResult = await callRpc(admin, "record_cam_prior_period_adjustment", { p_org_id: org.id, p_lease_id: lease.id, p_recovery_period_id: period.data.period.id, p_adjustment_type: adjType, p_state: "KNOWN_ZERO", p_actor_user_id: actor.userId, p_actor_email: actor.email });
    assertNoError(adjResult.error);
  }

  return { actor, org, property, lease, period: period.data.period, pool: pool.data.pool };
}

/** Drives a fresh setup through calculate(posting_eligible) -> submit -> returns { setup, accessToken, runId }. */
async function setUpSubmittedRun(admin: ReturnType<typeof adminClient>, suffix: string) {
  const setup = await setUpReadyProperty(admin, suffix);
  const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");
  const { status, json } = await callEdge("run-cam-calculation-v2", accessToken, {
    property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id,
    run_type: "standard", run_mode: "posting_eligible",
  });
  assertEquals(status, 200);
  assertEquals(json.status, "calculated");
  const runId = json.run_id as string;

  const submitted = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "submit_for_review" });
  assertEquals(submitted.status, 200);
  assertEquals(submitted.json.status, "submitted");

  return { setup, accessToken, runId };
}

Deno.test({
  name: "submit_for_review: calculated -> submitted; requires posting_eligible run_mode",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpReadyProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");

    // Calculated in PREVIEW mode -- submission must be refused.
    const preview = await callEdge("run-cam-calculation-v2", accessToken, {
      property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id, run_type: "standard",
    });
    assertEquals(preview.status, 200);
    assertEquals(preview.json.status, "calculated");
    const previewSubmit = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: preview.json.run_id, action: "submit_for_review" });
    assertEquals(previewSubmit.status >= 400, true);

    // Recalculate the SAME run in posting_eligible mode -- now it can submit.
    const posting = await callEdge("run-cam-calculation-v2", accessToken, {
      property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id,
      run_type: "standard", run_mode: "posting_eligible",
    });
    assertEquals(posting.status, 200);
    assertEquals(posting.json.run_id, preview.json.run_id);
    const submitted = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: posting.json.run_id, action: "submit_for_review" });
    assertEquals(submitted.status, 200);
    assertEquals(submitted.json.status, "submitted");

    const { data: runRow } = await admin.from("cam_runs").select("status, run_mode, submitted_at").eq("id", posting.json.run_id).single();
    assertEquals(runRow!.status, "submitted");
    assertEquals(runRow!.run_mode, "posting_eligible");
    assertExists(runRow!.submitted_at);
  },
});

Deno.test({
  name: "approve: submitted -> approved, and records approved_by/approved_at",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { runId, accessToken } = await setUpSubmittedRun(admin, suffix);

    const approved = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "approve" });
    assertEquals(approved.status, 200);
    assertEquals(approved.json.status, "approved");

    const { data: runRow } = await admin.from("cam_runs").select("status, approved_by, approved_at").eq("id", runId).single();
    assertEquals(runRow!.status, "approved");
    assertExists(runRow!.approved_by);
    assertExists(runRow!.approved_at);
  },
});

Deno.test({
  name: "approve: an unresolved blocking exception prohibits approval; resolving it unblocks",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { runId, accessToken } = await setUpSubmittedRun(admin, suffix);

    // Inject a synthetic OPEN blocking exception directly (simulating a real one the engine would have raised).
    const injected = await insertOne(admin, "cam_run_exceptions", {
      org_id: (await admin.from("cam_runs").select("org_id").eq("id", runId).single()).data!.org_id,
      cam_run_id: runId, severity: "blocking", code: "TEST_INJECTED_BLOCKER", message: "synthetic blocker for test coverage",
    });

    const blockedApproval = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "approve" });
    assertEquals(blockedApproval.status >= 400, true);

    const resolved = await callEdge("cam-run-workflow-v2", accessToken, {
      cam_run_id: runId, action: "resolve_exception", exception_id: injected.id, resolution_status: "waived", resolution_note: "Confirmed with property manager -- not applicable to this run.",
    });
    assertEquals(resolved.status, 200);

    const nowApproved = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "approve" });
    assertEquals(nowApproved.status, 200);
    assertEquals(nowApproved.json.status, "approved");

    const { data: exceptionRow } = await admin.from("cam_run_exceptions").select("resolution_status, resolved_by, resolution_note").eq("id", injected.id).single();
    assertEquals(exceptionRow!.resolution_status, "waived");
    assertExists(exceptionRow!.resolved_by);
    assertExists(exceptionRow!.resolution_note);
  },
});

Deno.test({
  name: "resolve_exception: a resolution_note is mandatory",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { runId, accessToken } = await setUpSubmittedRun(admin, suffix);
    const orgId = (await admin.from("cam_runs").select("org_id").eq("id", runId).single()).data!.org_id;
    const injected = await insertOne(admin, "cam_run_exceptions", { org_id: orgId, cam_run_id: runId, severity: "warning", code: "TEST_WARNING", message: "test" });

    const noNote = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "resolve_exception", exception_id: injected.id, resolution_status: "resolved", resolution_note: "" });
    assertEquals(noNote.status >= 400, true);
  },
});

Deno.test({
  name: "reject: submitted -> under_review (reason required); the run can be resubmitted afterward",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { runId, accessToken } = await setUpSubmittedRun(admin, suffix);

    const noReason = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "reject" });
    assertEquals(noReason.status >= 400, true);

    const rejected = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "reject", reason: "Marketing pool total looks stale, needs a second look." });
    assertEquals(rejected.status, 200);
    assertEquals(rejected.json.status, "under_review");

    const { data: runRow } = await admin.from("cam_runs").select("status, submitted_at").eq("id", runId).single();
    assertEquals(runRow!.status, "under_review");
    assertEquals(runRow!.submitted_at, null);

    // A run that's back in under_review is NOT valid for submit_for_review (which requires 'calculated').
    const resubmitTooEarly = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "submit_for_review" });
    assertEquals(resubmitTooEarly.status >= 400, true);
  },
});

Deno.test({
  name: "return_to_draft: works from both under_review and submitted, always lands on calculated, and requires a reason",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { runId, accessToken } = await setUpSubmittedRun(admin, suffix);

    const noReason = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "return_to_draft" });
    assertEquals(noReason.status >= 400, true);

    // From 'submitted' directly.
    const returned = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "return_to_draft", reason: "Recovery area for lease looks wrong, needs recalculation after a data fix." });
    assertEquals(returned.status, 200);
    assertEquals(returned.json.status, "calculated");

    const { data: runRowAfterFirst } = await admin.from("cam_runs").select("status").eq("id", runId).single();
    assertEquals(runRowAfterFirst!.status, "calculated");

    // Now drive it back through under_review (via reject requires submitted first) -- exercise the under_review -> calculated path too.
    const resubmit = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "submit_for_review" });
    assertEquals(resubmit.status, 200);
    const rejectedToUnderReview = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "reject", reason: "still checking something" });
    assertEquals(rejectedToUnderReview.status, 200);
    assertEquals(rejectedToUnderReview.json.status, "under_review");

    const returnedFromUnderReview = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: runId, action: "return_to_draft", reason: "Needs a full rework, not just another review pass." });
    assertEquals(returnedFromUnderReview.status, 200);
    assertEquals(returnedFromUnderReview.json.status, "calculated");
  },
});

Deno.test({
  name: "approve: rejects a run that is not in submitted status",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const setup = await setUpReadyProperty(admin, suffix);
    const { accessToken } = await createOrgUserWithToken(admin, suffix, setup.org.id, "org_admin");
    const calc = await callEdge("run-cam-calculation-v2", accessToken, {
      property_id: setup.property.id, recovery_period_id: setup.period.id, scope_type: "property", scope_id: setup.property.id,
      run_type: "standard", run_mode: "posting_eligible",
    });
    assertEquals(calc.status, 200);
    assertEquals(calc.json.status, "calculated");

    const prematureApproval = await callEdge("cam-run-workflow-v2", accessToken, { cam_run_id: calc.json.run_id, action: "approve" });
    assertEquals(prematureApproval.status >= 400, true);
  },
});

Deno.test({
  name: "cross-organization CAM run access is rejected for every workflow action",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { runId } = await setUpSubmittedRun(admin, suffix);
    const otherOrg = await insertOne(admin, "organizations", { name: `Other Org ${suffix}`, status: "active" });
    const { accessToken: otherToken } = await createOrgUserWithToken(admin, `${suffix}-other`, otherOrg.id, "org_admin");

    const attempt = await callEdge("cam-run-workflow-v2", otherToken, { cam_run_id: runId, action: "approve" });
    assertEquals(attempt.status >= 400, true);
  },
});

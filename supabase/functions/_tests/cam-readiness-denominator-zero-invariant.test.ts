// Correction to 20269900000058's DENOMINATOR_ZERO check (itself fixed in
// 20269900000059 + policy-step-runner.ts): the business invariant is that
// an area denominator is only REQUIRED for a pool/month that actually has
// an allocable dollar amount to divide up.
//
//   has_allocable_pool_amount AND area_based_allocation AND denominator<=0
//     -> DENOMINATOR_ZERO (blocking)
//   NOT has_allocable_pool_amount
//     -> no denominator blocker at all (that month legitimately recovers $0)
//
// "has_allocable_pool_amount" is the exact same cam_pool_has_included_amount
// concept 20269900000058 introduced (itself a mirror of pool-builder.ts's
// assembleSegmentAmounts + applyCategoryInclusionExclusion) -- reused, not
// redefined. This file proves the corrected invariant against SQL readiness
// directly using the real proven case (annual period, single March $4,800
// expense, 2,000/20,000 SF split) plus the edge cases the fix specifically
// had to get right: explicit-zero area, multiple funded months, and
// fixed-percentage recovery never needing an area denominator at all.
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
  const result = await admin.rpc(fn, args);
  assertNoError(result.error);
  return result.data;
}
async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-denom-invariant-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  return { userId: data.user!.id, email };
}

interface ExpensePeriod { start: string; end: string; amount: number }
interface FixtureOptions {
  /** Defaults to the real proven case: a single $4,800 expense covering March only. */
  expensePeriods?: ExpensePeriod[];
  /** 'present' = 20,000 SF rentable row; 'missing' = no row at all; 'zero' = a row with area_sqft=0. */
  denominatorArea?: "present" | "missing" | "zero";
  recoveryMethod?: "pro_rata_share" | "fixed_percentage";
  tenantSharePercent?: number;
}

/** Annual (2028) property/pool/lease fixture with independently toggleable expense funding and denominator area, following the codebase's canonical RPC-driven setup sequence. */
async function buildFixture(admin: ReturnType<typeof adminClient>, suffix: string, opts: FixtureOptions = {}) {
  const {
    expensePeriods = [{ start: "2028-03-01", end: "2028-03-31", amount: 4800 }],
    denominatorArea = "present",
    recoveryMethod = "pro_rata_share",
    tenantSharePercent = null,
  } = opts;

  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `CAM Denom Invariant Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Denom Invariant Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, tenant_name: `Tenant ${suffix}`, status: "approved", commencement_date: "2028-01-01" });

  const category = await insertOne(admin, "expense_categories", {
    org_id: org.id, category_name: `Denom Invariant Category ${suffix}`, normalized_key: `cam_denom_invariant_${suffix}`,
  });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, lease_id: lease.id, property_id: property.id, expense_category_id: category.id,
    expense_category: "common_area_maintenance", payment_treatment: "reimbursable", recovery_method: recoveryMethod,
    tenant_share_percent: tenantSharePercent, approval_status: "approved", recoverable_from_tenant: "yes",
    source_page: 1, exact_source_text: "Tenant pays CAM.", confidence_score: 0.95,
  });
  await callRpc(admin, "materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });

  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2028-01-01", p_end_date: "2028-12-31", p_label: `FY2028 ${suffix}`, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const pool = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: property.id, p_name: `Pool ${suffix}`, p_pool_type: "property", p_scope_type: "property", p_scope_id: property.id, p_is_template: false, p_period_id: period.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  await insertOne(admin, "recovery_pool_categories", { org_id: org.id, pool_id: pool.pool.id, expense_category_id: category.id, inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable" });

  const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2028-01-01", status: "approved" });
  await insertOne(admin, "lease_premises_spaces", { org_id: org.id, lease_premises_id: premises.id, property_id: property.id, allocation_weight: 1 });
  await insertOne(admin, "lease_premises_area_periods", { org_id: org.id, lease_premises_id: premises.id, area_basis: "rentable", contractual_area_sqft: 2000, recovery_area_sqft: 2000, effective_from: "2028-01-01" });

  if (denominatorArea === "present") {
    await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 20000, effective_from: "2028-01-01" });
  } else if (denominatorArea === "zero") {
    await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 0, effective_from: "2028-01-01" });
  } // 'missing': insert nothing

  for (const ep of expensePeriods) {
    const expenseInput = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, lease_id: lease.id, amount: ep.amount,
      expense_category_id: category.id, category: category.category_name,
      publication_status: "published", publication_version: 1, fiscal_year: 2028, cam_input_type: "actual",
      variability: "variable", controllability: "controllable", service_period_start: ep.start, service_period_end: ep.end,
    });
    await callRpc(admin, "assign_cam_input_to_pool", { p_org_id: org.id, p_cam_expense_input_id: expenseInput.id, p_recovery_pool_id: pool.pool.id, p_amount: ep.amount, p_assignment_method: "manual", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  }
  await callRpc(admin, "add_recovery_pool_lease_participant", { p_org_id: org.id, p_pool_id: pool.pool.id, p_lease_id: lease.id, p_effective_from: "2028-01-01", p_actor_user_id: actor.userId, p_actor_email: actor.email });

  return { actor, org, property, lease, period: period.period, pool: pool.pool, category };
}

async function evaluateReadiness(admin: ReturnType<typeof adminClient>, f: { org: { id: string }; property: { id: string }; period: { id: string } }) {
  return await callRpc(admin, "evaluate_cam_readiness", {
    p_org_id: f.org.id, p_property_id: f.property.id, p_recovery_period_id: f.period.id,
    p_scope_type: "property", p_scope_id: f.property.id,
  });
}
function blockingCodes(readiness: { exceptions: Array<{ code: string; severity: string }> }) {
  return (readiness.exceptions || []).filter((e) => e.severity === "blocking").map((e) => e.code);
}
function denominatorZeroMonths(readiness: { exceptions: Array<{ code: string; message: string }> }) {
  return (readiness.exceptions || []).filter((e) => e.code === "DENOMINATOR_ZERO").map((e) => e.message);
}

Deno.test({
  name: "denominator invariant 1+2: annual period, March-only $4,800 expense, 20,000 SF denominator -> ready, zero blockers, no denominator noise for the other 11 months",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID());
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.blocking_count, 0, `expected zero blockers, got: ${JSON.stringify(readiness.exceptions)}`);
    assertEquals(readiness.ready, true);
    assertEquals(denominatorZeroMonths(readiness).length, 0, "no month should generate a DENOMINATOR_ZERO exception when the funded month has a valid denominator");
  },
});

Deno.test({
  name: "denominator invariant 3a: March $4,800 with denominator MISSING entirely -> DENOMINATOR_ZERO blocker",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID(), { denominatorArea: "missing" });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.ready, false);
    assertEquals(blockingCodes(readiness).includes("DENOMINATOR_ZERO"), true, `expected DENOMINATOR_ZERO, got: ${JSON.stringify(readiness.exceptions)}`);
    // Exactly one funded month (March) -- exactly one DENOMINATOR_ZERO exception, not one per calendar month.
    assertEquals(denominatorZeroMonths(readiness).length, 1, `expected exactly 1 zero-denominator month (March only), got: ${JSON.stringify(denominatorZeroMonths(readiness))}`);
  },
});

Deno.test({
  name: "denominator invariant 3b: March $4,800 with denominator explicitly ZERO (area_sqft=0) -> DENOMINATOR_ZERO blocker",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID(), { denominatorArea: "zero" });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.ready, false);
    assertEquals(blockingCodes(readiness).includes("DENOMINATOR_ZERO"), true, `expected DENOMINATOR_ZERO, got: ${JSON.stringify(readiness.exceptions)}`);
    // A present-but-zero measurement is not "missing" -- AREA_MISSING must NOT fire here, only DENOMINATOR_ZERO.
    assertEquals(blockingCodes(readiness).includes("AREA_MISSING"), false, `AREA_MISSING should not fire when a measurement row exists with area_sqft=0: ${JSON.stringify(readiness.exceptions)}`);
  },
});

Deno.test({
  name: "denominator invariant 4: expenses in two separate months -> a missing denominator is required (and blocks) only in those two funded months",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const f = await buildFixture(admin, crypto.randomUUID(), {
      expensePeriods: [
        { start: "2028-03-01", end: "2028-03-31", amount: 4800 },
        { start: "2028-07-01", end: "2028-07-31", amount: 2400 },
      ],
      denominatorArea: "missing",
    });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(readiness.ready, false);
    const months = denominatorZeroMonths(readiness);
    assertEquals(months.length, 2, `expected exactly 2 zero-denominator months (March and July only), got: ${JSON.stringify(months)}`);
    assertEquals(months.some((m) => m.includes("2028-03-01")), true, "March must be flagged");
    assertEquals(months.some((m) => m.includes("2028-07-01")), true, "July must be flagged");
  },
});

Deno.test({
  name: "denominator invariant 5: fixed-percentage recovery never raises DENOMINATOR_ZERO, even with no area data at all",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    // AREA_MISSING (the pool's OWN denominator-scope check, 20269900000058)
    // is intentionally out of scope for this fix -- run-cam-engine.ts computes
    // a pool's denominator area once per pool/month regardless of which
    // recovery method any participating lease uses, so it can still fire
    // here. What this invariant specifically guarantees is that
    // DENOMINATOR_ZERO -- the CALCULATE_SHARE-side exception -- never does,
    // since a fixed_percentage share is never divided by an area at all.
    const f = await buildFixture(admin, crypto.randomUUID(), { recoveryMethod: "fixed_percentage", tenantSharePercent: 10, denominatorArea: "missing" });
    const readiness = await evaluateReadiness(admin, f);
    assertEquals(blockingCodes(readiness).includes("DENOMINATOR_ZERO"), false, `fixed_percentage must never need an area denominator: ${JSON.stringify(readiness.exceptions)}`);
  },
});

Deno.test({
  name: "denominator invariant 6: run-cam-calculation-v2's engine-side readiness gate agrees with evaluate_cam_readiness for the corrected invariant (no drift)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    // Readiness-only, per "stop before Calculate CAM": uses a still-broken
    // fixture (denominator missing) so run-cam-calculation-v2 short-circuits
    // at its own internal evaluate_cam_readiness call (index.ts's step 3-4)
    // and returns readiness_failed WITHOUT ever invoking the pure engine --
    // proving the two entry points agree without performing a calculation.
    const admin = adminClient();
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const suffix = crypto.randomUUID();
    const f = await buildFixture(admin, suffix, { denominatorArea: "missing" });
    const directReadiness = await evaluateReadiness(admin, f);
    assertEquals(directReadiness.ready, false);
    assertEquals(blockingCodes(directReadiness).includes("DENOMINATOR_ZERO"), true);

    const email = `cam-denom-invariant-http-${suffix}@example.test`;
    const password = `Pass-${suffix}!`;
    const { data: userData, error: userError } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    assertNoError(userError);
    await admin.from("profiles").upsert({ id: userData.user!.id, email, full_name: "Denom Invariant Tester", role: "user", status: "active" });
    await insertOne(admin, "memberships", { user_id: userData.user!.id, org_id: f.org.id, role: "org_admin" });
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
    assertNoError(signInError);
    const accessToken = signInData.session?.access_token;
    assertExists(accessToken);

    const res = await fetch(`${SUPABASE_URL}/functions/v1/run-cam-calculation-v2`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}`, apikey: ANON_KEY },
      body: JSON.stringify({ property_id: f.property.id, recovery_period_id: f.period.id, scope_type: "property", scope_id: f.property.id, run_mode: "preview" }),
    });
    const json = await res.json();

    assertEquals(res.status, 200);
    assertEquals(json.status, "readiness_failed");
    assertEquals(json.ready, false);
    assertEquals(json.readiness.blocking_count, directReadiness.blocking_count, "engine entry point's blocking_count must match the direct SQL readiness call");
    assertEquals(new Set(blockingCodes(json.readiness)), new Set(blockingCodes(directReadiness)), "engine entry point's blocking codes must match the direct SQL readiness call");
  },
});

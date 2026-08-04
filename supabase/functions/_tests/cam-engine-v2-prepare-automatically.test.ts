// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation pass: integration tests for prepareCamAutomatically(), against
// the real local database. Covers the scenarios item I of the governing
// instruction calls out that are specific to this new orchestration:
// duplicate lease detection, one lease with multiple legitimate premises,
// source-rule-to-materialized-policy via the orchestration entry point,
// year/service-period filtering of published expenses, and idempotent
// rerun.
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { prepareCamAutomatically } from "../_shared/cam-engine-v2/setup/prepare-cam-automatically.ts";

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
  const { data, error } = await admin.rpc(fn, args);
  assertNoError(error);
  return data;
}

async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-prepare-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

async function setUpOrgPropertyPeriod(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `Prepare CAM Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Prepare CAM Property ${suffix}`, status: "active" });
  const cal = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const period = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  return { actor, org, property, period: period.period };
}

async function createApprovedLeaseWithRule(admin: ReturnType<typeof adminClient>, org: any, property: any, actor: any, overrides: Record<string, unknown> = {}) {
  const lease = await insertOne(admin, "leases", {
    org_id: org.id, property_id: property.id, commencement_date: "2026-01-01",
    tenant_name: "Acme Retail", abstract_status: "approved", square_footage: 5000,
    ...overrides,
  });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
    approval_status: "approved", source_page: 1, exact_source_text: "Tenant pays pro rata CAM.", confidence_score: 0.95,
    recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });
  return { lease, ruleSet, category, rule };
}

Deno.test({
  name: "prepareCamAutomatically: materializes approved rules into policies and is idempotent on rerun",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);
    await createApprovedLeaseWithRule(admin, org, property, actor);

    const first = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });
    assertEquals(first.created.policies_materialized, 1);
    assertEquals(first.conflicting.duplicate_lease_groups.length, 0);

    const { data: policiesAfterFirst } = await admin.from("lease_recovery_policies").select("id").eq("org_id", org.id);
    assertEquals(policiesAfterFirst!.length, 1);

    // Rerun: idempotent -- no new policies materialized, no duplicate rows.
    const second = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });
    assertEquals(second.created.policies_materialized, 0);

    const { data: policiesAfterSecond } = await admin.from("lease_recovery_policies").select("id").eq("org_id", org.id);
    assertEquals(policiesAfterSecond!.length, 1);
  },
});

Deno.test({
  name: "prepareCamAutomatically: two leases, same tenant/building/sqft -> flagged likely duplicate and excluded from suggestions",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);
    const building = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: "Building A" });

    await createApprovedLeaseWithRule(admin, org, property, actor, { building_id: building.id, square_footage: 5800, lease_type: "net" });
    await createApprovedLeaseWithRule(admin, org, property, actor, { building_id: building.id, square_footage: 5800, lease_type: "modified_gross" });

    const result = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });

    assertEquals(result.conflicting.duplicate_lease_groups.length, 1);
    assertEquals(result.conflicting.duplicate_lease_groups[0].likely_duplicate, true);
    assertEquals(result.conflicting.duplicate_lease_groups[0].lease_count, 2);
    // Neither duplicate-flagged lease should drive a pool suggestion.
    for (const pool of result.suggested.pools) {
      assertEquals(pool.policy_lease_count, 0);
    }
  },
});

Deno.test({
  name: "prepareCamAutomatically: two leases, same tenant/building but different sqft -> possible multi-premises, not flagged as duplicate",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);
    const building = await insertOne(admin, "buildings", { org_id: org.id, property_id: property.id, name: "Building A" });

    await createApprovedLeaseWithRule(admin, org, property, actor, { building_id: building.id, square_footage: 3000 });
    await createApprovedLeaseWithRule(admin, org, property, actor, { building_id: building.id, square_footage: 7500 });

    const result = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });

    assertEquals(result.conflicting.duplicate_lease_groups.length, 1);
    assertEquals(result.conflicting.duplicate_lease_groups[0].likely_duplicate, false);
  },
});

Deno.test({
  name: "prepareCamAutomatically: published expense outside the selected period is excluded from suggestions and reported as missing",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);
    const { category } = await createApprovedLeaseWithRule(admin, org, property, actor);

    // Published expense from FY2025 (prior year), no service_period dates --
    // exactly the shape found in real production data.
    await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: category.id, amount: 1000,
      publication_status: "published", fiscal_year: 2025, status: "cam_ready",
    });

    const result = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });

    // The approved policy alone still suggests a pool for its category
    // (item B: "suggests recovery pools from policy AND expense
    // categories") -- but the FY2025 expense must not contribute to its
    // total, since it does not overlap the FY2026 period being prepared.
    assertEquals(result.suggested.pools.length, 1);
    assertEquals(result.suggested.pools[0].expense_count, 0);
    assertEquals(Number(result.suggested.pools[0].expense_total), 0);
    assertEquals(result.missing.published_expenses_outside_period.length, 1);
  },
});

Deno.test({
  name: "prepareCamAutomatically: published expense inside the selected period suggests a pool with the correct total",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);
    const { category } = await createApprovedLeaseWithRule(admin, org, property, actor);

    await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, category: category.id, amount: 2500,
      publication_status: "published", service_period_start: "2026-03-01", service_period_end: "2026-03-31", status: "cam_ready",
    });

    const result = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });

    assertEquals(result.suggested.pools.length, 1);
    assertEquals(result.suggested.pools[0].expense_category_id, category.id);
    assertEquals(Number(result.suggested.pools[0].expense_total), 2500);
    assertEquals(result.missing.published_expenses_outside_period.length, 0);
  },
});

Deno.test({
  name: "prepareCamAutomatically: publishes an approved, recoverable, CAM-eligible rule to CAM; leaves a conditional rule unpublished with a reason; idempotent on rerun",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);

    // Root cause this test locks in: a rule can be approval_status='approved'
    // (and even materialize into a policy) while published_to_cam stays
    // false forever, because recoverable_from_tenant/cam_eligible are a
    // SEPARATE gate from approval_status -- exactly the real-world A1/FY2026
    // shape (18 approved rules, all published_to_cam=false, only 5 actually
    // recoverable='yes'/cam_eligible='yes').
    // Distinct tenant_name per lease -- otherwise both leases (same default
    // square_footage, no building_id) collide into detectDuplicateLeaseGroups'
    // own duplicate-detection key and get excluded from publishing for an
    // unrelated reason, defeating the point of this test.
    const ready = await createApprovedLeaseWithRule(admin, org, property, actor, { tenant_name: "Ready Tenant LLC" });
    const readyUpdate = await admin.from("lease_expense_rules").update({
      review_status: "approved", recoverable_from_tenant: "yes", cam_eligible: "yes",
    }).eq("id", ready.rule.id);
    assertNoError(readyUpdate.error);

    const conditional = await createApprovedLeaseWithRule(admin, org, property, actor, { tenant_name: "Conditional Tenant LLC" });
    const conditionalUpdate = await admin.from("lease_expense_rules").update({
      review_status: "approved", recoverable_from_tenant: "conditional", cam_eligible: "conditional",
    }).eq("id", conditional.rule.id);
    assertNoError(conditionalUpdate.error);

    const first = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });
    assertEquals(first.created.rules_published_to_cam, 1);
    assertEquals(first.missing.rules_not_publishable_to_cam.length, 1);
    assertEquals(first.missing.rules_not_publishable_to_cam[0].rule_id, conditional.rule.id);
    assertEquals(first.missing.rules_not_publishable_to_cam[0].blockers.includes("not_recoverable"), true);

    const { data: readyAfter } = await admin.from("lease_expense_rules").select("published_to_cam").eq("id", ready.rule.id).single();
    assertEquals(readyAfter!.published_to_cam, true);
    const { data: conditionalAfter } = await admin.from("lease_expense_rules").select("published_to_cam").eq("id", conditional.rule.id).single();
    assertEquals(conditionalAfter!.published_to_cam, false);

    // Rerun: idempotent -- already-published rule is counted as already
    // published, not published a second time or errored on.
    const second = await prepareCamAutomatically(admin, {
      orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id,
      actorUserId: actor.userId, actorEmail: actor.email,
    });
    assertEquals(second.created.rules_published_to_cam, 0);
    assertEquals(second.created.rules_already_published_to_cam, 1);
  },
});

// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-C
// integration tests for backfill_cam_engine_v2_legacy_data, against the
// real local database.
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

async function createActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-backfill-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

async function callBackfill(admin: ReturnType<typeof adminClient>, orgId: string, propertyId: string, dryRun: boolean, actor: { userId: string; email: string }) {
  const { data, error } = await admin.rpc("backfill_cam_engine_v2_legacy_data", {
    p_org_id: orgId, p_property_id: propertyId, p_dry_run: dryRun, p_actor_user_id: actor.userId, p_actor_email: actor.email,
  });
  assertNoError(error);
  return data;
}

Deno.test({
  name: "backfill: dry-run reports candidates without writing any rows",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Backfill Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Backfill Property ${suffix}`, status: "active" });
    await insertOne(admin, "units", { org_id: org.id, property_id: property.id, unit_number: "101", square_footage: 5000 });
    await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01", square_footage: 5000 });

    const result = await callBackfill(admin, org.id, property.id, true, actor);
    assertEquals(result.dry_run, true);
    assertEquals(result.report.area_measurements_from_units.created, 1);
    assertEquals(result.report.lease_premises_from_leases.created, 1);

    const { data: measurements } = await admin.from("space_area_measurements").select("id").eq("org_id", org.id);
    assertEquals(measurements!.length, 0); // dry-run wrote nothing
    const { data: premises } = await admin.from("lease_premises").select("id").eq("org_id", org.id);
    assertEquals(premises!.length, 0);
  },
});

Deno.test({
  name: "backfill: apply mode writes rows tagged legacy_backfill/needs_review, and is idempotent on rerun",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Backfill Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Backfill Property ${suffix}`, status: "active" });
    const unit = await insertOne(admin, "units", { org_id: org.id, property_id: property.id, unit_number: "101", square_footage: 5000 });
    const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, unit_id: unit.id, commencement_date: "2026-01-01", square_footage: 5000 });

    const first = await callBackfill(admin, org.id, property.id, false, actor);
    assertEquals(first.report.area_measurements_from_units.created, 1);
    assertEquals(first.report.lease_premises_from_leases.created, 1);

    const { data: measurement } = await admin.from("space_area_measurements").select("*").eq("org_id", org.id).eq("scope_id", unit.id).single();
    assertEquals(measurement!.source_type, "legacy_backfill");
    assertEquals(measurement!.review_status, "needs_review");
    assertExists(measurement!.backfill_confidence);
    assertExists(measurement!.backfill_derivation_method);

    const { data: premises } = await admin.from("lease_premises").select("*").eq("org_id", org.id).eq("lease_id", lease.id).single();
    assertEquals(premises!.source_type, "legacy_backfill");
    assertEquals(premises!.status, "draft"); // never auto-approved
    assertEquals(premises!.review_status, "needs_review");

    const { data: spaces } = await admin.from("lease_premises_spaces").select("id").eq("lease_premises_id", premises!.id);
    assertEquals(spaces!.length, 1);
    const { data: areaPeriods } = await admin.from("lease_premises_area_periods").select("recovery_area_sqft").eq("lease_premises_id", premises!.id);
    assertEquals(Number(areaPeriods![0].recovery_area_sqft), 5000);

    // Rerun: idempotent, no duplicates, everything now "reused."
    const second = await callBackfill(admin, org.id, property.id, false, actor);
    assertEquals(second.report.area_measurements_from_units.created, 0);
    assertEquals(second.report.area_measurements_from_units.reused, 1);
    assertEquals(second.report.lease_premises_from_leases.created, 0);

    const { data: measurementsAfter } = await admin.from("space_area_measurements").select("id").eq("org_id", org.id);
    assertEquals(measurementsAfter!.length, 1); // still exactly one row, not duplicated
    const { data: premisesAfter } = await admin.from("lease_premises").select("id").eq("org_id", org.id);
    assertEquals(premisesAfter!.length, 1);
  },
});

Deno.test({
  name: "backfill: a unit with no square footage is skipped, not fabricated",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Backfill Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Backfill Property ${suffix}`, status: "active" });
    await insertOne(admin, "units", { org_id: org.id, property_id: property.id, unit_number: "101" }); // no square_footage

    const result = await callBackfill(admin, org.id, property.id, false, actor);
    assertEquals(result.report.area_measurements_from_units.created, 0);
    assertEquals(result.report.area_measurements_from_units.skipped, 1);
  },
});

Deno.test({
  name: "backfill: a lease with no commencement_date/start_date is blocked, never guessed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Backfill Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Backfill Property ${suffix}`, status: "active" });
    await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, square_footage: 3000 }); // no commencement_date, no start_date

    const result = await callBackfill(admin, org.id, property.id, false, actor);
    assertEquals(result.report.lease_premises_from_leases.created, 0);
    assertEquals(result.report.lease_premises_from_leases.blocked, 1);

    const { data: premises } = await admin.from("lease_premises").select("id").eq("org_id", org.id);
    assertEquals(premises!.length, 0);
  },
});

Deno.test({
  name: "backfill: approved lease_expense_rules materialize into recovery policies via the existing materialize RPC, with failures isolated per-rule",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Backfill Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Backfill Property ${suffix}`, status: "active" });
    const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01" });
    const leaseNoDate = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id }); // no commencement_date -> materialize will fail
    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const ruleSetNoDate = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: leaseNoDate.id });
    const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
    await insertOne(admin, "lease_expense_rules", {
      org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
      approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
    });
    await insertOne(admin, "lease_expense_rules", {
      org_id: org.id, rule_set_id: ruleSetNoDate.id, expense_category_id: category.id, lease_id: leaseNoDate.id, property_id: property.id,
      approval_status: "approved", recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
    });

    const result = await callBackfill(admin, org.id, property.id, false, actor);
    assertEquals(result.report.recovery_policies_from_rules.created, 1);
    assertEquals(result.report.recovery_policies_from_rules.blocked, 1);
    assertEquals(result.report.recovery_policies_from_rules.blocked_examples.length, 1);

    const { data: policies } = await admin.from("lease_recovery_policies").select("id, lease_id").eq("org_id", org.id);
    assertEquals(policies!.length, 1);
    assertEquals(policies![0].lease_id, lease.id);

    // Rerun is idempotent for the one that succeeded, and still reports the same block for the other.
    const second = await callBackfill(admin, org.id, property.id, false, actor);
    assertEquals(second.report.recovery_policies_from_rules.created, 0);
    assertEquals(second.report.recovery_policies_from_rules.reused, 1);
    assertEquals(second.report.recovery_policies_from_rules.blocked, 1);
  },
});

Deno.test({
  name: "backfill: unassigned published expenses and estimate schedules are reported only, never auto-assigned",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `Backfill Org ${suffix}`, status: "active" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Backfill Property ${suffix}`, status: "active" });
    await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id, property_id: property.id, amount: 5000, publication_status: "published", publication_version: 1,
    });

    const result = await callBackfill(admin, org.id, property.id, true, actor);
    assertEquals(result.report.pool_assignments.needs_review, 1);
    assertEquals(result.report.pool_assignments.created, 0);
    assertExists(result.report.pool_assignments.note);
    assertExists(result.report.estimate_schedules.note);

    const { data: assignments } = await admin.from("cam_input_pool_assignments").select("id").eq("org_id", org.id);
    assertEquals(assignments!.length, 0); // never auto-assigned
  },
});

Deno.test({
  name: "backfill: cross-organization property is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await createActor(admin, suffix);
    const orgA = await insertOne(admin, "organizations", { name: `Backfill Org A ${suffix}`, status: "active" });
    const orgB = await insertOne(admin, "organizations", { name: `Backfill Org B ${suffix}`, status: "active" });
    const propertyA = await insertOne(admin, "properties", { org_id: orgA.id, name: `Backfill Property A ${suffix}`, status: "active" });

    const { error } = await admin.rpc("backfill_cam_engine_v2_legacy_data", {
      p_org_id: orgB.id, p_property_id: propertyA.id, p_dry_run: true, p_actor_user_id: actor.userId, p_actor_email: actor.email,
    });
    assertExists(error);
  },
});

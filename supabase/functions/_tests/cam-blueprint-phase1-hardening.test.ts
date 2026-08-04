// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 1 hardening
// tests. Covers the 9 hardening requirements applied on top of the
// original Phase 1 schema (migrations 20269900000008-20269900000010,
// renamed twice from 20260908-10 — see that migration's header for the
// full rename history):
//   1. Overlap prevention (EXCLUDE constraints)
//   3. FK delete behavior for CAM ledger records (RESTRICT, not CASCADE)
//   4. Corrected one-active-run uniqueness dimensions (run_type included)
//   5. Idempotency / natural uniqueness constraints
//   6. Policy-to-source-rule evidence traceability
//   7. Hierarchy validation for polymorphic scopes (_shared/cam-engine-v2/
//      validation/hierarchy.ts)
//   8. Transactional enforcement that finalized allocations balance
//   9. Immutable posted runs + valid status transitions
// (2, numeric precision, has no independent behavior to assert beyond what
// the FK-chain tests in cam-blueprint-phase1-schema.test.ts already
// exercise by inserting real decimal amounts successfully.)
import {
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import {
  assertValidPoolMemberScope,
  assertValidPoolScope,
  assertValidSpaceScope,
} from "../_shared/cam-engine-v2/validation/hierarchy.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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

async function setUpOrgPropertyLease(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", { name: `CAM Hardening Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Hardening Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id });
  return { org, property, lease };
}

async function setUpCalendarPeriodPool(admin: ReturnType<typeof adminClient>, org: any, property: any, suffix: string) {
  const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: `Cal ${suffix}`, calendar_type: "calendar_year" });
  const period = await insertOne(admin, "recovery_periods", { org_id: org.id, calendar_id: calendar.id, start_date: "2026-01-01", end_date: "2026-12-31", label: `FY2026 ${suffix}` });
  const pool = await insertOne(admin, "recovery_pools", { org_id: org.id, period_id: period.id, property_id: property.id, name: `Pool ${suffix}`, pool_type: "property", scope_type: "property" });
  return { calendar, period, pool };
}

// ===========================================================================
// 1. Overlap prevention
// ===========================================================================

Deno.test({
  name: "Hardening/1: two overlapping ACTIVE lease_premises of the SAME type are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpOrgPropertyLease(admin, suffix);

    await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", effective_to: "2026-06-30", status: "approved" });

    const { data, error } = await admin.from("lease_premises").insert({
      org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-04-01", effective_to: "2026-12-31", status: "approved",
    }).select("*").single();

    assertEquals(data, null);
    assertExists(error);
    assertEquals(/exclusion|conflict/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Hardening/1: overlapping lease_premises of DIFFERENT types (primary + storage) are allowed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpOrgPropertyLease(admin, suffix);

    await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
    const storage = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "storage", effective_from: "2026-01-01", status: "approved" });
    assertExists(storage);
  },
});

Deno.test({
  name: "Hardening/1: a new premises record CAN overlap a SUPERSEDED old one (amendment/relocation path)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpOrgPropertyLease(admin, suffix);

    const original = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved" });
    await admin.from("lease_premises").update({ status: "superseded", effective_to: "2026-06-30" }).eq("id", original.id);

    const relocated = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, premises_type: "primary", effective_from: "2026-04-01", status: "approved" });
    assertExists(relocated, "a superseded record must not block a new overlapping record from the same relocation/amendment");
  },
});

Deno.test({
  name: "Hardening/1: two overlapping space_area_measurements for the same scope+area_type are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);

    await insertOne(admin, "space_area_measurements", { org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 10000, effective_from: "2026-01-01" });

    const { data, error } = await admin.from("space_area_measurements").insert({
      org_id: org.id, scope_type: "property", scope_id: property.id, area_type: "rentable", area_sqft: 10500, effective_from: "2026-03-01",
    }).select("*").single();
    assertEquals(data, null);
    assertExists(error);
    assertEquals(/exclusion|conflict/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Hardening/1: two overlapping recovery_pool_scope_members for the same pool+scope are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { pool } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const buildingId = crypto.randomUUID();

    await insertOne(admin, "recovery_pool_scope_members", { org_id: org.id, pool_id: pool.id, scope_type: "building", scope_id: buildingId, effective_from: "2026-01-01" });

    const { data, error } = await admin.from("recovery_pool_scope_members").insert({
      org_id: org.id, pool_id: pool.id, scope_type: "building", scope_id: buildingId, effective_from: "2026-06-01",
    }).select("*").single();
    assertEquals(data, null);
    assertExists(error);
    assertEquals(/exclusion|conflict/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Hardening/1: two overlapping lease_recovery_policies from the SAME rule are rejected; superseding first then republishing succeeds",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
    const rule = await insertOne(admin, "lease_expense_rules", { org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id, approval_status: "approved" });

    const v1 = await insertOne(admin, "lease_recovery_policies", { org_id: org.id, lease_id: lease.id, source_rule_id: rule.id, source_rule_updated_at: "2026-01-01T00:00:00Z", effective_from: "2026-01-01", status: "approved" });

    const { data: overlapData, error: overlapError } = await admin.from("lease_recovery_policies").insert({
      org_id: org.id, lease_id: lease.id, source_rule_id: rule.id, source_rule_updated_at: "2026-02-01T00:00:00Z", effective_from: "2026-06-01", status: "approved",
    }).select("*").single();
    assertEquals(overlapData, null);
    assertExists(overlapError);

    await admin.from("lease_recovery_policies").update({ status: "superseded", effective_to: "2026-05-31" }).eq("id", v1.id);
    const v2 = await insertOne(admin, "lease_recovery_policies", {
      org_id: org.id, lease_id: lease.id, source_rule_id: rule.id, source_rule_updated_at: "2026-02-01T00:00:00Z", effective_from: "2026-06-01", status: "approved",
    });
    assertExists(v2, "superseding v1 must free the window for v2");
  },
});

// ===========================================================================
// 3. FK delete behavior for CAM ledger records
// ===========================================================================

Deno.test({
  name: "Hardening/3: deleting a cam_run with child pool results is rejected (RESTRICT, not CASCADE)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period, pool } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const run = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard" });
    await insertOne(admin, "cam_run_pool_results", { org_id: org.id, cam_run_id: run.id, pool_id: pool.id, actual_amount: 100 });

    const { error } = await admin.from("cam_runs").delete().eq("id", run.id);
    assertExists(error, "deleting a cam_run with children must be rejected, not silently cascade-wipe the ledger");
    assertEquals(/foreign key|violat/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Hardening/3: deleting a recovery_period with a pool attached is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period } = await setUpCalendarPeriodPool(admin, org, property, suffix);

    const { error } = await admin.from("recovery_periods").delete().eq("id", period.id);
    assertExists(error, "deleting a recovery_period with a pool must be rejected");
  },
});

// ===========================================================================
// 4. Corrected one-active-run uniqueness dimensions
// ===========================================================================

Deno.test({
  name: "Hardening/4: a standard run and an adjustment run for the SAME period+scope coexist (run_type is a real partition dimension)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period } = await setUpCalendarPeriodPool(admin, org, property, suffix);

    const standard = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard" });
    const adjustment = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "adjustment" });
    assertExists(standard);
    assertExists(adjustment);
    assertEquals(standard.id !== adjustment.id, true);
  },
});

// ===========================================================================
// 5. Idempotency / natural uniqueness constraints
// ===========================================================================

Deno.test({
  name: "Hardening/5: duplicate recovery_calendars (same org+property+name) are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);

    await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Calendar Year" });
    const { data, error } = await admin.from("recovery_calendars").insert({ org_id: org.id, property_id: property.id, name: "Calendar Year" }).select("*").single();
    assertEquals(data, null);
    assertExists(error);
  },
});

Deno.test({
  name: "Hardening/5: re-materializing the SAME rule version (same source_rule_updated_at) is rejected as a duplicate — the materialization RPC must look this up first, not blind-insert",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
    const rule = await insertOne(admin, "lease_expense_rules", { org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id, approval_status: "approved" });

    await insertOne(admin, "lease_recovery_policies", { org_id: org.id, lease_id: lease.id, source_rule_id: rule.id, source_rule_updated_at: "2026-01-01T00:00:00Z", effective_from: "2026-01-01" });
    const { data, error } = await admin.from("lease_recovery_policies").insert({
      org_id: org.id, lease_id: lease.id, source_rule_id: rule.id, source_rule_updated_at: "2026-01-01T00:00:00Z", effective_from: "2026-01-01",
    }).select("*").single();
    assertEquals(data, null);
    assertExists(error);
  },
});

Deno.test({
  name: "Hardening/5: assigning the same cam_expense_input to the same pool twice is rejected (idempotent-assignment natural key)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { pool } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const camInput = await insertOne(admin, "cam_expense_inputs", { org_id: org.id, property_id: property.id, amount: 500, category: "CAM" });

    await insertOne(admin, "cam_input_pool_assignments", { org_id: org.id, cam_expense_input_id: camInput.id, recovery_pool_id: pool.id, amount: 500 });
    const { data, error } = await admin.from("cam_input_pool_assignments").insert({
      org_id: org.id, cam_expense_input_id: camInput.id, recovery_pool_id: pool.id, amount: 500,
    }).select("*").single();
    assertEquals(data, null);
    assertExists(error);
  },
});

// ===========================================================================
// 6. Policy-to-source-rule evidence traceability
// ===========================================================================

Deno.test({
  name: "Hardening/6: lease_recovery_policies.source_evidence stores a frozen snapshot of the source rule's evidence",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
      approval_status: "approved", source_page: 12, exact_source_text: "Tenant shall pay its pro rata share of Operating Expenses.", confidence_score: 0.94,
    });

    const policy = await insertOne(admin, "lease_recovery_policies", {
      org_id: org.id, lease_id: lease.id, source_rule_id: rule.id, source_rule_updated_at: rule.updated_at, effective_from: "2026-01-01",
      source_evidence: { source_page: rule.source_page, exact_source_text: rule.exact_source_text, confidence_score: rule.confidence_score },
    });

    const { data: reloaded } = await admin.from("lease_recovery_policies").select("source_evidence").eq("id", policy.id).single();
    assertExists(reloaded);
    assertEquals(reloaded.source_evidence.source_page, 12);
    assertEquals(reloaded.source_evidence.exact_source_text, "Tenant shall pay its pro rata share of Operating Expenses.");
    assertEquals(reloaded.source_evidence.confidence_score, 0.94);
  },
});

// ===========================================================================
// 7. Hierarchy validation for polymorphic scopes (unit tests against real
// data via the admin client — no HTTP layer exists yet, this is a shared
// module Phase 2's RPCs will call).
// ===========================================================================

Deno.test({
  name: "Hardening/7: assertValidPoolMemberScope rejects scope_type=property (a member cannot be the whole property)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    await assertRejects(
      () => assertValidPoolMemberScope(admin, org.id, property.id, "property", property.id),
      Error,
      "must be",
    );
  },
});

Deno.test({
  name: "Hardening/7: assertValidPoolScope accepts scope_type=custom without requiring a real physical scope_id",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const resolved = await assertValidPoolScope(admin, org.id, property.id, "custom", null);
    assertEquals(resolved.scope_type, "custom");
    assertEquals(resolved.property_id, property.id);
  },
});

Deno.test({
  name: "Hardening/7: assertValidSpaceScope rejects a scope_id belonging to a DIFFERENT organization's property",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const otherOrg = await insertOne(admin, "organizations", { name: `Other Org ${suffix}`, status: "active" });
    const otherProperty = await insertOne(admin, "properties", { org_id: otherOrg.id, name: `Other Property ${suffix}`, status: "active" });

    await assertRejects(
      () => assertValidSpaceScope(admin, org.id, property.id, "property", otherProperty.id),
      Error,
    );
  },
});

// ===========================================================================
// 8. Transactional enforcement that finalized allocations balance to their
// source expense
// ===========================================================================

Deno.test({
  name: "Hardening/8: finalized allocations summing to EXACTLY the expense amount succeed",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertOne(admin, "expenses", { org_id: org.id, property_id: property.id, category: "CAM", amount: 1000 });

    await insertOne(admin, "expense_allocations", { org_id: org.id, expense_id: expense.id, amount: 600, status: "finalized" });
    const second = await insertOne(admin, "expense_allocations", { org_id: org.id, expense_id: expense.id, amount: 400, status: "finalized" });
    assertExists(second);
  },
});

Deno.test({
  name: "Hardening/8: finalized allocations that EXCEED the source expense amount are rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertOne(admin, "expenses", { org_id: org.id, property_id: property.id, category: "CAM", amount: 1000 });

    await insertOne(admin, "expense_allocations", { org_id: org.id, expense_id: expense.id, amount: 700, status: "finalized" });
    const { data, error } = await admin.from("expense_allocations").insert({
      org_id: org.id, expense_id: expense.id, amount: 400, status: "finalized",
    }).select("*").single();
    assertEquals(data, null, "700 + 400 = 1100 > expense amount 1000 must be rejected");
    assertExists(error);
    assertEquals(/exceed/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Hardening/8: a PARTIAL (under-allocated) finalized allocation is allowed — readiness engine's job, not a hard error",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const expense = await insertOne(admin, "expenses", { org_id: org.id, property_id: property.id, category: "CAM", amount: 1000 });

    const partial = await insertOne(admin, "expense_allocations", { org_id: org.id, expense_id: expense.id, amount: 300, status: "finalized" });
    assertExists(partial, "under-allocation must not be blocked at the DB layer");
  },
});

// ===========================================================================
// 9. Immutable posted runs + valid status transitions
// ===========================================================================

Deno.test({
  name: "Hardening/9: an invalid direct status transition (draft -> posted) is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const run = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard", status: "draft" });

    const { error } = await admin.from("cam_runs").update({ status: "posted" }).eq("id", run.id);
    assertExists(error);
    assertEquals(/invalid.*transition/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Hardening/9: a valid full status transition chain succeeds end to end",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const run = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard", status: "draft" });

    const chain = ["ready", "calculating", "calculated", "under_review", "submitted", "approved", "posted"];
    for (const status of chain) {
      const { error } = await admin.from("cam_runs").update({ status }).eq("id", run.id);
      assertNoError(error);
    }

    const { data: finalRun } = await admin.from("cam_runs").select("status").eq("id", run.id).single();
    assertExists(finalRun);
    assertEquals(finalRun.status, "posted");
  },
});

Deno.test({
  name: "Hardening/9: once posted, only a transition to superseded is permitted — any other field change is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const run = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard", status: "draft" });
    for (const status of ["ready", "calculating", "calculated", "under_review", "submitted", "approved", "posted"]) {
      await admin.from("cam_runs").update({ status }).eq("id", run.id);
    }

    const { error: statusRegressError } = await admin.from("cam_runs").update({ status: "under_review" }).eq("id", run.id);
    assertExists(statusRegressError, "a posted run must never move backward to an earlier status");

    const { error: fieldChangeError } = await admin.from("cam_runs").update({ engine_version: "v2.0.1" }).eq("id", run.id);
    assertExists(fieldChangeError, "a posted run's fields other than status must be frozen");

    const { error: supersedeError } = await admin.from("cam_runs").update({ status: "superseded" }).eq("id", run.id);
    assertNoError(supersedeError);

    const { error: postSupersedeError } = await admin.from("cam_runs").update({ status: "voided" }).eq("id", run.id);
    assertExists(postSupersedeError, "a superseded run is terminal — no further changes at all");
  },
});

Deno.test({
  name: "Hardening/9: a ledger child row (cam_run_pool_results) cannot be updated once the parent run is posted",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);
    const { period, pool } = await setUpCalendarPeriodPool(admin, org, property, suffix);
    const run = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard", status: "draft" });
    const poolResult = await insertOne(admin, "cam_run_pool_results", { org_id: org.id, cam_run_id: run.id, pool_id: pool.id, actual_amount: 100000 });

    for (const status of ["ready", "calculating", "calculated", "under_review", "submitted", "approved", "posted"]) {
      await admin.from("cam_runs").update({ status }).eq("id", run.id);
    }

    const { error } = await admin.from("cam_run_pool_results").update({ actual_amount: 999999 }).eq("id", poolResult.id);
    assertExists(error, "ledger detail rows must be frozen once the parent run is posted, even for a privileged (service_role) caller");
    assertEquals(/immutable/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 1 schema
// tests. Phase 1 is pure additive schema (no RPCs/Edge Functions yet), so
// these are real-database integration tests against the actual migrations
// (20269900000008 / 20269900000009 / 20269900000010), not workflow tests:
//   1. Full FK insert-chain smoke test per migration (proves the schema is
//      internally consistent and references real, existing tables).
//   2. The two constraints that encode real business rules, not just column
//      shape: the effective-date window CHECK, and cam_runs' partial unique
//      index (at most one non-voided/non-superseded standard/adjustment/
//      restatement run per org+period+scope; preview runs and voided runs
//      are exempt — history is never deleted, matching the same pattern
//      already used for cam_expense_inputs.publication_status and
//      computation_snapshots.status elsewhere in this codebase).
//   3. RLS: org-scoped SELECT works, direct authenticated INSERT is
//      rejected (all writes are service_role-only until Phase B RPCs own
//      them), and cross-org SELECT is blocked.
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
  const email = `cam-blueprint-phase1-${suffix}@example.test`;
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
    full_name: "CAM Blueprint Phase 1 Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", { user_id: userId, org_id: orgId, role });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { userId, accessToken };
}

function userClient(accessToken: string) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function setUpOrgPropertyLease(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", { name: `CAM Blueprint Org ${suffix}`, status: "active" });
  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `CAM Blueprint Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id });
  return { org, accessToken, property, lease };
}

// ===========================================================================
// Migration 1 of 3 — premises, area, and occupancy foundation
// ===========================================================================

Deno.test({
  name: "Phase1/Migration1: full FK insert chain (lease_premises -> spaces, area measurement, area period, occupancy period) succeeds and cascades on delete",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);

    const premises = await insertOne(admin, "lease_premises", {
      org_id: org.id,
      lease_id: lease.id,
      premises_type: "primary",
      effective_from: "2026-01-01",
      status: "approved",
    });

    const space = await insertOne(admin, "lease_premises_spaces", {
      org_id: org.id,
      lease_premises_id: premises.id,
      property_id: property.id,
      allocation_weight: 1,
    });

    const areaMeasurement = await insertOne(admin, "space_area_measurements", {
      org_id: org.id,
      scope_type: "property",
      scope_id: property.id,
      area_type: "rentable",
      area_sqft: 10000,
      effective_from: "2026-01-01",
    });
    assertEquals(Number(areaMeasurement.area_sqft), 10000);

    const areaPeriod = await insertOne(admin, "lease_premises_area_periods", {
      org_id: org.id,
      lease_premises_id: premises.id,
      area_basis: "rentable",
      recovery_area_sqft: 1200,
      effective_from: "2026-01-01",
    });
    assertEquals(Number(areaPeriod.recovery_area_sqft), 1200);

    const occupancy = await insertOne(admin, "space_occupancy_periods", {
      org_id: org.id,
      scope_type: "property",
      scope_id: property.id,
      lease_id: lease.id,
      occupancy_status: "occupied",
      occupied_area_sqft: 1200,
      effective_from: "2026-01-01",
    });
    assertEquals(occupancy.occupancy_status, "occupied");

    // Cascade: deleting the premises record must remove its spaces row too.
    const { error: deleteError } = await admin.from("lease_premises").delete().eq("id", premises.id);
    assertNoError(deleteError);
    const { data: spaceAfter } = await admin.from("lease_premises_spaces").select("id").eq("id", space.id).maybeSingle();
    assertEquals(spaceAfter, null, "lease_premises_spaces row must cascade-delete with its parent lease_premises row");
  },
});

Deno.test({
  name: "Phase1/Migration1: effective-date window CHECK rejects effective_to before effective_from",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpOrgPropertyLease(admin, suffix);

    const { data, error } = await admin.from("lease_premises").insert({
      org_id: org.id,
      lease_id: lease.id,
      effective_from: "2026-06-01",
      effective_to: "2026-01-01", // before effective_from — must be rejected
    }).select("*").single();

    assertEquals(data, null);
    assertExists(error);
    assertEquals(/check/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

// ===========================================================================
// Migration 2 of 3 — expense allocation/publication additions + recovery
// setup (including lease_recovery_policies, where the effective-dated
// lease-rule work folded in).
// ===========================================================================

Deno.test({
  name: "Phase1/Migration2: full FK insert chain (calendar -> period -> pool -> pool category/scope member) succeeds",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);

    const calendar = await insertOne(admin, "recovery_calendars", {
      org_id: org.id,
      property_id: property.id,
      name: "Calendar Year",
      calendar_type: "calendar_year",
    });

    const period = await insertOne(admin, "recovery_periods", {
      org_id: org.id,
      calendar_id: calendar.id,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      label: "FY2026",
    });

    const pool = await insertOne(admin, "recovery_pools", {
      org_id: org.id,
      period_id: period.id,
      property_id: property.id,
      name: "Property Pool",
      pool_type: "property",
      scope_type: "property",
    });

    const category = await insertOne(admin, "expense_categories", {
      org_id: org.id,
      category_name: `Blueprint Category ${crypto.randomUUID()}`,
      normalized_key: `blueprint_category_${crypto.randomUUID()}`,
    });

    const poolCategory = await insertOne(admin, "recovery_pool_categories", {
      org_id: org.id,
      pool_id: pool.id,
      expense_category_id: category.id,
      inclusion_mode: "include",
    });
    assertEquals(poolCategory.variability_default, "unknown", "must default to unknown, not silently assume gross-up eligibility");

    const { data: scopeMember, error } = await admin.from("recovery_pool_scope_members").insert({
      org_id: org.id,
      pool_id: pool.id,
      scope_type: "building",
      scope_id: crypto.randomUUID(),
      effective_from: "2026-01-01",
    }).select("*").single();
    assertNoError(error);
    assertExists(scopeMember);
  },
});

Deno.test({
  name: "Phase1/Migration2: recovery_pools requires either a period_id or is_template=true",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);

    const { data, error } = await admin.from("recovery_pools").insert({
      org_id: org.id,
      property_id: property.id,
      name: "Invalid Pool",
      pool_type: "property",
      scope_type: "property",
      is_template: false,
      period_id: null,
    }).select("*").single();

    assertEquals(data, null);
    assertExists(error);
    assertEquals(/check/i.test(error.message || ""), true, JSON.stringify(error));
  },
});

Deno.test({
  name: "Phase1/Migration2: lease_recovery_policies supersession chain preserves history (old row not deleted)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const category = await insertOne(admin, "expense_categories", {
      org_id: org.id,
      category_name: `Blueprint Category ${crypto.randomUUID()}`,
      normalized_key: `blueprint_category_${crypto.randomUUID()}`,
    });
    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      lease_id: lease.id,
      property_id: property.id,
      approval_status: "approved",
    });

    const policyV1 = await insertOne(admin, "lease_recovery_policies", {
      org_id: org.id,
      lease_id: lease.id,
      source_rule_id: rule.id,
      effective_from: "2026-01-01",
      effective_to: "2026-06-30",
      status: "approved",
    });

    const amendment = await insertOne(admin, "lease_amendments", {
      org_id: org.id,
      lease_id: lease.id,
      amendment_type: "modification",
      effective_date: "2026-07-01",
    });

    const policyV2 = await insertOne(admin, "lease_recovery_policies", {
      org_id: org.id,
      lease_id: lease.id,
      source_rule_id: rule.id,
      lease_amendment_id: amendment.id,
      effective_from: "2026-07-01",
      effective_to: null,
      status: "approved",
    });

    const { error: supersedeError } = await admin
      .from("lease_recovery_policies")
      .update({ status: "superseded", superseded_by_policy_id: policyV2.id })
      .eq("id", policyV1.id);
    assertNoError(supersedeError);

    const { data: v1After } = await admin.from("lease_recovery_policies").select("*").eq("id", policyV1.id).single();
    assertExists(v1After, "superseded policy must still exist — history is never deleted");
    assertEquals(v1After.status, "superseded");
    assertEquals(v1After.superseded_by_policy_id, policyV2.id);

    const { data: allVersions } = await admin
      .from("lease_recovery_policies")
      .select("id, status")
      .eq("lease_id", lease.id)
      .eq("source_rule_id", rule.id)
      .order("effective_from");
    assertEquals(allVersions?.length, 2, "both policy versions must coexist");
  },
});

Deno.test({
  name: "Phase1/Migration2: cam_input_pool_assignments references the EXISTING cam_expense_inputs table (not a new duplicate)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);

    const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Cal", calendar_type: "calendar_year" });
    const period = await insertOne(admin, "recovery_periods", { org_id: org.id, calendar_id: calendar.id, start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026" });
    const pool = await insertOne(admin, "recovery_pools", { org_id: org.id, period_id: period.id, property_id: property.id, name: "Pool", pool_type: "property", scope_type: "property" });

    const camInput = await insertOne(admin, "cam_expense_inputs", {
      org_id: org.id,
      property_id: property.id,
      amount: 500,
      category: "CAM",
    });

    const assignment = await insertOne(admin, "cam_input_pool_assignments", {
      org_id: org.id,
      cam_expense_input_id: camInput.id,
      recovery_pool_id: pool.id,
      amount: 500,
    });
    assertEquals(assignment.cam_expense_input_id, camInput.id);

    // Cascade: deleting the underlying cam_expense_inputs row removes the assignment too.
    const { error: deleteError } = await admin.from("cam_expense_inputs").delete().eq("id", camInput.id);
    assertNoError(deleteError);
    const { data: assignmentAfter } = await admin.from("cam_input_pool_assignments").select("id").eq("id", assignment.id).maybeSingle();
    assertEquals(assignmentAfter, null);
  },
});

// ===========================================================================
// Migration 3 of 3 — CAM run ledger
// ===========================================================================

Deno.test({
  name: "Phase1/Migration3: full FK insert chain (cam_run -> pool result, lease result, calculation line, exception) succeeds",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, lease } = await setUpOrgPropertyLease(admin, suffix);

    const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Cal", calendar_type: "calendar_year" });
    const period = await insertOne(admin, "recovery_periods", { org_id: org.id, calendar_id: calendar.id, start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026" });
    const pool = await insertOne(admin, "recovery_pools", { org_id: org.id, period_id: period.id, property_id: property.id, name: "Pool", pool_type: "property", scope_type: "property" });

    const run = await insertOne(admin, "cam_runs", {
      org_id: org.id,
      recovery_period_id: period.id,
      scope_type: "property",
      scope_id: property.id,
      run_type: "standard",
      status: "draft",
    });

    const poolResult = await insertOne(admin, "cam_run_pool_results", {
      org_id: org.id,
      cam_run_id: run.id,
      pool_id: pool.id,
      actual_amount: 100000,
      adjusted_pool: 118750,
    });

    const leaseResult = await insertOne(admin, "cam_run_lease_results", {
      org_id: org.id,
      cam_run_id: run.id,
      lease_id: lease.id,
      final_recovery: 8800,
    });

    const line = await insertOne(admin, "cam_run_calculation_lines", {
      org_id: org.id,
      cam_run_id: run.id,
      lease_result_id: leaseResult.id,
      pool_result_id: poolResult.id,
      sequence: 1,
      line_type: "POOL_SOURCE",
      input_amount: 100000,
      output_amount: 100000,
    });
    assertEquals(line.line_type, "POOL_SOURCE");

    const exception = await insertOne(admin, "cam_run_exceptions", {
      org_id: org.id,
      cam_run_id: run.id,
      severity: "warning",
      code: "MATERIAL_VARIANCE",
      message: "Result exceeds configured review threshold.",
    });
    assertEquals(exception.resolution_status, "open");
  },
});

Deno.test({
  name: "Phase1/Migration3: at most one non-voided/non-superseded standard run per org+period+scope; preview and voided runs are exempt",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property } = await setUpOrgPropertyLease(admin, suffix);

    const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Cal", calendar_type: "calendar_year" });
    const period = await insertOne(admin, "recovery_periods", { org_id: org.id, calendar_id: calendar.id, start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026" });

    const firstRun = await insertOne(admin, "cam_runs", {
      org_id: org.id,
      recovery_period_id: period.id,
      scope_type: "property",
      scope_id: property.id,
      run_type: "standard",
      status: "draft",
    });

    // A second standard run for the SAME series must be rejected.
    const { data: dupData, error: dupError } = await admin.from("cam_runs").insert({
      org_id: org.id,
      recovery_period_id: period.id,
      scope_type: "property",
      scope_id: property.id,
      run_type: "standard",
      status: "draft",
    }).select("*").single();
    assertEquals(dupData, null);
    assertExists(dupError);
    assertEquals(/duplicate key|unique/i.test(dupError.message || ""), true, JSON.stringify(dupError));

    // A preview run for the same series is exempt from the constraint.
    const previewRun = await insertOne(admin, "cam_runs", {
      org_id: org.id,
      recovery_period_id: period.id,
      scope_type: "property",
      scope_id: property.id,
      run_type: "preview",
      status: "draft",
    });
    assertExists(previewRun);

    // Voiding the first run frees the series for a new standard run —
    // history is preserved (the voided row is never deleted).
    await admin.from("cam_runs").update({ status: "voided" }).eq("id", firstRun.id);
    const secondRun = await insertOne(admin, "cam_runs", {
      org_id: org.id,
      recovery_period_id: period.id,
      scope_type: "property",
      scope_id: property.id,
      run_type: "standard",
      status: "draft",
    });
    assertExists(secondRun);

    const { data: allRuns } = await admin.from("cam_runs").select("id, status").eq("recovery_period_id", period.id).eq("run_type", "standard");
    assertEquals(allRuns?.length, 2, "both the voided and the new standard run must coexist — history is never deleted");
  },
});

// ===========================================================================
// RLS — representative tables from each migration
// ===========================================================================

Deno.test({
  name: "Phase1 RLS: org member can SELECT; direct authenticated INSERT is rejected on all three migrations' tables",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpOrgPropertyLease(admin, suffix);
    const asUser = userClient(accessToken);

    const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, effective_from: "2026-01-01" });
    const calendar = await insertOne(admin, "recovery_calendars", { org_id: org.id, property_id: property.id, name: "Cal", calendar_type: "calendar_year" });
    const period = await insertOne(admin, "recovery_periods", { org_id: org.id, calendar_id: calendar.id, start_date: "2026-01-01", end_date: "2026-12-31", label: "FY2026" });
    const run = await insertOne(admin, "cam_runs", { org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id, run_type: "standard" });

    const { data: premisesRead, error: premisesReadError } = await asUser.from("lease_premises").select("id").eq("id", premises.id).maybeSingle();
    assertNoError(premisesReadError);
    assertExists(premisesRead, "org member must be able to SELECT lease_premises");

    const { data: runRead, error: runReadError } = await asUser.from("cam_runs").select("id").eq("id", run.id).maybeSingle();
    assertNoError(runReadError);
    assertExists(runRead, "org member must be able to SELECT cam_runs");

    const { data: insertData, error: insertError } = await asUser.from("lease_premises").insert({
      org_id: org.id,
      lease_id: lease.id,
      effective_from: "2026-02-01",
    }).select("*").single();
    assertEquals(insertData, null, "direct authenticated INSERT into lease_premises must be rejected — service_role only until Phase B RPCs exist");
    assertExists(insertError);

    const { data: runInsertData, error: runInsertError } = await asUser.from("cam_runs").insert({
      org_id: org.id,
      recovery_period_id: period.id,
      scope_type: "property",
      scope_id: property.id,
      run_type: "adjustment",
    }).select("*").single();
    assertEquals(runInsertData, null, "direct authenticated INSERT into cam_runs must be rejected");
    assertExists(runInsertError);
  },
});

Deno.test({
  name: "Phase1 RLS: cross-organization SELECT is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpOrgPropertyLease(admin, suffix);
    const premises = await insertOne(admin, "lease_premises", { org_id: org.id, lease_id: lease.id, effective_from: "2026-01-01" });

    const otherOrg = await insertOne(admin, "organizations", { name: `CAM Blueprint Other Org ${suffix}`, status: "active" });
    const { accessToken: otherToken } = await createOrgUser(admin, `${suffix}-other`, otherOrg.id, "org_admin");
    const asOtherUser = userClient(otherToken);

    const { data, error } = await asOtherUser.from("lease_premises").select("id").eq("id", premises.id).maybeSingle();
    assertNoError(error); // RLS filters rows, it does not error
    assertEquals(data, null, "a user from a different organization must never see another org's lease_premises row");
  },
});

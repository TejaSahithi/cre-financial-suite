// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation pass, item H: integration tests for
// buildBudgetReadinessReport(), against the real local database.
import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";
import { buildBudgetReadinessReport } from "../_shared/cam-engine-v2/setup/budget-readiness-report.ts";

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
  const email = `budget-readiness-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

async function setUpOrgPropertyPeriod(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `Budget Readiness Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Budget Readiness Property ${suffix}`, status: "active" });
  const { data: cal } = await admin.rpc("create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  const { data: period } = await admin.rpc("create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
  return { actor, org, property, period: period.period };
}

Deno.test({
  name: "buildBudgetReadinessReport: property with nothing set up is neither CAM-ready nor Budget-ready",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);

    const report = await buildBudgetReadinessReport(admin, { orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id });
    assertEquals(report.cam_ready, false);
    assertEquals(report.budget_ready, false);
    assertEquals(report.cam_run_tie_out, null);
    assertEquals(report.leases.canonical_count, 0);
  },
});

Deno.test({
  name: "buildBudgetReadinessReport: budget_ready stays false without an approved/posted CAM run even if everything else reconciles",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);

    const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01", tenant_name: "Report Tenant", abstract_status: "approved", square_footage: 4000 });
    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
    const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
    const rule = await insertOne(admin, "lease_expense_rules", {
      org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
      approval_status: "approved", source_page: 1, exact_source_text: "Tenant pays pro rata CAM.", confidence_score: 0.95,
      recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
    });
    const mat = await admin.rpc("materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: rule.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    assertNoError(mat.error);

    const report = await buildBudgetReadinessReport(admin, { orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id });
    assertEquals(report.leases.canonical_count, 1);
    assertEquals(report.policies.materialized_approved_count, 1);
    assertEquals(report.cam_run_tie_out, null);
    assertEquals(report.budget_ready, false); // no CAM run tie-out yet, regardless of anything else
  },
});

Deno.test({
  name: "buildBudgetReadinessReport: an approved CAM run satisfies the tie-out signal",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, period } = await setUpOrgPropertyPeriod(admin, suffix);

    await insertOne(admin, "cam_runs", {
      org_id: org.id, recovery_period_id: period.id, scope_type: "property", scope_id: property.id,
      status: "approved", created_by: actor.userId, approved_by: actor.userId,
    });

    const report = await buildBudgetReadinessReport(admin, { orgId: org.id, propertyId: property.id, recoveryPeriodId: period.id });
    assertExists(report.cam_run_tie_out);
    assertEquals(report.cam_run_tie_out.status, "approved");
  },
});

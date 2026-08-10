// UAT Finding C: evaluate_cam_readiness's POLICY_CONFLICT, PREMISES_MISSING,
// and POOL_CATEGORY_MISSING checks used to filter only by org_id, not
// property_id -- so a genuinely broken lease on one property (two
// conflicting active recovery policies, no premises record) blocked
// readiness for every OTHER property in the same org. Fixed in
// 20269900000056_cam_readiness_property_scope_fix.sql and
// 20269900000057_cam_readiness_pool_category_scope_fix.sql.
//
// This test builds two properties in one org: Property B is deliberately
// broken (two active recovery policies covering the same category with
// overlapping dates, and no lease_premises record at all). Property A is
// fully, correctly set up. Evaluating readiness for Property A must return
// ready=true with zero exceptions naming anything on Property B.
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

async function setUpActor(admin: ReturnType<typeof adminClient>, suffix: string) {
  const email = `cam-readiness-scope-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  return { userId: data.user!.id, email };
}

async function approveRuleAndMaterializePolicy(
  admin: ReturnType<typeof adminClient>,
  actor: { userId: string; email: string },
  orgId: string,
  leaseId: string,
  propertyId: string,
  categoryId: string,
  paymentTreatment: string,
  recoveryMethod: string,
) {
  const rule = await insertOne(admin, "lease_expense_rules", {
    org_id: orgId,
    lease_id: leaseId,
    property_id: propertyId,
    expense_category_id: categoryId,
    expense_category: "common_area_maintenance",
    payment_treatment: paymentTreatment,
    recovery_method: recoveryMethod,
    approval_status: "approved",
    recoverable_from_tenant: "yes",
  });
  const policy = await callRpc(admin, "materialize_lease_recovery_policy", {
    p_org_id: orgId,
    p_rule_id: rule.id,
    p_actor_user_id: actor.userId,
    p_actor_email: actor.email,
  });
  return { rule, policy };
}

Deno.test({
  name: "UAT Finding C: a broken lease on Property B does not block CAM readiness for unrelated Property A",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actor = await setUpActor(admin, suffix);
    const org = await insertOne(admin, "organizations", { name: `CAM Readiness Scope Org ${suffix}`, status: "active" });
    const category = await insertOne(admin, "expense_categories", {
      org_id: org.id,
      category_name: `CAM Readiness Scope Category ${suffix}`,
      normalized_key: `cam_readiness_scope_${suffix}`,
    });

    // --- Property A: fully, correctly set up -------------------------------
    const propertyA = await insertOne(admin, "properties", { org_id: org.id, name: `Readiness Scope Property A ${suffix}`, status: "active" });
    const leaseA = await insertOne(admin, "leases", { org_id: org.id, property_id: propertyA.id, tenant_name: "Tenant A", status: "approved" });
    await approveRuleAndMaterializePolicy(admin, actor, org.id, leaseA.id, propertyA.id, category.id, "reimbursable", "pro_rata_share");
    const premisesA = await insertOne(admin, "lease_premises", {
      org_id: org.id, lease_id: leaseA.id, premises_type: "primary", effective_from: "2026-01-01", status: "approved",
      source_type: "primary", review_status: "not_required",
    });
    await insertOne(admin, "lease_premises_area_periods", {
      org_id: org.id, lease_premises_id: premisesA.id, area_basis: "rentable",
      contractual_area_sqft: 1000, recovery_area_sqft: 1000, effective_from: "2026-01-01",
    });

    const calA = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: propertyA.id, p_name: "Cal A", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const periodA = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: calA.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026 A", p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const poolA = await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: propertyA.id, p_name: "Pool A", p_pool_type: "property", p_scope_type: "property", p_scope_id: propertyA.id, p_is_template: false, p_period_id: periodA.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    await admin.from("recovery_pool_categories").insert({
      org_id: org.id, pool_id: poolA.pool.id, expense_category_id: category.id,
      inclusion_mode: "include", variability_default: "variable", controllability_default: "controllable",
    });

    // --- Property B: deliberately broken ------------------------------------
    const propertyB = await insertOne(admin, "properties", { org_id: org.id, name: `Readiness Scope Property B ${suffix}`, status: "active" });
    const leaseB = await insertOne(admin, "leases", { org_id: org.id, property_id: propertyB.id, tenant_name: "Tenant B", status: "approved" });
    // Two DIFFERENT approved rules on the SAME lease covering the SAME
    // category with overlapping effective windows -- a real POLICY_CONFLICT.
    await approveRuleAndMaterializePolicy(admin, actor, org.id, leaseB.id, propertyB.id, category.id, "reimbursable", "pro_rata_share");
    await approveRuleAndMaterializePolicy(admin, actor, org.id, leaseB.id, propertyB.id, category.id, "reimbursable", "cam_estimate");
    // No lease_premises row for leaseB at all -- a real PREMISES_MISSING.

    // --- Evaluate readiness for Property A only -----------------------------
    const readiness = await callRpc(admin, "evaluate_cam_readiness", {
      p_org_id: org.id,
      p_property_id: propertyA.id,
      p_recovery_period_id: periodA.period.id,
      p_scope_type: "property",
      p_scope_id: propertyA.id,
    });

    const exceptionEntityIds = new Set((readiness.exceptions || []).map((e: { entity_id: string }) => e.entity_id));
    assertEquals(exceptionEntityIds.has(leaseB.id), false, `Property A readiness must not reference Property B's lease: ${JSON.stringify(readiness.exceptions)}`);
    const codes = (readiness.exceptions || []).map((e: { code: string }) => e.code);
    assertEquals(codes.includes("POLICY_CONFLICT"), false, `Property B's policy conflict must not leak into Property A: ${JSON.stringify(readiness.exceptions)}`);
    assertEquals(codes.includes("PREMISES_MISSING"), false, `Property B's missing premises must not leak into Property A: ${JSON.stringify(readiness.exceptions)}`);
    assertEquals(readiness.ready, true, `expected Property A to be ready, got exceptions: ${JSON.stringify(readiness.exceptions)}`);

    // --- Sanity check: Property B's OWN readiness DOES see its own issues ---
    const calB = await callRpc(admin, "create_recovery_calendar", { p_org_id: org.id, p_property_id: propertyB.id, p_name: "Cal B", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const periodB = await callRpc(admin, "create_recovery_period", { p_org_id: org.id, p_calendar_id: calB.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026 B", p_actor_user_id: actor.userId, p_actor_email: actor.email });
    await callRpc(admin, "create_recovery_pool", { p_org_id: org.id, p_property_id: propertyB.id, p_name: "Pool B", p_pool_type: "property", p_scope_type: "property", p_scope_id: propertyB.id, p_is_template: false, p_period_id: periodB.period.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });

    const readinessB = await callRpc(admin, "evaluate_cam_readiness", {
      p_org_id: org.id,
      p_property_id: propertyB.id,
      p_recovery_period_id: periodB.period.id,
      p_scope_type: "property",
      p_scope_id: propertyB.id,
    });
    const codesB = (readinessB.exceptions || []).map((e: { code: string }) => e.code);
    assertEquals(codesB.includes("POLICY_CONFLICT"), true, "Property B's own readiness must still see its own policy conflict");
    assertEquals(codesB.includes("PREMISES_MISSING"), true, "Property B's own readiness must still see its own missing premises");
    assertEquals(readinessB.ready, false, "Property B must not be ready given its own real problems");
  },
});

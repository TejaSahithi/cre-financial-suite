// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation pass, item G: integration tests for
// resolve_cam_policy_conflict, against the real local database.
import { assertEquals, assertExists, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
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
  const email = `cam-conflict-actor-${suffix}@example.test`;
  const { data, error } = await admin.auth.admin.createUser({ email, password: `Pass-${suffix}!`, email_confirm: true });
  assertNoError(error);
  const userId = data.user?.id;
  assertExists(userId);
  return { userId, email };
}

/** Two approved rules on the SAME lease + SAME category, both materialized -- a real POLICY_CONFLICT. */
async function setUpConflictingPolicies(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actor = await createActor(admin, suffix);
  const org = await insertOne(admin, "organizations", { name: `Conflict Org ${suffix}`, status: "active" });
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Conflict Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", { org_id: org.id, property_id: property.id, commencement_date: "2026-01-01", tenant_name: "Conflict Tenant" });
  const ruleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: org.id, lease_id: lease.id });
  const category = await insertOne(admin, "expense_categories", { org_id: org.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });

  const ruleA = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
    approval_status: "approved", source_page: 1, exact_source_text: "Version A: tenant pays 100%.", confidence_score: 0.9,
    recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
  });
  const ruleB = await insertOne(admin, "lease_expense_rules", {
    org_id: org.id, rule_set_id: ruleSet.id, expense_category_id: category.id, lease_id: lease.id, property_id: property.id,
    approval_status: "approved", source_page: 2, exact_source_text: "Version B: tenant pays 50%, capped.", confidence_score: 0.9,
    recovery_method: "fixed_amount", allocation_basis: "rentable_area",
  });

  const matA = await admin.rpc("materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: ruleA.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(matA.error);
  const matB = await admin.rpc("materialize_lease_recovery_policy", { p_org_id: org.id, p_rule_id: ruleB.id, p_actor_user_id: actor.userId, p_actor_email: actor.email });
  assertNoError(matB.error);

  return { actor, org, property, lease, category, policyAId: matA.data.policy.id, policyBId: matB.data.policy.id };
}

Deno.test({
  name: "resolve_cam_policy_conflict: supersedes the chosen policy, keeps the other active, and is audited",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, property, policyAId, policyBId } = await setUpConflictingPolicies(admin, suffix);

    // Sanity: evaluate_cam_readiness actually flags this as POLICY_CONFLICT
    // before we resolve it (proves the fixture reproduces the real exception).
    const cal = await admin.rpc("create_recovery_calendar", { p_org_id: org.id, p_property_id: property.id, p_name: "Cal", p_calendar_type: "calendar_year", p_fiscal_start_month: 1, p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const period = await admin.rpc("create_recovery_period", { p_org_id: org.id, p_calendar_id: cal.data.calendar.id, p_start_date: "2026-01-01", p_end_date: "2026-12-31", p_label: "FY2026", p_actor_user_id: actor.userId, p_actor_email: actor.email });
    const readiness = await admin.rpc("evaluate_cam_readiness", {
      p_org_id: org.id, p_property_id: property.id, p_recovery_period_id: period.data.period.id, p_scope_type: "property", p_scope_id: property.id,
    });
    assertNoError(readiness.error);
    const exceptions = readiness.data.exceptions as any[];
    assertEquals(exceptions.some((e) => e.code === "POLICY_CONFLICT"), true);

    // Resolve: supersede policy A, keep policy B.
    const { data: result, error } = await admin.rpc("resolve_cam_policy_conflict", {
      p_org_id: org.id, p_policy_id_to_supersede: policyAId, p_reason: "Lease amendment version B is the fully executed, authoritative copy.",
      p_actor_user_id: actor.userId, p_actor_email: actor.email,
    });
    assertNoError(error);
    assertEquals(result.superseded_policy_id, policyAId);
    assertEquals(result.kept_active_policy_id, policyBId);
    assertExists(result.audit_log_id);

    const { data: polA } = await admin.from("lease_recovery_policies").select("status").eq("id", policyAId).single();
    assertEquals(polA!.status, "superseded");
    const { data: polB } = await admin.from("lease_recovery_policies").select("status").eq("id", policyBId).single();
    assertEquals(polB!.status, "approved"); // untouched

    const { data: auditRow } = await admin.from("audit_logs").select("*").eq("id", result.audit_log_id).single();
    assertEquals(auditRow!.action, "cam_policy_conflict_resolved");

    // Rerun readiness: the conflict is gone now that only one active policy remains.
    const readinessAfter = await admin.rpc("evaluate_cam_readiness", {
      p_org_id: org.id, p_property_id: property.id, p_recovery_period_id: period.data.period.id, p_scope_type: "property", p_scope_id: property.id,
    });
    assertNoError(readinessAfter.error);
    assertEquals((readinessAfter.data.exceptions as any[]).some((e) => e.code === "POLICY_CONFLICT"), false);
  },
});

Deno.test({
  name: "resolve_cam_policy_conflict: rejects a reason-less call and a policy that is not actually in conflict",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { actor, org, policyAId } = await setUpConflictingPolicies(admin, suffix);

    await assertRejects(async () => {
      const { error } = await admin.rpc("resolve_cam_policy_conflict", {
        p_org_id: org.id, p_policy_id_to_supersede: policyAId, p_reason: "",
        p_actor_user_id: actor.userId, p_actor_email: actor.email,
      });
      if (error) throw new Error(error.message);
    });

    // A lone, non-conflicting policy must be refused -- this RPC is not a
    // general-purpose "supersede any policy" tool.
    const soloOrg = await insertOne(admin, "organizations", { name: `Solo Org ${suffix}`, status: "active" });
    const soloProperty = await insertOne(admin, "properties", { org_id: soloOrg.id, name: `Solo Property ${suffix}`, status: "active" });
    const soloLease = await insertOne(admin, "leases", { org_id: soloOrg.id, property_id: soloProperty.id, commencement_date: "2026-01-01" });
    const soloRuleSet = await insertOne(admin, "lease_expense_rule_sets", { org_id: soloOrg.id, lease_id: soloLease.id });
    const soloCategory = await insertOne(admin, "expense_categories", { org_id: soloOrg.id, category_name: `Cat ${crypto.randomUUID()}`, normalized_key: `cat_${crypto.randomUUID()}` });
    const soloRule = await insertOne(admin, "lease_expense_rules", {
      org_id: soloOrg.id, rule_set_id: soloRuleSet.id, expense_category_id: soloCategory.id, lease_id: soloLease.id, property_id: soloProperty.id,
      approval_status: "approved", source_page: 1, exact_source_text: "Solo rule.", confidence_score: 0.9,
      recovery_method: "pro_rata_share", allocation_basis: "rentable_area",
    });
    const soloActor = await createActor(admin, `${suffix}-solo`);
    const soloMat = await admin.rpc("materialize_lease_recovery_policy", { p_org_id: soloOrg.id, p_rule_id: soloRule.id, p_actor_user_id: soloActor.userId, p_actor_email: soloActor.email });
    assertNoError(soloMat.error);

    await assertRejects(async () => {
      const { error } = await admin.rpc("resolve_cam_policy_conflict", {
        p_org_id: soloOrg.id, p_policy_id_to_supersede: soloMat.data.policy.id, p_reason: "Trying to supersede a non-conflicting policy.",
        p_actor_user_id: soloActor.userId, p_actor_email: soloActor.email,
      });
      if (error) throw new Error(error.message);
    });
  },
});

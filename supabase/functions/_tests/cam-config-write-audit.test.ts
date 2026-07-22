// Feature: enterprise-readiness-hardening Phase 3
// Property: property_config / lease_config writes are server-side validated
// and each write produces exactly one audit_logs row, closing the gap where
// these were direct, unvalidated, unaudited client upserts.
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

Deno.test({
  name: "HTTP save-property-cam-config / save-lease-config: server validation + one audit row per write",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actorEmail = `cam-config-audit-${suffix}@example.test`;
    const password = `Pass-${suffix}!`;

    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email: actorEmail,
      password,
      email_confirm: true,
    });
    assertNoError(userError);
    const actorUserId = userData.user?.id;
    assertExists(actorUserId);

    const org = await insertOne(admin, "organizations", {
      name: `CAM Config Audit Org ${suffix}`,
      status: "active",
      primary_contact_email: actorEmail,
    });

    await admin.from("profiles").upsert({
      id: actorUserId,
      email: actorEmail,
      full_name: "CAM Config Audit Tester",
      role: "org_admin",
      status: "active",
    });

    await insertOne(admin, "memberships", {
      user_id: actorUserId,
      org_id: org.id,
      role: "org_admin",
    });

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `CAM Config Audit Property ${suffix}`,
      status: "active",
    });

    const tenant = await insertOne(admin, "tenants", {
      org_id: org.id,
      name: `Tenant ${suffix}`,
      email: `tenant-${actorEmail}`,
      status: "active",
    });

    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      start_date: "2026-01-01",
      end_date: "2026-12-31",
      status: "pending",
      abstract_version: 0,
    });

    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
      email: actorEmail,
      password,
    });
    assertNoError(signInError);
    const accessToken = signInData.session?.access_token;
    assertExists(accessToken);

    const callFn = (fnName: string, body: Record<string, unknown>) =>
      fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
          "apikey": ANON_KEY,
        },
        body: JSON.stringify(body),
      });

    // --- valid property config save ---
    const propRes = await callFn("save-property-cam-config", {
      property_id: property.id,
      cam_calculation_method: "pro_rata",
      expense_recovery_method: "base_year",
      fiscal_year_start: 1,
      config_values: { admin_fee_pct: 5, management_fee_pct: 3 },
    });
    const propBody = await propRes.json();
    assertEquals(propRes.status, 200, `expected success: ${JSON.stringify(propBody)}`);
    assertEquals(propBody.error, false);
    assertExists(propBody.audit_log_id);

    // --- invalid property config save: out-of-range percentage rejected ---
    const propBadRes = await callFn("save-property-cam-config", {
      property_id: property.id,
      cam_calculation_method: "pro_rata",
      expense_recovery_method: "base_year",
      fiscal_year_start: 1,
      config_values: { admin_fee_pct: 500 },
    });
    const propBadBody = await propBadRes.json();
    assertEquals(propBadRes.status, 400, `expected rejection: ${JSON.stringify(propBadBody)}`);
    assertEquals(propBadBody.error, true);

    const { data: propConfigRows, error: propConfigError } = await admin
      .from("property_config")
      .select("*")
      .eq("property_id", property.id);
    assertNoError(propConfigError);
    assertEquals(propConfigRows?.length, 1, "exactly one property_config row (upsert, not duplicated by the rejected call)");

    const { data: propAuditRows, error: propAuditError } = await admin
      .from("audit_logs")
      .select("*")
      .eq("entity_type", "PropertyConfig")
      .eq("entity_id", property.id);
    assertNoError(propAuditError);
    assertEquals(propAuditRows?.length, 1, "exactly one audit_logs row (the rejected call must not log a successful save)");

    // --- valid lease config save ---
    const leaseRes = await callFn("save-lease-config", {
      lease_id: lease.id,
      base_year: 2026,
      excluded_expenses: ["capital_expenditures"],
      config_values: { cam_cap_rate: 5, weight_factor: 0.5 },
    });
    const leaseBody = await leaseRes.json();
    assertEquals(leaseRes.status, 200, `expected success: ${JSON.stringify(leaseBody)}`);
    assertEquals(leaseBody.error, false);
    assertExists(leaseBody.audit_log_id);

    // --- invalid lease config save: weight_factor out of [0,1] rejected ---
    const leaseBadRes = await callFn("save-lease-config", {
      lease_id: lease.id,
      config_values: { weight_factor: 3.5 },
    });
    const leaseBadBody = await leaseBadRes.json();
    assertEquals(leaseBadRes.status, 400, `expected rejection: ${JSON.stringify(leaseBadBody)}`);
    assertEquals(leaseBadBody.error, true);

    const { data: leaseConfigRows, error: leaseConfigError } = await admin
      .from("lease_config")
      .select("*")
      .eq("lease_id", lease.id);
    assertNoError(leaseConfigError);
    assertEquals(leaseConfigRows?.length, 1, "exactly one lease_config row");

    const { data: leaseAuditRows, error: leaseAuditError } = await admin
      .from("audit_logs")
      .select("*")
      .eq("entity_type", "LeaseConfig")
      .eq("entity_id", lease.id);
    assertNoError(leaseAuditError);
    assertEquals(leaseAuditRows?.length, 1, "exactly one audit_logs row for lease_config");
  },
});

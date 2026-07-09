// Feature: enterprise-readiness-hardening Phase 6R-13 (link_lease_space_assignment).
// Properties:
//   1. Succeeds for a valid building/unit in the same org/property, exactly
//      one canonical audit row, changed=true.
//   2. Rejects a cross-org building, no side effects.
//   3. Rejects a cross-org unit, no side effects.
//   4. Rejects a unit whose building_id does not match the resolved
//      building (property/building mismatch case), no side effects.
//   5. A second, idempotent call with the same building/unit is a safe
//      no-op: changed=false, no additional audit row.
//   6. A user without write access is blocked, zero side effects.
//   7. An unknown lease_id is rejected, zero side effects.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

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
  const email = `link-lease-space-${suffix}@example.test`;
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
    full_name: "Link Lease Space Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { userId, email, accessToken };
}

function callLinkFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/link-lease-space-assignment`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Link Lease Space Org ${suffix}`,
    status: "active",
  });

  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Link Lease Space Property ${suffix}`,
    status: "active",
  });

  const building = await insertOne(admin, "buildings", {
    org_id: org.id,
    property_id: property.id,
    name: `Building ${suffix}`,
  });

  const unit = await insertOne(admin, "units", {
    org_id: org.id,
    property_id: property.id,
    building_id: building.id,
    unit_number: `Unit ${suffix}`,
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Link Lease Space Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
  });

  return { org, accessToken, property, building, unit, lease };
}

Deno.test({
  name: "link_lease_space_assignment: succeeds for a matching building+unit, exactly one audit row, changed=true",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, building, unit, lease } = await setUpScope(admin, suffix);

    const res = await callLinkFn(accessToken, {
      lease_id: lease.id,
      building_id: building.id,
      unit_id: unit.id,
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(body.building_id, building.id);
    assertEquals(body.unit_id, unit.id);
    assertExists(body.audit_log_id);

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("building_id, unit_id")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.building_id, building.id);
    assertEquals(leaseAfter.unit_id, unit.id);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_space_assignment_linked");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "must write exactly one audit row for a real change");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
    assertEquals((auditRows![0].metadata as Record<string, unknown>).building_id, building.id);
  },
});

Deno.test({
  name: "link_lease_space_assignment: rejects a cross-org building, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Link Lease Space Other Org ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property ${suffix}`,
      status: "active",
    });
    const otherBuilding = await insertOne(admin, "buildings", {
      org_id: otherOrg.id,
      property_id: otherProperty.id,
      name: `Other Building ${suffix}`,
    });

    const res = await callLinkFn(accessToken, {
      lease_id: lease.id,
      building_id: otherBuilding.id,
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org building to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("building_id").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.building_id, null, "the lease must be unchanged");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_space_assignment_linked");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a rejected attempt must not write any audit row");
  },
});

Deno.test({
  name: "link_lease_space_assignment: rejects a cross-org unit, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", {
      name: `Link Lease Space Other Org2 ${suffix}`,
      status: "active",
    });
    const otherProperty = await insertOne(admin, "properties", {
      org_id: otherOrg.id,
      name: `Other Property2 ${suffix}`,
      status: "active",
    });
    const otherUnit = await insertOne(admin, "units", {
      org_id: otherOrg.id,
      property_id: otherProperty.id,
      unit_number: `Other Unit ${suffix}`,
    });

    const res = await callLinkFn(accessToken, {
      lease_id: lease.id,
      unit_id: otherUnit.id,
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org unit to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("unit_id").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.unit_id, null, "the lease must be unchanged");
  },
});

Deno.test({
  name: "link_lease_space_assignment: rejects a unit whose building does not match the resolved building",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, property, lease } = await setUpScope(admin, suffix);

    const buildingA = await insertOne(admin, "buildings", {
      org_id: org.id,
      property_id: property.id,
      name: `Building A ${suffix}`,
    });
    const buildingB = await insertOne(admin, "buildings", {
      org_id: org.id,
      property_id: property.id,
      name: `Building B ${suffix}`,
    });
    const unitInB = await insertOne(admin, "units", {
      org_id: org.id,
      property_id: property.id,
      building_id: buildingB.id,
      unit_number: `Unit In B ${suffix}`,
    });

    const res = await callLinkFn(accessToken, {
      lease_id: lease.id,
      building_id: buildingA.id,
      unit_id: unitInB.id,
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a building/unit mismatch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("building_id, unit_id").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.building_id, null);
    assertEquals(leaseAfter.unit_id, null);
  },
});

Deno.test({
  name: "link_lease_space_assignment: idempotent replay is a safe no-op, changed=false, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, building, unit, lease } = await setUpScope(admin, suffix);

    const firstRes = await callLinkFn(accessToken, {
      lease_id: lease.id,
      building_id: building.id,
      unit_id: unit.id,
    });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callLinkFn(accessToken, {
      lease_id: lease.id,
      building_id: building.id,
      unit_id: unit.id,
    });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay with identical values must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_space_assignment_linked");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "link_lease_space_assignment: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, building, unit, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callLinkFn(viewerToken, {
      lease_id: lease.id,
      building_id: building.id,
      unit_id: unit.id,
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: leaseAfter } = await admin.from("leases").select("building_id, unit_id").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.building_id, null);
    assertEquals(leaseAfter.unit_id, null);
  },
});

Deno.test({
  name: "link_lease_space_assignment: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, building } = await setUpScope(admin, suffix);

    const res = await callLinkFn(accessToken, {
      lease_id: crypto.randomUUID(),
      building_id: building.id,
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

// Feature: enterprise-readiness-hardening Phase 6CAM-1 (save_cam_profile /
// approve_cam_profile). Server-owns CAMSetup.jsx's saveMutation and
// approveMutation.
// Properties:
//   1. A valid save succeeds, exactly one canonical audit row.
//   2. A valid approval succeeds, exactly one canonical audit row, and
//      approved_by is set to the actor's email (closing the previously-
//      always-null gap).
//   3. A cross-org profile_id is rejected for both save and approve.
//   4. A user without write access is blocked for both actions.
//   5. Idempotent save replay (identical patch) is a safe no-op.
//   6. Idempotent approval replay (same actor) is a safe no-op.
//   7. Approval is rejected when building_rsf is missing (manual_required),
//      mirroring the client's own eligibility gate, re-derived server-side.
//   8. An unrecognized field in the save patch is rejected.
//   9. An invalid enum value (status/cam_cap_type/frequencies) is rejected.
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
  const email = `cam-profile-workflows-${suffix}@example.test`;
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
    full_name: "CAM Profile Workflows Tester",
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

function callSaveFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/save-cam-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

function callApproveFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/approve-cam-profile`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string, overrides: Record<string, unknown> = {}) {
  const org = await insertOne(admin, "organizations", {
    name: `CAM Profile Workflows Org ${suffix}`,
    status: "active",
  });

  const { accessToken, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `CAM Profile Workflows Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
  });

  const profile = await insertOne(admin, "cam_profiles", {
    org_id: org.id,
    lease_id: lease.id,
    property_id: property.id,
    status: "draft",
    building_rsf: 10000,
    tenant_rsf: 1000,
    tenant_pro_rata_share: 10,
    ...overrides,
  });

  return { org, accessToken, actorEmail: email, property, lease, profile };
}

Deno.test({
  name: "save_cam_profile: valid save succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, profile } = await setUpScope(admin, suffix);

    const res = await callSaveFn(accessToken, {
      profile_id: profile.id,
      patch: { cam_structure: "NNN", tenant_rsf: 1500, admin_fee_percent: 5 },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(body.profile.cam_structure, "NNN");
    assertEquals(Number(body.profile.tenant_rsf), 1500);
    assertExists(body.audit_log_id);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "CamProfile")
      .eq("entity_id", profile.id)
      .eq("action", "cam_profile_saved");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row for a real save");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "approve_cam_profile: valid approval succeeds, exactly one audit row, approved_by set to actor email",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, actorEmail, profile } = await setUpScope(admin, suffix);

    const res = await callApproveFn(accessToken, { profile_id: profile.id });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.changed, true);
    assertEquals(body.profile.status, "approved");
    assertEquals(body.profile.approved_by, actorEmail, "approved_by must be set to the actor's email, not null");
    assertExists(body.profile.approved_at);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "CamProfile")
      .eq("entity_id", profile.id)
      .eq("action", "cam_profile_approved");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "exactly one audit row for a real approval");
  },
});

Deno.test({
  name: "save_cam_profile: cross-org profile_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", { name: `Other Org ${suffix}`, status: "active" });
    const otherProperty = await insertOne(admin, "properties", { org_id: otherOrg.id, name: `Other Property ${suffix}`, status: "active" });
    const otherLease = await insertOne(admin, "leases", { org_id: otherOrg.id, property_id: otherProperty.id });
    const otherProfile = await insertOne(admin, "cam_profiles", {
      org_id: otherOrg.id, lease_id: otherLease.id, property_id: otherProperty.id, status: "draft",
    });

    const res = await callSaveFn(accessToken, {
      profile_id: otherProfile.id,
      patch: { cam_structure: "hijacked" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org profile_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: after } = await admin.from("cam_profiles").select("cam_structure").eq("id", otherProfile.id).single();
    assertEquals(after?.cam_structure, null, "the other org's profile must be unchanged");
  },
});

Deno.test({
  name: "approve_cam_profile: cross-org profile_id is rejected, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", { name: `Other Org Approve ${suffix}`, status: "active" });
    const otherProperty = await insertOne(admin, "properties", { org_id: otherOrg.id, name: `Other Property Approve ${suffix}`, status: "active" });
    const otherLease = await insertOne(admin, "leases", { org_id: otherOrg.id, property_id: otherProperty.id });
    const otherProfile = await insertOne(admin, "cam_profiles", {
      org_id: otherOrg.id, lease_id: otherLease.id, property_id: otherProperty.id, status: "draft",
      building_rsf: 10000, tenant_rsf: 1000, tenant_pro_rata_share: 10,
    });

    const res = await callApproveFn(accessToken, { profile_id: otherProfile.id });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-org profile_id to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: after } = await admin.from("cam_profiles").select("status").eq("id", otherProfile.id).single();
    assertEquals(after?.status, "draft", "the other org's profile must be unchanged");
  },
});

Deno.test({
  name: "save_cam_profile and approve_cam_profile: user without write access is blocked, zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, profile } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const saveRes = await callSaveFn(viewerToken, { profile_id: profile.id, patch: { cam_structure: "blocked" } });
    const saveBody = await saveRes.json();
    assertEquals(saveBody.error, true, `expected viewer save to be blocked: ${JSON.stringify(saveBody)}`);
    assertEquals([401, 403].includes(saveRes.status), true, `expected 401/403, got ${saveRes.status}`);

    const approveRes = await callApproveFn(viewerToken, { profile_id: profile.id });
    const approveBody = await approveRes.json();
    assertEquals(approveBody.error, true, `expected viewer approve to be blocked: ${JSON.stringify(approveBody)}`);
    assertEquals([401, 403].includes(approveRes.status), true, `expected 401/403, got ${approveRes.status}`);

    const { data: after } = await admin.from("cam_profiles").select("cam_structure, status").eq("id", profile.id).single();
    assertEquals(after?.cam_structure, null);
    assertEquals(after?.status, "draft");
  },
});

Deno.test({
  name: "save_cam_profile: idempotent replay (identical patch) is a safe no-op, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, profile } = await setUpScope(admin, suffix);
    const patch = { cam_structure: "NNN", admin_fee_percent: 3 };

    const firstRes = await callSaveFn(accessToken, { profile_id: profile.id, patch });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callSaveFn(accessToken, { profile_id: profile.id, patch });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay with an identical patch must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "CamProfile")
      .eq("entity_id", profile.id)
      .eq("action", "cam_profile_saved");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "approve_cam_profile: idempotent replay (same actor) is a safe no-op, no additional audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, profile } = await setUpScope(admin, suffix);

    const firstRes = await callApproveFn(accessToken, { profile_id: profile.id });
    const firstBody = await firstRes.json();
    assertEquals(firstRes.status, 200, JSON.stringify(firstBody));
    assertEquals(firstBody.changed, true);

    const secondRes = await callApproveFn(accessToken, { profile_id: profile.id });
    const secondBody = await secondRes.json();
    assertEquals(secondRes.status, 200, JSON.stringify(secondBody));
    assertEquals(secondBody.changed, false, "a replay by the same actor on an already-approved profile must be a no-op");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "CamProfile")
      .eq("entity_id", profile.id)
      .eq("action", "cam_profile_approved");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "the idempotent replay must not write a second audit row");
  },
});

Deno.test({
  name: "approve_cam_profile: rejected when building_rsf is missing (manual_required), zero side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, profile } = await setUpScope(admin, suffix, { building_rsf: null });

    const res = await callApproveFn(accessToken, { profile_id: profile.id });
    const body = await res.json();
    assertEquals(body.error, true, "expected approval to be rejected when building_rsf is missing");
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/building rsf/i.test(body.message || ""), true, `expected a building RSF message: ${JSON.stringify(body)}`);

    const { data: after } = await admin.from("cam_profiles").select("status").eq("id", profile.id).single();
    assertEquals(after?.status, "draft", "the rejected approval must not change the row");
  },
});

Deno.test({
  name: "save_cam_profile: an unrecognized field is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, profile } = await setUpScope(admin, suffix);

    const res = await callSaveFn(accessToken, {
      profile_id: profile.id,
      patch: { cam_structure: "NNN", approved_by: "sneaky@example.test" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unrecognized field to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

Deno.test({
  name: "save_cam_profile: an invalid enum value is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, profile } = await setUpScope(admin, suffix);

    const res = await callSaveFn(accessToken, {
      profile_id: profile.id,
      patch: { status: "not_a_real_status" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an invalid status value to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: after } = await admin.from("cam_profiles").select("status").eq("id", profile.id).single();
    assertEquals(after?.status, "draft", "the rejected save must not change the row");
  },
});

import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || "http://127.0.0.1:54321";
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error("Phase 5D direct RPC auth test requires SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY");
}

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function userClient(accessToken) {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

async function assertNoError(error, label) {
  if (error) throw new Error(`${label}: ${error.message || JSON.stringify(error)}`);
}

async function insertOne(client, table, values) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  await assertNoError(error, `insert ${table}`);
  expect(data?.id).toBeTruthy();
  return data;
}

async function createOrgUser(admin, { suffix, orgId }) {
  const email = `phase5d-rpc-${suffix}@example.test`;
  const password = `Phase5dRpc-${suffix}!Aa1`;
  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  await assertNoError(userError, "create user");
  const userId = userData.user?.id;
  expect(userId).toBeTruthy();

  await admin.from("profiles").upsert({
    id: userId,
    email,
    full_name: "Phase 5D Direct RPC User",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role: "org_admin",
    status: "active",
    page_permissions: {
      LeaseUpload: "admin",
      LeaseReview: "admin",
      Leases: "admin",
    },
    module_permissions: {},
    capabilities: {},
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  await assertNoError(signInError, "sign in user");
  const accessToken = signInData.session?.access_token;
  expect(accessToken).toBeTruthy();

  return { userId, email, accessToken };
}

async function createFixture(admin) {
  const suffix = crypto.randomUUID();
  const orgA = await insertOne(admin, "organizations", {
    name: `Phase 5D RPC Org A ${suffix}`,
    status: "active",
  });
  const orgB = await insertOne(admin, "organizations", {
    name: `Phase 5D RPC Org B ${suffix}`,
    status: "active",
  });

  const userA = await createOrgUser(admin, { suffix: `${suffix}-a`, orgId: orgA.id });
  const userB = await createOrgUser(admin, { suffix: `${suffix}-b`, orgId: orgB.id });

  const propertyA = await insertOne(admin, "properties", {
    org_id: orgA.id,
    name: `Phase 5D RPC Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: orgA.id,
    property_id: propertyA.id,
    tenant_name: `Phase 5D RPC Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
    abstract_status: "draft",
    source_file_id: null,
    extraction_data: { fields: { tenant_name: { value: "Phase 5D RPC Tenant" } } },
  });

  const uploadA = await insertOne(admin, "uploaded_files", {
    org_id: orgA.id,
    module_type: "leases",
    file_name: `phase5d-rpc-a-${suffix}.pdf`,
    file_url: `local://phase5d-rpc/${suffix}/a.pdf`,
    file_size: 1024,
    mime_type: "application/pdf",
    uploaded_by: userA.userId,
    status: "completed",
    processing_status: "completed",
    review_required: false,
    review_status: "not_required",
  });

  const uploadB = await insertOne(admin, "uploaded_files", {
    org_id: orgB.id,
    module_type: "leases",
    file_name: `phase5d-rpc-b-${suffix}.pdf`,
    file_url: `local://phase5d-rpc/${suffix}/b.pdf`,
    file_size: 1024,
    mime_type: "application/pdf",
    uploaded_by: userB.userId,
    status: "completed",
    processing_status: "completed",
    review_required: false,
    review_status: "not_required",
  });

  return { orgA, orgB, userA, userB, lease, uploadA, uploadB };
}

async function directRpcAttempt({ accessToken, orgId, leaseId, actor, upload }) {
  const { data, error } = await userClient(accessToken).rpc("update_lease_extraction_field", {
    p_org_id: orgId,
    p_lease_id: leaseId,
    p_actor_user_id: actor.userId,
    p_actor_email: actor.email,
    p_field_area: "source_link",
    p_action: "source_file_manually_linked",
    p_field_key: null,
    p_patch: {
      source_file_id: upload.id,
      source_file_name: upload.file_name,
      manually_linked_at: new Date().toISOString(),
    },
  });

  return { data, error };
}

async function readLease(admin, leaseId) {
  const { data, error } = await admin
    .from("leases")
    .select("id, source_file_id, extraction_data")
    .eq("id", leaseId)
    .single();
  await assertNoError(error, "read lease");
  return data;
}

async function readSourceAuditRows(admin, leaseId) {
  const { data, error } = await admin
    .from("audit_logs")
    .select("id, action")
    .eq("entity_type", "Lease")
    .eq("entity_id", leaseId)
    .eq("action", "source_file_manually_linked");
  await assertNoError(error, "read audit rows");
  return data || [];
}

describe("Phase 5D direct RPC authorization", () => {
  it("blocks authenticated browser callers from direct update_lease_extraction_field source-link mutation", async () => {
    const admin = adminClient();
    const fixture = await createFixture(admin);

    const attempts = [
      await directRpcAttempt({
        accessToken: fixture.userA.accessToken,
        orgId: fixture.orgA.id,
        leaseId: fixture.lease.id,
        actor: fixture.userA,
        upload: fixture.uploadA,
      }),
      await directRpcAttempt({
        accessToken: fixture.userA.accessToken,
        orgId: fixture.orgA.id,
        leaseId: fixture.lease.id,
        actor: fixture.userA,
        upload: fixture.uploadB,
      }),
      await directRpcAttempt({
        accessToken: fixture.userB.accessToken,
        orgId: fixture.orgA.id,
        leaseId: fixture.lease.id,
        actor: fixture.userB,
        upload: fixture.uploadA,
      }),
    ];

    for (const attempt of attempts) {
      expect(attempt.data).toBeNull();
      expect(attempt.error, "direct RPC call should be rejected").toBeTruthy();
      expect(String(attempt.error?.message || "")).toMatch(/permission denied|not allowed|not permitted|401|403/i);
    }

    const leaseAfter = await readLease(admin, fixture.lease.id);
    expect(leaseAfter.source_file_id).toBeNull();
    expect(leaseAfter.extraction_data?.source_file_id ?? null).toBeNull();

    const auditRows = await readSourceAuditRows(admin, fixture.lease.id);
    expect(auditRows).toHaveLength(0);
  });
});

// Feature: PRE-AZ-HOTFIX-1 (restrict direct execution of approve_lease_workflow
// and delete_lease_cascade). Properties:
//   1-2. Direct authenticated/anon supabase.rpc('approve_lease_workflow', ...)
//        calls are rejected with a permission-denied error -- the grant no
//        longer includes anon/authenticated, only service_role.
//   3-4. Direct authenticated/anon supabase.rpc('delete_lease_cascade', ...)
//        calls are rejected the same way.
//   5. approve-lease-workflow's own service-role RPC path is unaffected
//      (covered by the existing finance-chain-integration.test.ts /
//      lease-approval-*.property.test.ts suites, re-run alongside this file
//      as the regression proof).
//   6. delete-lease-cascade edge function succeeds for an authorized
//      same-org user with Leases write access, and the lease + its cascade
//      children are actually gone afterward.
//   7. delete-lease-cascade rejects a cross-org lease_id (the caller's org
//      does not own the target lease), no side effects.
//   8. delete-lease-cascade rejects a user with no write access anywhere
//      (viewer role), no side effects.
//   9-10 (PRE-AZ-HOTFIX-1A). Confirmed via direct code inspection that lease
//      deletion is reachable only from Leases.jsx -- delete-lease-cascade's
//      page-access assertion was narrowed from
//      ['Leases','LeaseUpload','LeaseReview'] to ['Leases'] only. These two
//      tests prove a user who has write access to LeaseUpload or
//      LeaseReview specifically, but NOT to Leases, is still rejected --
//      i.e. that the narrowing actually took effect and isn't accidentally
//      satisfied by the broader multi-page check.
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

function anonClient() {
  return createClient(SUPABASE_URL, ANON_KEY, {
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

async function createOrgUser(
  admin: ReturnType<typeof adminClient>,
  suffix: string,
  orgId: string,
  role: string,
  pagePermissions: Record<string, string> | null = null,
) {
  const email = `restrict-flagship-rpcs-${suffix}@example.test`;
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
    full_name: "Restrict Flagship RPCs Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: userId,
    org_id: orgId,
    role,
    ...(pagePermissions ? { page_permissions: pagePermissions } : {}),
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  const asUser = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });

  return { userId, email, accessToken, asUser };
}

function callDeleteLeaseCascade(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/delete-lease-cascade`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

function assertPermissionDenied(error: unknown) {
  const message = String((error as any)?.message || error || "").toLowerCase();
  const code = String((error as any)?.code || "");
  const permissionDenied = code === "42501" || message.includes("permission denied");
  if (!permissionDenied) {
    throw new Error(`Expected a permission-denied error, got: ${JSON.stringify(error)}`);
  }
}

Deno.test({
  name: "approve_lease_workflow: direct authenticated RPC call is rejected (grant revoked)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", { name: `Restrict RPC Org ${suffix}`, status: "active" });
    const { asUser } = await createOrgUser(admin, suffix, org.id, "org_admin");

    const { error } = await asUser.rpc("approve_lease_workflow", {
      p_org_id: org.id,
      p_lease_id: crypto.randomUUID(),
      p_actor_user_id: crypto.randomUUID(),
      p_actor_email: "attacker@example.test",
      p_signed_by: "Attacker",
      p_signed_at: new Date().toISOString(),
      p_approval_comments: null,
      p_approval_document_url: null,
      p_field_reviews: {},
      p_abstract_snapshot: {},
      p_critical_dates: [],
      p_idempotency_key: `attack-${suffix}`,
      p_request_payload: {},
    });

    assertExists(error, "direct authenticated RPC call must be rejected");
    assertPermissionDenied(error);
  },
});

Deno.test({
  name: "approve_lease_workflow: direct anon RPC call is rejected (grant revoked)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const anon = anonClient();
    const { error } = await anon.rpc("approve_lease_workflow", {
      p_org_id: crypto.randomUUID(),
      p_lease_id: crypto.randomUUID(),
      p_actor_user_id: crypto.randomUUID(),
      p_actor_email: "anon-attacker@example.test",
      p_signed_by: "Anon Attacker",
      p_signed_at: new Date().toISOString(),
      p_approval_comments: null,
      p_approval_document_url: null,
      p_field_reviews: {},
      p_abstract_snapshot: {},
      p_critical_dates: [],
      p_idempotency_key: `anon-attack-${crypto.randomUUID()}`,
      p_request_payload: {},
    });

    assertExists(error, "direct anon RPC call must be rejected");
    assertPermissionDenied(error);
  },
});

Deno.test({
  name: "delete_lease_cascade: direct authenticated RPC call is rejected (grant revoked)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", { name: `Restrict RPC Org ${suffix}`, status: "active" });
    const { asUser } = await createOrgUser(admin, suffix, org.id, "org_admin");

    const { error } = await asUser.rpc("delete_lease_cascade", {
      target_lease_id: crypto.randomUUID(),
      p_actor_user_id: crypto.randomUUID(),
      p_actor_email: "attacker@example.test",
    });

    assertExists(error, "direct authenticated RPC call must be rejected");
    assertPermissionDenied(error);
  },
});

Deno.test({
  name: "delete_lease_cascade: direct anon RPC call is rejected (grant revoked)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const anon = anonClient();
    const { error } = await anon.rpc("delete_lease_cascade", {
      target_lease_id: crypto.randomUUID(),
      p_actor_user_id: crypto.randomUUID(),
      p_actor_email: "anon-attacker@example.test",
    });

    assertExists(error, "direct anon RPC call must be rejected");
    assertPermissionDenied(error);
  },
});

Deno.test({
  name: "delete-lease-cascade edge function: authorized same-org user succeeds, lease and cascade children are gone",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", { name: `Delete Cascade Edge Org ${suffix}`, status: "active" });
    const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      status: "active",
    });
    const criticalDate = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      date_type: "custom",
      due_date: "2027-01-01",
    });

    const response = await callDeleteLeaseCascade(accessToken, { lease_id: lease.id });
    const body = await response.json();

    assertEquals(response.status, 200, JSON.stringify(body));
    assertEquals(body.error, false);
    assertEquals(body.lease_id, lease.id);

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertEquals(leaseAfter, null, "lease must be gone after cascade delete");

    const { data: criticalDateAfter } = await admin
      .from("lease_critical_dates")
      .select("id")
      .eq("id", criticalDate.id)
      .maybeSingle();
    assertEquals(criticalDateAfter, null, "cascade child row must be gone too");

    const { data: auditRows } = await admin
      .from("audit_logs")
      .select("id, action, actor_email")
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "delete");
    assertEquals((auditRows || []).length, 1, "exactly one delete audit row");
  },
});

Deno.test({
  name: "delete-lease-cascade edge function: rejects a cross-org lease_id, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const ownerOrg = await insertOne(admin, "organizations", { name: `Owner Org ${suffix}`, status: "active" });
    const outsiderOrg = await insertOne(admin, "organizations", { name: `Outsider Org ${suffix}`, status: "active" });
    const { accessToken: outsiderToken } = await createOrgUser(admin, `${suffix}-outsider`, outsiderOrg.id, "org_admin");
    const property = await insertOne(admin, "properties", { org_id: ownerOrg.id, name: `Owner Property ${suffix}`, status: "active" });
    const lease = await insertOne(admin, "leases", {
      org_id: ownerOrg.id,
      property_id: property.id,
      tenant_name: `Owner Tenant ${suffix}`,
      status: "active",
    });

    const response = await callDeleteLeaseCascade(outsiderToken, { lease_id: lease.id });
    const body = await response.json();

    assertEquals(body.error, true);
    assertEquals(response.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertExists(leaseAfter, "lease must survive a rejected cross-org delete attempt");
  },
});

Deno.test({
  name: "delete-lease-cascade edge function: rejects an unauthorized viewer user, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", { name: `Viewer Org ${suffix}`, status: "active" });
    const { accessToken } = await createOrgUser(admin, suffix, org.id, "viewer");
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      status: "active",
    });

    const response = await callDeleteLeaseCascade(accessToken, { lease_id: lease.id });
    const body = await response.json();

    assertEquals(body.error, true);
    assertEquals([401, 403].includes(response.status), true, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertExists(leaseAfter, "lease must survive a rejected unauthorized delete attempt");
  },
});

Deno.test({
  name: "delete-lease-cascade edge function: rejects a user with LeaseUpload write but no Leases write, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", { name: `LeaseUpload Only Org ${suffix}`, status: "active" });
    // viewer's own defaults are below the write threshold for every page
    // (confirmed: role_default_page_access('viewer','Leases') = 'read',
    // ('viewer','LeaseUpload') = 'none'); the explicit page_permissions
    // override grants write on LeaseUpload only, leaving Leases at its
    // viewer default ('read', rank 1 < the write threshold of 2).
    const { accessToken } = await createOrgUser(admin, suffix, org.id, "viewer", { LeaseUpload: "write" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      status: "active",
    });

    const response = await callDeleteLeaseCascade(accessToken, { lease_id: lease.id });
    const body = await response.json();

    assertEquals(body.error, true);
    assertEquals([401, 403].includes(response.status), true, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertExists(leaseAfter, "lease must survive a rejected LeaseUpload-only-write delete attempt");
  },
});

Deno.test({
  name: "delete-lease-cascade edge function: rejects a user with LeaseReview write but no Leases write, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const org = await insertOne(admin, "organizations", { name: `LeaseReview Only Org ${suffix}`, status: "active" });
    const { accessToken } = await createOrgUser(admin, suffix, org.id, "viewer", { LeaseReview: "write" });
    const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      status: "active",
    });

    const response = await callDeleteLeaseCascade(accessToken, { lease_id: lease.id });
    const body = await response.json();

    assertEquals(body.error, true);
    assertEquals([401, 403].includes(response.status), true, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertExists(leaseAfter, "lease must survive a rejected LeaseReview-only-write delete attempt");
  },
});

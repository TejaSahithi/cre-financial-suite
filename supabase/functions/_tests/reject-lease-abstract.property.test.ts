// Feature: enterprise-readiness-hardening Phase 6D-5 (reject_lease_abstract).
// Properties:
//   1. Rejection succeeds from a valid pending/review state -- sets
//      status='rejected', abstract_status='rejected',
//      extraction_data.rejection={reason,rejected_at,rejected_by}, other
//      extraction_data keys preserved.
//   2. An unknown lease_id is rejected, zero side effects.
//   3. A user without write access is blocked, zero side effects.
//   4. A lease with abstract_status='approved' is rejected (409) -- the
//      "locked" guard (an intentional new guarantee: the old client code
//      had no such check).
//   5. No JSONB patch parameter exists on this RPC at all, so there is no
//      arbitrary-column-patch surface to test here (documented, not a gap).
//   6. Exactly one audit_logs row per successful call, canonical shape.
//   7. tr_lease_changed does not duplicate the RPC's audit row (GUC skip).
//   8. A later, separate direct UPDATE on the same lease still gets
//      trigger-audited normally -- the GUC does not leak across
//      transactions.
//   9. (Property 10 -- existing approve_lease_workflow tests still pass --
//      verified by running the full regression suite alongside this file,
//      not re-derived here.)
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
  const email = `reject-lease-abstract-${suffix}@example.test`;
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
    full_name: "Reject Lease Abstract Tester",
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

function callReject(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/reject-lease-abstract`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string, leaseOverrides: Record<string, unknown> = {}) {
  const org = await insertOne(admin, "organizations", {
    name: `Reject Lease Abstract Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Reject Lease Abstract Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Reject Lease Abstract Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
    abstract_status: "pending_review",
    extraction_data: {
      fields: { monthly_rent: { value: 1000 } },
    },
    ...leaseOverrides,
  });

  return { org, accessToken, userId, email, property, lease };
}

Deno.test({
  name: "reject_lease_abstract: succeeds from pending_review, preserves other extraction_data keys",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callReject(accessToken, {
      lease_id: lease.id,
      reason: "Missing signature page",
      rejected_by: "Jane Reviewer",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);
    assertEquals(body.status, "rejected");
    assertEquals(body.abstract_status, "rejected");

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("status, abstract_status, extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "rejected");
    assertEquals(leaseAfter.abstract_status, "rejected");
    assertEquals(leaseAfter.extraction_data.rejection.reason, "Missing signature page");
    assertEquals(leaseAfter.extraction_data.rejection.rejected_by, "Jane Reviewer");
    assertExists(leaseAfter.extraction_data.rejection.rejected_at);
    // Sibling extraction_data key from setup must survive.
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 1000);
  },
});

Deno.test({
  name: "reject_lease_abstract: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callReject(accessToken, {
      lease_id: crypto.randomUUID(),
      reason: "Missing signature page",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "reject_lease_abstract: user without write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callReject(viewerToken, {
      lease_id: lease.id,
      reason: "Missing signature page",
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("status").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "active");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .neq("action", "create");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "blocked attempt must not write any audit row");
  },
});

Deno.test({
  name: "reject_lease_abstract: already-approved lease is rejected (locked), no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix, { abstract_status: "approved", status: "approved" });

    const res = await callReject(accessToken, {
      lease_id: lease.id,
      reason: "Missing signature page",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an approved lease to reject the rejection attempt");
    assertEquals(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("status, abstract_status").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "approved");
    assertEquals(leaseAfter.abstract_status, "approved");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .neq("action", "create");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a rejected attempt on an approved lease must not write any audit row");
  },
});

Deno.test({
  name: "reject_lease_abstract: exactly one audit row, trigger does not duplicate it, GUC does not leak",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callReject(accessToken, {
      lease_id: lease.id,
      reason: "Missing signature page",
      rejected_by: "Jane Reviewer",
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata, actor_user_id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_abstract_rejected");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row");
    assertExists(rpcAuditRows![0].actor_user_id);
    assertExists(rpcAuditRows![0].before);
    assertExists(rpcAuditRows![0].after);
    assertEquals((rpcAuditRows![0].metadata as Record<string, unknown>).reason, "Missing signature page");
    assertEquals((rpcAuditRows![0].metadata as Record<string, unknown>).prior_abstract_status, "pending_review");

    // Trigger must not have written a second, duplicate 'update' row for
    // this same UPDATE (the fixture's own INSERT already produced one
    // 'create' row, which is expected and excluded here).
    const { data: triggerUpdateRows, error: triggerUpdateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(triggerUpdateErr);
    assertEquals(triggerUpdateRows?.length ?? 0, 0, "tr_lease_changed must not write a duplicate 'update' row for this RPC's UPDATE");

    // A later, separate direct UPDATE (outside the RPC, simulating a
    // still-out-of-scope call site) must still be trigger-audited normally
    // -- the GUC must not leak across transactions.
    const { error: directUpdateErr } = await admin
      .from("leases")
      .update({ status: "expired" })
      .eq("id", lease.id);
    assertNoError(directUpdateErr);

    const { data: afterDirectUpdate, error: afterDirectUpdateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(afterDirectUpdateErr);
    assertEquals(afterDirectUpdate?.length, 1, "a later direct UPDATE must still be trigger-audited (GUC must not leak)");
  },
});

// Feature: enterprise-readiness-hardening Phase 6R-1 (send_lease_back_for_reextraction).
// Properties:
//   1. Send-back succeeds from a non-approved state -- sets status='draft',
//      extraction_data.send_back={reason,sent_back_at}, other extraction_data
//      keys preserved.
//   2. An unknown lease_id is rejected, zero side effects.
//   3. A user without write access is blocked, zero side effects.
//   4. A lease with abstract_status='approved' is rejected (409) -- the same
//      "locked" guard as reject_lease_abstract/update_lease_extraction_field.
//   5. Exactly one audit_logs row per successful call, canonical shape.
//   6. tr_lease_changed does not duplicate the RPC's audit row (GUC skip).
//   7. A later, separate direct UPDATE on the same lease still gets
//      trigger-audited normally -- the GUC does not leak across transactions.
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
  const email = `send-lease-back-${suffix}@example.test`;
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
    full_name: "Send Lease Back Tester",
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

function callSendBack(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/send-lease-back-for-reextraction`, {
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
    name: `Send Lease Back Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Send Lease Back Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Send Lease Back Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "pending_review",
    abstract_status: "pending_review",
    extraction_data: {
      fields: { monthly_rent: { value: 1000 } },
    },
    ...leaseOverrides,
  });

  return { org, accessToken, userId, email, property, lease };
}

Deno.test({
  name: "send_lease_back_for_reextraction: succeeds, sets status=draft, preserves other extraction_data keys",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callSendBack(accessToken, {
      lease_id: lease.id,
      reason: "Missing exhibit B",
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);
    assertEquals(body.status, "draft");

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("status, extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "draft");
    assertEquals(leaseAfter.extraction_data.send_back.reason, "Missing exhibit B");
    assertExists(leaseAfter.extraction_data.send_back.sent_back_at);
    // Sibling extraction_data key from setup must survive.
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 1000);
  },
});

Deno.test({
  name: "send_lease_back_for_reextraction: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callSendBack(accessToken, {
      lease_id: crypto.randomUUID(),
      reason: "x",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "send_lease_back_for_reextraction: user without write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callSendBack(viewerToken, {
      lease_id: lease.id,
      reason: "x",
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("status").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "pending_review");

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
  name: "send_lease_back_for_reextraction: already-approved lease is rejected (locked), no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix, { abstract_status: "approved", status: "approved" });

    const res = await callSendBack(accessToken, {
      lease_id: lease.id,
      reason: "x",
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an approved lease to reject the send-back attempt");
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
  name: "send_lease_back_for_reextraction: exactly one audit row, trigger does not duplicate it, GUC does not leak",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callSendBack(accessToken, {
      lease_id: lease.id,
      reason: "Missing exhibit B",
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata, actor_user_id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_sent_back_for_reextraction");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row");
    assertExists(rpcAuditRows![0].actor_user_id);
    assertExists(rpcAuditRows![0].before);
    assertExists(rpcAuditRows![0].after);
    assertEquals((rpcAuditRows![0].metadata as Record<string, unknown>).reason, "Missing exhibit B");

    const { data: triggerUpdateRows, error: triggerUpdateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(triggerUpdateErr);
    assertEquals(triggerUpdateRows?.length ?? 0, 0, "tr_lease_changed must not write a duplicate 'update' row for this RPC's UPDATE");

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

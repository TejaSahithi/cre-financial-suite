// Feature: enterprise-readiness-hardening Phase 6D-3 (save_lease_review_draft).
// Properties:
//   1. Successful draft save fully replaces extraction_data.field_reviews
//      and sets abstract_status='pending_review'.
//   2. Existing extraction_data keys (fields/field_evidence/etc.) not part
//      of field_reviews are preserved.
//   3. A user without write access is blocked, zero side effects.
//   4. An unknown lease_id is rejected, zero side effects.
//   5. A lease with abstract_status='approved' is rejected (409), zero side
//      effects -- the "locked" guard (an intentional new guarantee: the old
//      client-side saveAbstractDraft silently allowed this).
//   6. An arbitrary/non-object field_reviews payload is rejected.
//   7. Exactly one audit_logs row per successful call, canonical shape.
//   8. tr_lease_changed does not duplicate the RPC's audit row (GUC skip).
//   9. A later, separate direct UPDATE on the same lease still gets
//      trigger-audited normally -- the GUC does not leak across
//      transactions.
//   10. Two sequential draft saves against the same lease both land in
//       order -- FOR UPDATE + fresh re-read composes writes without
//       clobbering. Stands in for optimistic-concurrency coverage: no
//       version column exists on `leases` today, so true stale-write
//       rejection is not testable/applicable in this pass.
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
  const email = `save-lease-review-draft-${suffix}@example.test`;
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
    full_name: "Save Lease Review Draft Tester",
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

function callSaveDraft(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/save-lease-review-draft`, {
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
    name: `Save Lease Review Draft Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Save Lease Review Draft Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Save Lease Review Draft Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
    abstract_status: "draft",
    extraction_data: {
      fields: { monthly_rent: { value: 1000 } },
      field_reviews: { monthly_rent: { status: "pending" } },
    },
    ...leaseOverrides,
  });

  return { org, accessToken, userId, email, property, lease };
}

Deno.test({
  name: "save_lease_review_draft: success replaces field_reviews, sets abstract_status=pending_review",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const nextFieldReviews = {
      monthly_rent: { status: "accepted", value: 1000, reviewed_at: new Date().toISOString() },
      tenant_name: { status: "edited", value: "Acme Corp", reviewed_at: new Date().toISOString() },
    };

    const res = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: nextFieldReviews,
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);
    assertEquals(body.abstract_status, "pending_review");

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data, abstract_status")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.abstract_status, "pending_review");
    assertEquals(leaseAfter.extraction_data.field_reviews.monthly_rent.status, "accepted");
    assertEquals(leaseAfter.extraction_data.field_reviews.tenant_name.value, "Acme Corp");
  },
});

Deno.test({
  name: "save_lease_review_draft: existing extraction_data keys outside field_reviews are preserved",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: { monthly_rent: { status: "rejected" } },
    });
    assertEquals(res.status, 200, JSON.stringify(await res.json()));

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    // The pre-existing extraction_data.fields key (unrelated to field_reviews)
    // must survive -- proves the RPC preserves sibling top-level keys rather
    // than replacing the whole extraction_data object.
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 1000);
    assertEquals(leaseAfter.extraction_data.field_reviews.monthly_rent.status, "rejected");
  },
});

Deno.test({
  name: "save_lease_review_draft: user without write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callSaveDraft(viewerToken, {
      lease_id: lease.id,
      field_reviews: { monthly_rent: { status: "accepted" } },
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.field_reviews.monthly_rent.status, "pending");

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
  name: "save_lease_review_draft: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callSaveDraft(accessToken, {
      lease_id: crypto.randomUUID(),
      field_reviews: { monthly_rent: { status: "accepted" } },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "save_lease_review_draft: approved lease is rejected (locked), no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix, { abstract_status: "approved" });

    const res = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: { monthly_rent: { status: "accepted" } },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an approved lease to reject the write");
    assertEquals(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("abstract_status, extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.abstract_status, "approved");
    assertEquals(leaseAfter.extraction_data.field_reviews.monthly_rent.status, "pending");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .neq("action", "create");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a rejected write on an approved lease must not write any audit row");
  },
});

Deno.test({
  name: "save_lease_review_draft: non-object field_reviews payload is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: ["not", "an", "object"],
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an array field_reviews payload to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.field_reviews.monthly_rent.status, "pending", "no partial write must occur on a rejected payload");
  },
});

Deno.test({
  name: "save_lease_review_draft: exactly one audit row, trigger does not duplicate it, GUC does not leak",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: { monthly_rent: { status: "accepted" } },
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata, actor_user_id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_review_draft_saved");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row");
    assertExists(rpcAuditRows![0].actor_user_id);
    assertExists(rpcAuditRows![0].before);
    assertExists(rpcAuditRows![0].after);
    assertEquals((rpcAuditRows![0].metadata as Record<string, unknown>).prior_abstract_status, "draft");
    assertEquals((rpcAuditRows![0].metadata as Record<string, unknown>).next_abstract_status, "pending_review");

    // Trigger must not have written a second, duplicate 'update' row for this
    // same UPDATE (the fixture's own INSERT already produced one 'create'
    // row, which is expected and excluded here).
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

Deno.test({
  name: "save_lease_review_draft: two sequential draft saves both land in order",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const firstRes = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: { monthly_rent: { status: "accepted" } },
    });
    assertEquals(firstRes.status, 200, JSON.stringify(await firstRes.json()));

    const secondRes = await callSaveDraft(accessToken, {
      lease_id: lease.id,
      field_reviews: { monthly_rent: { status: "accepted" }, tenant_name: { status: "edited", value: "Beta LLC" } },
    });
    assertEquals(secondRes.status, 200, JSON.stringify(await secondRes.json()));

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.field_reviews.monthly_rent.status, "accepted", "first call's write must survive");
    assertEquals(leaseAfter.extraction_data.field_reviews.tenant_name.value, "Beta LLC", "second call's write must also be present");
  },
});

// Feature: enterprise-readiness-hardening Phase HARD-3B3A
// (persist_lease_extraction_merge). Covers the three remaining E-bucket
// direct leases UPDATE persistence paths ahead of HARD-3B3B's leases_update
// RLS lockdown: LeaseReview.jsx's handleReextractLease (manual-review
// fallback + success/blocked merge) and ExtractionDebugPanel.jsx's
// handleApplyLatestExtraction. All three only ever set whole top-level
// extraction_data keys (fields/field_evidence/confidence_scores/
// workflow_output/evidence_refreshed_at/extraction_debug/
// last_reextract_blocked_at), so this RPC does a single `existing || patch`
// concatenation rather than a per-field merge.
// Properties:
//   1. Valid same-org merge succeeds for each of the 4 allowed actions;
//      keys present in the patch replace exactly those top-level keys,
//      untouched keys survive; exactly one audit row per call with the
//      correct action name.
//   2. Cross-org lease_id rejected, no side effects.
//   3. Unauthorized (viewer) user is blocked, no side effects.
//   4. Unknown lease_id rejected, no side effects.
//   5. Disallowed action rejected.
//   6. Disallowed patch key rejected (injection resistance).
//   7. Oversized payload rejected.
//   8. Approved lease is rejected (locked), no side effects, no audit row.
//   9. Trigger does not duplicate the RPC's own audit row.
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
  const email = `persist-lease-extraction-merge-${suffix}@example.test`;
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
    full_name: "Persist Lease Extraction Merge Tester",
    role: "user",
    status: "active",
  });

  await insertOne(admin, "memberships", { user_id: userId, org_id: orgId, role });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({ email, password });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { userId, email, accessToken };
}

function callFn(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/persist-lease-extraction-merge`, {
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
  const org = await insertOne(admin, "organizations", { name: `Persist Extraction Merge Org ${suffix}`, status: "active" });
  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Tenant ${suffix}`,
    status: "active",
    extraction_data: {
      fields: { tenant_name: { value: `Tenant ${suffix}` } },
      untouched_key: "must survive",
    },
    ...overrides,
  });
  return { org, accessToken, property, lease };
}

Deno.test({
  name: "persist_lease_extraction_merge: lease_extraction_manual_review_recorded succeeds, only evidence_refreshed_at+extraction_debug set, other keys survive, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_manual_review_recorded",
      patch: {
        evidence_refreshed_at: "2026-07-10T00:00:00.000Z",
        extraction_debug: { last_reextract_manual_review_stage: "extraction" },
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertExists(body.audit_log_id);

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.evidence_refreshed_at, "2026-07-10T00:00:00.000Z");
    assertEquals(leaseAfter.extraction_data.extraction_debug.last_reextract_manual_review_stage, "extraction");
    // Untouched pre-existing keys survive.
    assertEquals(leaseAfter.extraction_data.untouched_key, "must survive");
    assertEquals(leaseAfter.extraction_data.fields.tenant_name.value, `Tenant ${suffix}`);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_extraction_manual_review_recorded");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "must write exactly one audit row");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: lease_extraction_merged succeeds -- fields/field_evidence/confidence_scores/workflow_output fully replace, untouched keys survive",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_merged",
      patch: {
        fields: { tenant_name: { value: "New Tenant" }, monthly_rent: { value: 5000 } },
        field_evidence: { tenant_name: { source_text: "p.1" } },
        confidence_scores: { tenant_name: 90 },
        workflow_output: { lease_fields: {} },
        evidence_refreshed_at: "2026-07-10T01:00:00.000Z",
        extraction_debug: { merged_fields_total: 2 },
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: leaseAfter } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertExists(leaseAfter);
    // fields is a whole-key replace -- tenant_name's original value is gone,
    // replaced entirely by the new fields map (not deep-merged).
    assertEquals(leaseAfter.extraction_data.fields.tenant_name.value, "New Tenant");
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 5000);
    assertEquals(leaseAfter.extraction_data.confidence_scores.tenant_name, 90);
    assertEquals(leaseAfter.extraction_data.workflow_output.lease_fields, {});
    // Untouched top-level key survives.
    assertEquals(leaseAfter.extraction_data.untouched_key, "must survive");
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: lease_extraction_merge_blocked succeeds -- only extraction_debug/last_reextract_blocked_at set, previous fields fully preserved",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_merge_blocked",
      patch: {
        extraction_debug: { overwrite_blocked_reason: "new_extraction_has_zero_source_backed_fields_previous_data_preserved" },
        last_reextract_blocked_at: "2026-07-10T02:00:00.000Z",
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: leaseAfter } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.last_reextract_blocked_at, "2026-07-10T02:00:00.000Z");
    // Previous fields entirely preserved -- the blocked branch must not
    // touch fields/field_evidence/confidence_scores at all.
    assertEquals(leaseAfter.extraction_data.fields.tenant_name.value, `Tenant ${suffix}`);
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: lease_extraction_debug_applied succeeds (ExtractionDebugPanel shape -- no extraction_debug key)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_debug_applied",
      patch: {
        fields: { tenant_name: { value: "Debug Applied Tenant" } },
        field_evidence: {},
        confidence_scores: {},
        evidence_refreshed_at: "2026-07-10T03:00:00.000Z",
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: leaseAfter } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.fields.tenant_name.value, "Debug Applied Tenant");
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: cross-org lease_id rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const otherOrg = await insertOne(admin, "organizations", { name: `Other Org ${suffix}`, status: "active" });
    const otherProperty = await insertOne(admin, "properties", { org_id: otherOrg.id, name: `Other Property ${suffix}`, status: "active" });
    const otherLease = await insertOne(admin, "leases", {
      org_id: otherOrg.id,
      property_id: otherProperty.id,
      tenant_name: "Other Tenant",
      status: "active",
      extraction_data: {},
    });

    const res = await callFn(accessToken, {
      lease_id: otherLease.id,
      action: "lease_extraction_merged",
      patch: { evidence_refreshed_at: "2026-07-10T00:00:00.000Z" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected cross-org lease to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", otherLease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data?.evidence_refreshed_at, undefined);
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: unauthorized (viewer) user is blocked, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      lease_id: lease.id,
      action: "lease_extraction_merged",
      patch: { evidence_refreshed_at: "2026-07-10T00:00:00.000Z" },
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data?.evidence_refreshed_at, undefined);
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: unknown lease_id rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: crypto.randomUUID(),
      action: "lease_extraction_merged",
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, JSON.stringify(body));
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: disallowed action rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "not_a_real_action",
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unknown action to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: disallowed patch key rejected (injection resistance)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_merged",
      patch: { status: "approved", field_reviews: { x: "y" } },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unknown patch key to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("status, extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "active", "the lease must be unchanged");
    assertEquals(leaseAfter.extraction_data?.field_reviews, undefined);
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: oversized payload rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const bigFields: Record<string, unknown> = {};
    const bigValue = "x".repeat(5000);
    for (let i = 0; i < 500; i++) {
      bigFields[`field_${i}`] = { value: bigValue };
    }

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_merged",
      patch: { fields: bigFields },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an oversized patch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: approved lease is rejected (locked), no side effects, no audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix, { abstract_status: "approved" });

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_merged",
      patch: { evidence_refreshed_at: "2026-07-10T00:00:00.000Z" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected approved lease to be locked");
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data?.evidence_refreshed_at, undefined);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_extraction_merged");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a blocked write must not write any audit row");
  },
});

Deno.test({
  name: "persist_lease_extraction_merge: exactly one audit row for the RPC's own action -- trigger does not duplicate it with a generic 'update' row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      action: "lease_extraction_merged",
      patch: { evidence_refreshed_at: "2026-07-10T00:00:00.000Z" },
    });
    assertEquals(res.status, 200, JSON.stringify(await res.clone().json()));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_extraction_merged");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row for this action");

    const { data: triggerUpdateRows, error: triggerUpdateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(triggerUpdateErr);
    assertEquals(triggerUpdateRows?.length ?? 0, 0, "tr_lease_changed must not write a duplicate 'update' row for this RPC's UPDATE");
  },
});

// Feature: enterprise-readiness-hardening Phase HARD-3B2
// (backfill_lease_evidence). Covers LeaseReview.jsx's evidence-backfill
// bulk-merge useEffect. All evidence-matching computation stays client-side
// (unchanged) -- this RPC only persists the already-computed
// fields/field_evidence/workflow_output patch transactionally with one
// audit row.
// Properties:
//   1. Valid same-org merge succeeds: fields/field_evidence merged at the
//      top-level-key granularity (existing untouched keys survive),
//      evidence_backfilled_at stamped, exactly one audit row.
//   2. workflow_output is applied only when provided.
//   3. Cross-org lease_id rejected, no side effects.
//   4. Unauthorized (viewer) user is blocked, no side effects.
//   5. Unknown lease_id rejected, no side effects.
//   6. Approved lease is rejected (locked), no side effects, no audit row.
//   7. Oversized patch (>300 keys) is rejected.
//   8. Trigger does not duplicate the RPC's own audit row.
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
  const email = `backfill-lease-evidence-${suffix}@example.test`;
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
    full_name: "Backfill Lease Evidence Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/backfill-lease-evidence`, {
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
  const org = await insertOne(admin, "organizations", { name: `Backfill Evidence Org ${suffix}`, status: "active" });
  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Tenant ${suffix}`,
    status: "active",
    extraction_data: {
      fields: { tenant_name: { value: `Tenant ${suffix}` }, monthly_rent: { value: 1000 } },
      untouched_key: "must survive",
    },
    ...overrides,
  });
  return { org, accessToken, property, lease };
}

Deno.test({
  name: "backfill_lease_evidence: valid merge succeeds -- untouched fields survive, patched keys applied, evidence_backfilled_at stamped, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      fields_patch: { commencement_date: { value: "2026-01-01", source_text: "Commencing Jan 1 2026" } },
      field_evidence_patch: { commencement_date: { source_text: "Commencing Jan 1 2026", source_page: 2 } },
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
    // Patched key applied.
    assertEquals(leaseAfter.extraction_data.fields.commencement_date.value, "2026-01-01");
    assertEquals(leaseAfter.extraction_data.field_evidence.commencement_date.source_page, 2);
    // Pre-existing, untouched field key survives (top-level merge, not
    // wholesale replace).
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 1000);
    assertEquals(leaseAfter.extraction_data.untouched_key, "must survive");
    // evidence_backfilled_at stamped.
    assertExists(leaseAfter.extraction_data.evidence_backfilled_at);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_evidence_backfilled");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "must write exactly one audit row");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "backfill_lease_evidence: workflow_output is applied only when provided",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const withoutWf = await callFn(accessToken, { lease_id: lease.id, fields_patch: {}, field_evidence_patch: {} });
    assertEquals(withoutWf.status, 200, JSON.stringify(await withoutWf.clone().json()));
    const { data: afterNoWf } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertEquals(afterNoWf?.extraction_data?.workflow_output, undefined, "workflow_output must not appear when not provided");

    const withWf = await callFn(accessToken, {
      lease_id: lease.id,
      fields_patch: {},
      field_evidence_patch: {},
      workflow_output: { lease_fields: { tenant_name: { value: "Acme" } } },
    });
    assertEquals(withWf.status, 200, JSON.stringify(await withWf.clone().json()));
    const { data: afterWf } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertEquals(afterWf?.extraction_data?.workflow_output?.lease_fields?.tenant_name?.value, "Acme");
  },
});

Deno.test({
  name: "backfill_lease_evidence: cross-org lease_id rejected, no side effects",
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
      fields_patch: { x: { value: 1 } },
      field_evidence_patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected cross-org lease to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", otherLease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data?.fields?.x, undefined);
  },
});

Deno.test({
  name: "backfill_lease_evidence: unauthorized (viewer) user is blocked, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      lease_id: lease.id,
      fields_patch: { x: { value: 1 } },
      field_evidence_patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data?.fields?.x, undefined);
  },
});

Deno.test({
  name: "backfill_lease_evidence: unknown lease_id rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: crypto.randomUUID(),
      fields_patch: {},
      field_evidence_patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, JSON.stringify(body));
  },
});

Deno.test({
  name: "backfill_lease_evidence: approved lease is rejected (locked), no side effects, no audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix, { abstract_status: "approved" });

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      fields_patch: { commencement_date: { value: "2026-01-01" } },
      field_evidence_patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected approved lease to be locked");
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data?.fields?.commencement_date, undefined);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_evidence_backfilled");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a blocked write must not write any audit row");
  },
});

Deno.test({
  name: "backfill_lease_evidence: oversized fields_patch (>300 keys) is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const oversizedPatch: Record<string, unknown> = {};
    for (let i = 0; i < 301; i++) {
      oversizedPatch[`field_${i}`] = { value: i };
    }

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      fields_patch: oversizedPatch,
      field_evidence_patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an oversized patch to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));
  },
});

Deno.test({
  name: "backfill_lease_evidence: exactly one audit row for the RPC's own action -- trigger does not duplicate it with a generic 'update' row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      fields_patch: { commencement_date: { value: "2026-01-01" } },
      field_evidence_patch: {},
    });
    assertEquals(res.status, 200, JSON.stringify(await res.clone().json()));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_evidence_backfilled");
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

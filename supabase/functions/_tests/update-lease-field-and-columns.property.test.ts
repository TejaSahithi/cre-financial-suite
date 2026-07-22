// Feature: enterprise-readiness-hardening Phase HARD-3B2
// (update_lease_field_and_columns). Covers LeaseReview.jsx's
// handleFieldSave / FieldDetailDrawer.onSaveEdit -- mixes typed
// lease-table columns (server-whitelisted, unknown/legacy aliases silently
// dropped) with a merge onto extraction_data.fields[key] /
// field_evidence[key] / confidence_scores[key].
// Properties:
//   1. Valid same-org update succeeds: whitelisted typed column applied,
//      extraction_data.fields[key] merged, exactly one audit row.
//   2. Non-whitelisted column key in column_updates is silently dropped
//      (not applied, not an error) while the rest of the call still
//      succeeds.
//   3. field_evidence + confidence_score patch keys are applied when
//      provided.
//   4. Cross-org lease_id rejected, no side effects.
//   5. Unauthorized (viewer) user is blocked, no side effects.
//   6. Unknown lease_id rejected, no side effects.
//   7. Disallowed patch key rejected (injection resistance).
//   8. Approved lease is rejected (locked), no side effects, no audit row.
//   9. Invalid typed-column value (bad date string) is rejected, no side
//      effects, no audit row.
//   10. Trigger does not duplicate the RPC's own audit row.
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
  const email = `update-lease-field-cols-${suffix}@example.test`;
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
    full_name: "Update Lease Field Columns Tester",
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
  return fetch(`${SUPABASE_URL}/functions/v1/update-lease-field-and-columns`, {
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
  const org = await insertOne(admin, "organizations", { name: `Update Lease Field Cols Org ${suffix}`, status: "active" });
  const { accessToken } = await createOrgUser(admin, suffix, org.id, "org_admin");
  const property = await insertOne(admin, "properties", { org_id: org.id, name: `Property ${suffix}`, status: "active" });
  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
    extraction_data: {},
    ...overrides,
  });
  return { org, accessToken, property, lease };
}

Deno.test({
  name: "update_lease_field_and_columns: valid same-org update succeeds, whitelisted column applied, fields[key] merged, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "monthly_rent",
      column_updates: { monthly_rent: 4500 },
      patch: { field: { value: 4500, manually_edited: true } },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.applied_columns, ["monthly_rent"]);
    assertEquals(body.ignored_columns, []);
    assertExists(body.audit_log_id);

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("monthly_rent, extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(Number(leaseAfter.monthly_rent), 4500);
    assertEquals(leaseAfter.extraction_data?.fields?.monthly_rent?.value, 4500);
    assertEquals(leaseAfter.extraction_data?.fields?.monthly_rent?.manually_edited, true);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_field_manual_edit");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "must write exactly one audit row");
    assertExists(auditRows![0].before);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "update_lease_field_and_columns: non-whitelisted column keys are dropped from the typed-column write but reported explicitly as ignored_columns (not silently swallowed), whitelisted sibling column still applied",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "admin_fee_percent",
      // admin_fee_percent / org_id are NOT valid typed-column targets
      // (admin_fee_percent isn't a real leases column -- schema has
      // admin_fee_pct; org_id is a real column but never a legitimate
      // field-edit target) -- confirms the server-side whitelist drops
      // them from the typed-column write instead of failing the whole
      // request the way a raw PostgREST update would have, while
      // monthly_rent (a real whitelisted column) is still applied.
      column_updates: { admin_fee_percent: 5, org_id: "should-be-dropped-too", monthly_rent: 4200 },
      patch: { field: { value: 5 } },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);
    assertEquals(body.applied_columns, ["monthly_rent"], "only the whitelisted column should have been applied");
    assertEquals(
      [...body.ignored_columns].sort(),
      ["admin_fee_percent", "org_id"],
      "both non-whitelisted keys must be explicitly reported as ignored, not silently dropped",
    );

    const { data: leaseAfter } = await admin
      .from("leases")
      .select("org_id, monthly_rent, extraction_data")
      .eq("id", lease.id)
      .single();
    assertExists(leaseAfter);
    // org_id must never be reachable via column_updates.
    assertEquals(leaseAfter.org_id, org.id);
    // monthly_rent (whitelisted) is applied.
    assertEquals(Number(leaseAfter.monthly_rent), 4200);
    // extraction_data.fields[key] write still succeeds even though the
    // typed column for that same field_key was dropped.
    assertEquals(leaseAfter.extraction_data?.fields?.admin_fee_percent?.value, 5);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("metadata")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_field_manual_edit");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1);
    const metadata = auditRows![0].metadata as Record<string, unknown>;
    assertEquals(metadata.column_updates_applied, ["monthly_rent"]);
    assertEquals([...(metadata.ignored_columns as string[])].sort(), ["admin_fee_percent", "org_id"]);
  },
});

Deno.test({
  name: "update_lease_field_and_columns: field_evidence and confidence_score patch keys are applied when provided",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "tenant_name",
      column_updates: {},
      patch: {
        field: { value: "Acme Corp", manually_edited: true },
        field_evidence: { source_text: "Tenant: Acme Corp", source_page: 1 },
        confidence_score: 95,
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
    assertEquals(leaseAfter.extraction_data?.field_evidence?.tenant_name?.source_text, "Tenant: Acme Corp");
    assertEquals(leaseAfter.extraction_data?.confidence_scores?.tenant_name, 95);
  },
});

Deno.test({
  name: "update_lease_field_and_columns: cross-org lease_id rejected, no side effects",
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
    });

    const res = await callFn(accessToken, {
      lease_id: otherLease.id,
      field_key: "monthly_rent",
      column_updates: { monthly_rent: 1 },
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected cross-org lease to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("monthly_rent").eq("id", otherLease.id).single();
    assertExists(leaseAfter);
    assertEquals(Number(leaseAfter.monthly_rent), 0);
  },
});

Deno.test({
  name: "update_lease_field_and_columns: unauthorized (viewer) user is blocked, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callFn(viewerToken, {
      lease_id: lease.id,
      field_key: "monthly_rent",
      column_updates: { monthly_rent: 999 },
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}`);

    const { data: leaseAfter } = await admin.from("leases").select("monthly_rent").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(Number(leaseAfter.monthly_rent), 0);
  },
});

Deno.test({
  name: "update_lease_field_and_columns: unknown lease_id rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: crypto.randomUUID(),
      field_key: "monthly_rent",
      column_updates: {},
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals(/not found/i.test(body.message || ""), true, JSON.stringify(body));
  },
});

Deno.test({
  name: "update_lease_field_and_columns: disallowed patch key rejected (injection resistance)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "monthly_rent",
      column_updates: {},
      patch: { status: "approved" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an unknown patch key to be rejected");
    assertEquals(res.status, 400, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("status").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "active", "the lease must be unchanged");
  },
});

Deno.test({
  name: "update_lease_field_and_columns: approved lease is rejected (locked), no side effects, no audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix, { abstract_status: "approved" });

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "monthly_rent",
      column_updates: { monthly_rent: 5000 },
      patch: { field: { value: 5000 } },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected approved lease to be locked");
    assertEquals(res.status, 409, JSON.stringify(body));

    const { data: leaseAfter } = await admin.from("leases").select("monthly_rent").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(Number(leaseAfter.monthly_rent), 0);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_field_manual_edit");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a blocked write must not write any audit row");
  },
});

Deno.test({
  name: "update_lease_field_and_columns: invalid typed-column value (bad date string) is rejected, no side effects, no audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "commencement_date",
      column_updates: { commencement_date: "not-a-real-date" },
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an invalid date value to be rejected");

    const { data: leaseAfter } = await admin.from("leases").select("commencement_date").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.commencement_date, null);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_field_manual_edit");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "a failed write must not write any audit row");
  },
});

Deno.test({
  name: "update_lease_field_and_columns: exactly one audit row for the RPC's own action -- trigger does not duplicate it with a generic 'update' row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callFn(accessToken, {
      lease_id: lease.id,
      field_key: "annual_rent",
      column_updates: { annual_rent: 54000 },
      patch: { field: { value: 54000 } },
    });
    assertEquals(res.status, 200, JSON.stringify(await res.clone().json()));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_field_manual_edit");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row for this action");

    // The fixture's own INSERT already produced one legitimate 'create' row
    // (excluded here) -- what must NOT exist is a duplicate generic
    // 'update' row from tr_lease_changed for this RPC's own UPDATE.
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

// Feature: enterprise-readiness-hardening Phase 6D-2 (update_lease_extraction_field).
// Properties:
//   1. field_value success shallow-merges onto existing fields[key]/
//      field_evidence[key]/confidence_scores[key], preserving sibling keys.
//   2. field_value success from an entirely-empty extraction_data creates
//      the fields/field_evidence containers correctly.
//   3. source_link success sets top-level keys, leaves unrelated top-level
//      keys (e.g. extraction_data.fields) untouched.
//   4. A user without write access is blocked, zero side effects.
//   5. An unknown lease_id is rejected, zero side effects.
//   6. A lease with abstract_status='approved' is rejected (409), zero
//      side effects -- the "locked" guard.
//   7/8. An arbitrary/disallowed patch key is rejected for both field_area
//      values, zero side effects (injection resistance).
//   9. An action not whitelisted for the given field_area is rejected.
//   10. Exactly one audit_logs row per successful call, canonical shape.
//   11. tr_lease_changed does not duplicate the RPC's audit row (GUC skip).
//   12. A later, separate direct UPDATE on the same lease still gets
//       trigger-audited normally -- the GUC does not leak across
//       transactions.
//   13. Two sequential RPC calls against the same lease (one field_value,
//       one source_link) both land -- FOR UPDATE + fresh re-read composes
//       multiple writes without clobbering. Stands in for optimistic-
//       concurrency coverage: no version column exists on `leases` today,
//       so true stale-write rejection is not testable/applicable in this
//       pass -- this test demonstrates the row-lock's data-integrity
//       guarantee instead.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

if (!SERVICE_ROLE_KEY || !ANON_KEY) {
  throw new Error("update-lease-extraction-field tests require local SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY env vars");
}

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
  const email = `update-lease-extraction-field-${suffix}@example.test`;
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
    full_name: "Update Lease Extraction Field Tester",
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

function callUpdateField(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/update-lease-extraction-field`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function createSourceUpload(admin: ReturnType<typeof adminClient>, orgId: string, userId: string, suffix: string, fileName = "lease-doc.pdf") {
  return insertOne(admin, "uploaded_files", {
    org_id: orgId,
    module_type: "leases",
    file_name: `${suffix}-${fileName}`,
    file_url: `local://update-lease-extraction-field/${suffix}/${fileName}`,
    file_size: 1024,
    mime_type: "application/pdf",
    uploaded_by: userId,
    status: "completed",
    processing_status: "completed",
    review_required: false,
    review_status: "not_required",
  });
}
async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string, leaseOverrides: Record<string, unknown> = {}) {
  const org = await insertOne(admin, "organizations", {
    name: `Update Lease Extraction Field Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Update Lease Extraction Field Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Update Lease Extraction Field Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
    abstract_status: "draft",
    extraction_data: {
      fields: { monthly_rent: { value: 1000, source_text: "orig" } },
      field_evidence: { monthly_rent: { source_page: 1 } },
      confidence_scores: { monthly_rent: 80 },
    },
    ...leaseOverrides,
  });

  return { org, accessToken, userId, email, property, lease };
}

Deno.test({
  name: "update_lease_extraction_field: field_value success shallow-merges, preserves sibling keys",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "field_value",
      action: "field_evidence_edit",
      field_key: "monthly_rent",
      patch: {
        field: { raw_value: "5,000", confidence: 95 },
        field_evidence: { raw_value: "5,000", source_page: 4 },
        confidence_score: 95,
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
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.raw_value, "5,000");
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.confidence, 95);
    // Sibling key from the original object must survive the shallow merge.
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.source_text, "orig");
    assertEquals(leaseAfter.extraction_data.field_evidence.monthly_rent.source_page, 4);
    assertEquals(leaseAfter.extraction_data.confidence_scores.monthly_rent, 95);
  },
});

Deno.test({
  name: "update_lease_extraction_field: field_value success creates containers from an empty extraction_data",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix, { extraction_data: {} });

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "field_value",
      action: "custom_field_added",
      field_key: "custom_widget",
      patch: {
        field: { value: "Widget Co", extraction_status: "manually_added" },
        field_evidence: { extraction_status: "manually_added" },
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.fields.custom_widget.value, "Widget Co");
    assertEquals(leaseAfter.extraction_data.field_evidence.custom_widget.extraction_status, "manually_added");
  },
});

Deno.test({
  name: "update_lease_extraction_field: source_link success sets top-level keys, leaves siblings untouched",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId, lease } = await setUpScope(admin, suffix);
    const source = await createSourceUpload(admin, org.id, userId, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: {
        source_file_id: source.id,
        source_file_name: "lease-doc.pdf",
        manually_linked_at: new Date().toISOString(),
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected success: ${JSON.stringify(body)}`);

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.source_file_name, "lease-doc.pdf");
    // Unrelated top-level key from setup must survive the top-level merge.
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 1000);
  },
});

Deno.test({
  name: "update_lease_extraction_field: lease_flag success sets document_type_override, leaves siblings untouched",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "lease_flag",
      action: "document_type_override_set",
      patch: { document_type_override: "full_lease" },
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
    assertEquals(leaseAfter.extraction_data.document_type_override, "full_lease");
    // Sibling top-level key from setup must survive.
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.value, 1000);
  },
});

Deno.test({
  name: "update_lease_extraction_field: lease_flag rejects a disallowed patch key",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "lease_flag",
      action: "document_type_override_set",
      patch: { document_type_override: "full_lease", status: "approved" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the disallowed 'status' key to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.document_type_override ?? null, null);
  },
});

Deno.test({
  name: "update_lease_extraction_field: user without write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callUpdateField(viewerToken, {
      lease_id: lease.id,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: crypto.randomUUID() },
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.source_file_id ?? null, null);

    // Excludes the lease fixture's own INSERT-triggered 'create' row
    // (tr_lease_changed fires on every leases INSERT) -- this asserts no
    // *additional* row was written by the blocked attempt.
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
  name: "update_lease_extraction_field: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId } = await setUpScope(admin, suffix);
    const source = await createSourceUpload(admin, org.id, userId, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: crypto.randomUUID(),
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: source.id },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "update_lease_extraction_field: approved lease is rejected (locked), no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId, lease } = await setUpScope(admin, suffix, { abstract_status: "approved" });
    const source = await createSourceUpload(admin, org.id, userId, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: source.id },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected an approved lease to reject the write");
    assertEquals(res.status, 409, `expected 409, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.source_file_id ?? null, null);

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
  name: "update_lease_extraction_field: disallowed patch key rejected for field_area=field_value",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "field_value",
      action: "field_evidence_edit",
      field_key: "monthly_rent",
      patch: { field: { raw_value: "x" }, evil_key: "hack" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the disallowed key to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.raw_value ?? null, null, "whole call must be rejected, not partially applied");
  },
});

Deno.test({
  name: "update_lease_extraction_field: disallowed patch key rejected for field_area=source_link (injection resistance)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId, lease } = await setUpScope(admin, suffix);
    const source = await createSourceUpload(admin, org.id, userId, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: source.id, status: "approved" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the disallowed key to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: leaseAfter } = await admin.from("leases").select("status, extraction_data").eq("id", lease.id).single();
    assertExists(leaseAfter);
    assertEquals(leaseAfter.status, "active", "an arbitrary key must not reach any other column");
    assertEquals(leaseAfter.extraction_data.source_file_id ?? null, null);
  },
});

Deno.test({
  name: "update_lease_extraction_field: action not whitelisted for the given field_area is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "field_value",
      action: "source_file_manually_linked",
      field_key: "monthly_rent",
      patch: { field: { raw_value: "x" } },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected the cross-area action to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "update_lease_extraction_field: exactly one audit row, trigger does not duplicate it, GUC does not leak",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId, lease } = await setUpScope(admin, suffix);
    const source = await createSourceUpload(admin, org.id, userId, suffix, "doc.pdf");

    const res = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: source.id, source_file_name: "doc.pdf" },
    });
    const body = await res.json();
    assertEquals(res.status, 200, JSON.stringify(body));

    const { data: rpcAuditRows, error: rpcAuditErr } = await admin
      .from("audit_logs")
      .select("id, before, after, metadata, actor_user_id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "source_file_manually_linked");
    assertNoError(rpcAuditErr);
    assertEquals(rpcAuditRows?.length, 1, "the RPC must write exactly one audit row for this action");
    assertExists(rpcAuditRows![0].actor_user_id);
    assertExists(rpcAuditRows![0].before);
    assertExists(rpcAuditRows![0].after);
    assertEquals((rpcAuditRows![0].metadata as Record<string, unknown>).field_area, "source_link");

    // Property 11: trigger must not have written a second, duplicate
    // 'update' row for this same UPDATE (the fixture's own INSERT already
    // produced one 'create' row, which is expected and excluded here).
    const { data: triggerUpdateRows, error: triggerUpdateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(triggerUpdateErr);
    assertEquals(triggerUpdateRows?.length ?? 0, 0, "tr_lease_changed must not write a duplicate 'update' row for this RPC's UPDATE");

    // Property 12: a later, separate direct UPDATE (outside the RPC,
    // simulating a still-out-of-scope call site) must still be
    // trigger-audited normally -- the GUC must not leak across
    // transactions.
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
  name: "update_lease_extraction_field: two sequential calls (field_value then source_link) both land, neither clobbers the other",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, userId, lease } = await setUpScope(admin, suffix);
    const source = await createSourceUpload(admin, org.id, userId, suffix, "seq.pdf");

    const firstRes = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "field_value",
      action: "field_evidence_edit",
      field_key: "monthly_rent",
      patch: { field: { raw_value: "9,999" } },
    });
    assertEquals(firstRes.status, 200, JSON.stringify(await firstRes.json()));

    const secondRes = await callUpdateField(accessToken, {
      lease_id: lease.id,
      field_area: "source_link",
      action: "source_file_manually_linked",
      patch: { source_file_id: source.id, source_file_name: "seq.pdf" },
    });
    assertEquals(secondRes.status, 200, JSON.stringify(await secondRes.json()));

    const { data: leaseAfter, error } = await admin
      .from("leases")
      .select("extraction_data")
      .eq("id", lease.id)
      .single();
    assertNoError(error);
    assertExists(leaseAfter);
    assertEquals(leaseAfter.extraction_data.fields.monthly_rent.raw_value, "9,999", "first call's write must survive the second call");
    assertEquals(leaseAfter.extraction_data.source_file_name, "seq.pdf", "second call's write must also be present");
  },
});

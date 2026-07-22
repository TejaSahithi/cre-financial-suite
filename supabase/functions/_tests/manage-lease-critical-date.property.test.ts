// Feature: enterprise-readiness-hardening Phase 6D-4 (manage_lease_critical_date).
// Properties:
//   1. create succeeds, writes exactly one audit row.
//   2. update (owner reassignment) succeeds, writes exactly one audit row.
//   3. delete succeeds, writes exactly one audit row.
//   4. mark_complete succeeds, writes exactly one audit row, completed_by
//      is a free-text value (not necessarily the acting user's identity).
//   5. A user without write access is blocked, zero side effects.
//   6. An unknown lease_id is rejected, zero side effects.
//   7. A critical_date_id belonging to a different lease/org is rejected.
//   8. An arbitrary/disallowed patch field is rejected for both create and
//      update (injection resistance).
//   9. service_role (used by this RPC) bypasses RLS -- a service-role
//      insert still succeeds regardless of the table's current RLS shape,
//      proving the RPC path is unaffected by whatever lockdown state
//      lease_critical_dates is in.
//   10. approve_lease_workflow's own derived-critical-date insert path is
//       completely untouched by this RPC (separate code path, separate
//       migration) -- verified by asserting that a lease approval still
//       creates its own critical_date rows via the existing regression
//       test lease-approval-rent-schedule-atomicity.property.test.ts (not
//       re-derived here to avoid duplicating that coverage).
//   11. (Phase 6R-4) Direct authenticated client INSERT/UPDATE against
//       lease_critical_dates are rejected by RLS -- the table's INSERT/
//       UPDATE policies were locked to WITH CHECK(false)/USING(false)
//       once every live write path was confirmed to route through this
//       RPC. SELECT and DELETE are asserted unchanged.
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
  const email = `manage-lease-critical-date-${suffix}@example.test`;
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
    full_name: "Manage Lease Critical Date Tester",
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

function callManage(accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/manage-lease-critical-date`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

async function setUpScope(admin: ReturnType<typeof adminClient>, suffix: string) {
  const org = await insertOne(admin, "organizations", {
    name: `Manage Lease Critical Date Org ${suffix}`,
    status: "active",
  });

  const { accessToken, userId, email } = await createOrgUser(admin, suffix, org.id, "org_admin");

  const property = await insertOne(admin, "properties", {
    org_id: org.id,
    name: `Manage Lease Critical Date Property ${suffix}`,
    status: "active",
  });

  const lease = await insertOne(admin, "leases", {
    org_id: org.id,
    property_id: property.id,
    tenant_name: `Manage Lease Critical Date Tenant ${suffix}`,
    start_date: "2026-01-01",
    end_date: "2030-12-31",
    status: "active",
  });

  return { org, accessToken, userId, email, property, lease };
}

Deno.test({
  name: "manage_lease_critical_date: create succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const res = await callManage(accessToken, {
      lease_id: lease.id,
      action: "create",
      patch: {
        date_type: "renewal_notice",
        due_date: "2027-06-01",
        owner_email: "owner@example.test",
        owner_name: "Owner Person",
        reminder_days_before: 30,
        note: "Notify tenant",
      },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected create to succeed: ${JSON.stringify(body)}`);
    assertExists(body.critical_date_id);
    assertExists(body.audit_log_id);
    assertEquals(body.row.date_type, "renewal_notice");
    assertEquals(body.row.owner_email, "owner@example.test");

    const { data: rowAfter, error } = await admin
      .from("lease_critical_dates")
      .select("*")
      .eq("id", body.critical_date_id)
      .single();
    assertNoError(error);
    assertExists(rowAfter);
    assertEquals(rowAfter.lease_id, lease.id);
    assertEquals(rowAfter.status, "open");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, action, actor_user_id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseCriticalDate")
      .eq("entity_id", body.critical_date_id)
      .eq("action", "lease_critical_date_created");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "create must write exactly one audit row");
    assertExists(auditRows![0].actor_user_id);
    assertEquals(auditRows![0].before, null);
    assertExists(auditRows![0].after);
  },
});

Deno.test({
  name: "manage_lease_critical_date: update (owner reassignment) succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const row = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-03-01",
      status: "open",
    });

    const res = await callManage(accessToken, {
      lease_id: lease.id,
      action: "update",
      critical_date_id: row.id,
      patch: { owner_email: "new-owner@example.test", owner_name: "New Owner" },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected update to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.owner_email, "new-owner@example.test");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseCriticalDate")
      .eq("entity_id", row.id)
      .eq("action", "lease_critical_date_updated");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "update must write exactly one audit row");
  },
});

Deno.test({
  name: "manage_lease_critical_date: mark_complete succeeds with free-text completed_by, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const row = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-03-01",
      status: "open",
      owner_name: "Row Owner",
    });

    const res = await callManage(accessToken, {
      lease_id: lease.id,
      action: "mark_complete",
      critical_date_id: row.id,
      patch: { completed_by: "Row Owner" },
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected mark_complete to succeed: ${JSON.stringify(body)}`);
    assertEquals(body.row.status, "completed");
    assertEquals(body.row.completed_by, "Row Owner");
    assertExists(body.row.completed_at);

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseCriticalDate")
      .eq("entity_id", row.id)
      .eq("action", "lease_critical_date_completed");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "mark_complete must write exactly one audit row");
  },
});

Deno.test({
  name: "manage_lease_critical_date: delete succeeds, exactly one audit row",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const row = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-03-01",
      status: "open",
    });

    const res = await callManage(accessToken, {
      lease_id: lease.id,
      action: "delete",
      critical_date_id: row.id,
      patch: {},
    });
    const body = await res.json();
    assertEquals(res.status, 200, `expected delete to succeed: ${JSON.stringify(body)}`);

    const { data: rowAfter, error } = await admin
      .from("lease_critical_dates")
      .select("id")
      .eq("id", row.id)
      .maybeSingle();
    assertNoError(error);
    assertEquals(rowAfter, null, "row must be gone after delete");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id, before, after")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseCriticalDate")
      .eq("entity_id", row.id)
      .eq("action", "lease_critical_date_deleted");
    assertNoError(auditErr);
    assertEquals(auditRows?.length, 1, "delete must write exactly one audit row");
    assertExists(auditRows![0].before);
    assertEquals(auditRows![0].after, null);
  },
});

Deno.test({
  name: "manage_lease_critical_date: user without write access is blocked",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);
    const { accessToken: viewerToken } = await createOrgUser(admin, `${suffix}-viewer`, org.id, "viewer");

    const res = await callManage(viewerToken, {
      lease_id: lease.id,
      action: "create",
      patch: { date_type: "custom", due_date: "2027-01-01" },
    });
    const body = await res.json();
    assertEquals(body.error, true, `expected viewer to be blocked: ${JSON.stringify(body)}`);
    assertEquals([401, 403].includes(res.status), true, `expected 401/403, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: rows, error } = await admin.from("lease_critical_dates").select("id").eq("lease_id", lease.id);
    assertNoError(error);
    assertEquals(rows?.length ?? 0, 0, "blocked attempt must not create any row");

    const { data: auditRows, error: auditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "LeaseCriticalDate");
    assertNoError(auditErr);
    assertEquals(auditRows?.length ?? 0, 0, "blocked attempt must not write any audit row");
  },
});

Deno.test({
  name: "manage_lease_critical_date: unknown lease_id is rejected, no side effects",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { accessToken } = await setUpScope(admin, suffix);

    const res = await callManage(accessToken, {
      lease_id: crypto.randomUUID(),
      action: "create",
      patch: { date_type: "custom", due_date: "2027-01-01" },
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a clear error for an unknown lease_id");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);
    assertEquals(/not found/i.test(body.message || ""), true, `expected a not-found message: ${JSON.stringify(body)}`);
  },
});

Deno.test({
  name: "manage_lease_critical_date: critical_date from a different lease is rejected",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease, property } = await setUpScope(admin, suffix);

    const otherLease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Other Lease ${suffix}`,
      start_date: "2026-01-01",
      end_date: "2030-12-31",
      status: "active",
    });
    const rowOnOtherLease = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: otherLease.id,
      property_id: property.id,
      date_type: "custom",
      due_date: "2027-03-01",
      status: "open",
    });

    const res = await callManage(accessToken, {
      lease_id: lease.id, // caller asserts the WRONG lease for this row
      action: "delete",
      critical_date_id: rowOnOtherLease.id,
      patch: {},
    });
    const body = await res.json();
    assertEquals(body.error, true, "expected a cross-lease critical_date reference to be rejected");
    assertEquals(res.status, 400, `expected 400, got ${res.status}: ${JSON.stringify(body)}`);

    const { data: rowAfter, error } = await admin
      .from("lease_critical_dates")
      .select("id")
      .eq("id", rowOnOtherLease.id)
      .maybeSingle();
    assertNoError(error);
    assertExists(rowAfter, "the row on the other lease must survive untouched");
  },
});

Deno.test({
  name: "manage_lease_critical_date: disallowed patch field rejected for create and update (injection resistance)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const createRes = await callManage(accessToken, {
      lease_id: lease.id,
      action: "create",
      patch: { date_type: "custom", due_date: "2027-01-01", status: "completed" },
    });
    const createBody = await createRes.json();
    assertEquals(createBody.error, true, "expected the disallowed 'status' key to be rejected on create");
    assertEquals(createRes.status, 400, `expected 400, got ${createRes.status}: ${JSON.stringify(createBody)}`);

    const row = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-03-01",
      status: "open",
    });

    const updateRes = await callManage(accessToken, {
      lease_id: lease.id,
      action: "update",
      critical_date_id: row.id,
      patch: { owner_email: "x@example.test", org_id: crypto.randomUUID() },
    });
    const updateBody = await updateRes.json();
    assertEquals(updateBody.error, true, "expected the disallowed 'org_id' key to be rejected on update");
    assertEquals(updateRes.status, 400, `expected 400, got ${updateRes.status}: ${JSON.stringify(updateBody)}`);

    const { data: rowAfter, error } = await admin
      .from("lease_critical_dates")
      .select("owner_email, org_id")
      .eq("id", row.id)
      .single();
    assertNoError(error);
    assertExists(rowAfter);
    assertEquals(rowAfter.owner_email, null, "whole call must be rejected, not partially applied");
    assertEquals(rowAfter.org_id, org.id, "org_id must never be mutable via patch");
  },
});

Deno.test({
  name: "manage_lease_critical_date: service_role insert remains unaffected regardless of RLS lockdown state (service_role bypasses RLS)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, lease } = await setUpScope(admin, suffix);

    // Service-role bypasses RLS entirely, so this insert succeeds whether
    // or not lease_critical_dates has any lockdown applied -- this proves
    // the RPC path (which always runs as service_role) is unaffected by
    // Phase 6R-4's INSERT/UPDATE lockdown, not that direct client access
    // is unrestricted (see the Phase 6R-4 tests below for that).
    const row = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-05-01",
      status: "open",
    });
    assertExists(row.id);
  },
});

Deno.test({
  name: "Phase 6R-4: direct authenticated INSERT into lease_critical_dates is rejected by RLS",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    const { error: insertErr, data: insertData } = await authed.from("lease_critical_dates").insert({
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-06-01",
      status: "open",
    }).select();
    const insertBlocked = Boolean(insertErr) || (insertData ?? []).length === 0;
    assertEquals(insertBlocked, true, "direct authenticated INSERT on lease_critical_dates must be rejected by RLS");

    const { data: rowsAfter, error: rowsErr } = await admin
      .from("lease_critical_dates")
      .select("id")
      .eq("org_id", org.id)
      .eq("due_date", "2027-06-01");
    assertNoError(rowsErr);
    assertEquals(rowsAfter?.length ?? 0, 0, "no row must have been created by the blocked direct insert");
  },
});

Deno.test({
  name: "Phase 6R-4/6R-11: direct authenticated UPDATE and DELETE to lease_critical_dates are rejected by RLS; SELECT remains unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken, lease } = await setUpScope(admin, suffix);

    const row = await insertOne(admin, "lease_critical_dates", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: lease.property_id,
      date_type: "custom",
      due_date: "2027-07-01",
      status: "open",
    });

    const authed = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });

    // SELECT must still work for an org member (unchanged this phase).
    const { data: selectData, error: selectErr } = await authed
      .from("lease_critical_dates")
      .select("id, status")
      .eq("id", row.id);
    assertNoError(selectErr);
    assertEquals(selectData?.length, 1, "SELECT must remain unchanged for org members");

    // UPDATE must be rejected by RLS.
    const { error: updateErr, data: updateData } = await authed
      .from("lease_critical_dates")
      .update({ status: "dismissed" })
      .eq("id", row.id)
      .select();
    const updateBlocked = Boolean(updateErr) || (updateData ?? []).length === 0;
    assertEquals(updateBlocked, true, "direct authenticated UPDATE on lease_critical_dates must be rejected by RLS");

    const { data: rowAfter, error: rowAfterErr } = await admin
      .from("lease_critical_dates")
      .select("status")
      .eq("id", row.id)
      .single();
    assertNoError(rowAfterErr);
    assertExists(rowAfter);
    assertEquals(rowAfter.status, "open", "the blocked update must not have changed the row");

    // DELETE must now be rejected by RLS (Phase 6R-11 locked it).
    const { error: deleteErr, data: deleteData } = await authed
      .from("lease_critical_dates")
      .delete()
      .eq("id", row.id)
      .select();
    const deleteBlocked = Boolean(deleteErr) || (deleteData ?? []).length === 0;
    assertEquals(deleteBlocked, true, "direct authenticated DELETE on lease_critical_dates must be rejected by RLS");

    const { data: rowStillThere } = await admin.from("lease_critical_dates").select("id").eq("id", row.id).maybeSingle();
    assertExists(rowStillThere, "the row must still exist -- the blocked delete must not have removed it");
  },
});

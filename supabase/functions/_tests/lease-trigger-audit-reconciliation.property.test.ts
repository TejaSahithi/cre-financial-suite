// Feature: enterprise-readiness-hardening Phase 6A-2 (lease audit-trigger
// reconciliation).
// Properties:
//   1. The initial lease INSERT (simulating the still-direct-write creation
//      path) fires tr_lease_changed's audit insert normally (action:
//      'create') -- audit coverage for unmigrated paths is untouched.
//   2. approve_lease_workflow's UPDATE produces zero trigger-duplicated
//      rows (entity_type='Lease', action='update') for the same lease --
//      only the RPC's own canonical 'lease_abstract_approved' row exists.
//   3. A later, ordinary direct UPDATE on the same lease (simulating one of
//      the ~12 still-direct-write call sites inventoried in the Phase 6D
//      plan) still produces the trigger's own audit row normally -- proves
//      the GUC is genuinely transaction-local and doesn't leak into later,
//      unrelated writes.
//   4. tr_lease_changed's notification side effect (Budget Ready) still
//      fires for that same later direct UPDATE -- only the audit insert is
//      conditionally skipped, not the trigger itself.
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

Deno.test({
  name: "lease trigger reconciliation: creation still audited by trigger, approval produces zero trigger-duplicated rows, later direct writes remain fully audited + notified",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actorEmail = `lease-trigger-reconcile-${suffix}@example.test`;

    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email: actorEmail,
      password: `Pass-${suffix}!`,
      email_confirm: true,
    });
    assertNoError(userError);
    const actorUserId = userData.user?.id;
    assertExists(actorUserId);

    const org = await insertOne(admin, "organizations", {
      name: `Lease Trigger Reconcile Org ${suffix}`,
      status: "active",
      primary_contact_email: actorEmail,
    });

    await insertOne(admin, "memberships", {
      user_id: actorUserId,
      org_id: org.id,
      role: "org_admin",
    });

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Lease Trigger Reconcile Property ${suffix}`,
      status: "active",
    });

    // --- Property 1: creation (still-direct-write path) is audited by the trigger ---
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Lease Trigger Reconcile Tenant ${suffix}`,
      start_date: "2026-01-01",
      end_date: "2030-12-31",
      status: "pending",
      abstract_status: "draft",
      abstract_version: 0,
    });

    const { data: createRows, error: createErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "create");
    assertNoError(createErr);
    assertEquals(createRows?.length, 1, "tr_lease_changed must still audit lease creation (an unmigrated write path)");

    // --- Property 2: approve_lease_workflow's UPDATE produces zero trigger-duplicated rows ---
    const idempotencyKey = `approve-trigger-reconcile-${suffix}`;
    const { data: approvalResult, error: approvalError } = await admin.rpc("approve_lease_workflow", {
      p_org_id: org.id,
      p_lease_id: lease.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
      p_signed_by: "Lease Trigger Reconcile Tester",
      p_signed_at: "2026-07-12T12:00:00.000Z",
      p_approval_comments: "Trigger reconciliation test approval",
      p_approval_document_url: "https://example.test/trigger-reconcile-lease.pdf",
      p_field_reviews: {},
      p_abstract_snapshot: { fields: { tenant_name: lease.tenant_name } },
      p_critical_dates: [],
      p_idempotency_key: idempotencyKey,
      p_request_payload: {},
    });
    assertNoError(approvalError);
    assertExists(approvalResult.audit_log_id);

    const { data: triggerUpdateRows, error: triggerUpdateErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(triggerUpdateErr);
    assertEquals(triggerUpdateRows?.length ?? 0, 0, "tr_lease_changed must not write a duplicate 'update' row for approve_lease_workflow's UPDATE");

    const { data: rpcRows, error: rpcErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_abstract_approved");
    assertNoError(rpcErr);
    assertEquals(rpcRows?.length, 1, "approve_lease_workflow must still write exactly one canonical audit row");

    // --- Property 3 + 4: a later, ordinary direct UPDATE (outside any RPC
    // transaction, GUC no longer set) still gets the trigger's own audit
    // row AND its notification side effect. ---
    const { error: directUpdateErr } = await admin
      .from("leases")
      .update({ status: "budget_ready" })
      .eq("id", lease.id);
    assertNoError(directUpdateErr);

    const { data: directUpdateAuditRows, error: directUpdateAuditErr } = await admin
      .from("audit_logs")
      .select("id")
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "update");
    assertNoError(directUpdateAuditErr);
    assertEquals(directUpdateAuditRows?.length, 1, "an ordinary direct UPDATE after the RPC call must still be audited by the trigger (GUC must not leak across transactions)");

    const { data: budgetReadyNotifications, error: notifErr } = await admin
      .from("notifications")
      .select("id, title")
      .eq("org_id", org.id)
      .eq("title", "Lease Ready for Budget");
    assertNoError(notifErr);
    assertEquals((budgetReadyNotifications?.length ?? 0) > 0, true, "tr_lease_changed's 'Lease Ready for Budget' notification must still fire for direct writes");
  },
});

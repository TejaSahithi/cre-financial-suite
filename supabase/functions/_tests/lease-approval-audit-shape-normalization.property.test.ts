// Feature: enterprise-readiness-hardening Phase 5B-2A (normalize
// approve_lease_workflow's audit_logs shape onto the canonical columns).
// Property: a lease approval writes exactly one audit_logs row, and that
// row uses actor_user_id/actor_email/severity/source/workflow_run_id/
// before/after/metadata/property_id -- not the legacy
// field_changed/old_value/new_value columns -- with the previously-legacy
// values (signed_by, signed_at, approval_comments, approval_document_url,
// abstract_version, critical_date_ids) preserved inside metadata. An
// idempotent retry must not create a second row.
import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

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
  name: "approve_lease_workflow: exactly one audit_logs row, canonical shape, idempotent retry does not duplicate",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const actorEmail = `lease-approval-audit-shape-${suffix}@example.test`;

    const { data: userData, error: userError } = await admin.auth.admin.createUser({
      email: actorEmail,
      password: `Pass-${suffix}!`,
      email_confirm: true,
    });
    assertNoError(userError);
    const actorUserId = userData.user?.id;
    assertExists(actorUserId);

    const org = await insertOne(admin, "organizations", {
      name: `Lease Approval Audit Shape Org ${suffix}`,
      status: "active",
      primary_contact_email: actorEmail,
    });

    await admin.from("profiles").upsert({
      id: actorUserId,
      email: actorEmail,
      full_name: "Lease Approval Audit Shape Tester",
      role: "user",
      status: "active",
    });

    await insertOne(admin, "memberships", {
      user_id: actorUserId,
      org_id: org.id,
      role: "org_admin",
    });

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Lease Approval Audit Shape Property ${suffix}`,
      status: "active",
    });

    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Tenant ${suffix}`,
      start_date: "2026-01-01",
      end_date: "2030-12-31",
      status: "pending",
      abstract_status: "draft",
      abstract_version: 0,
    });

    const idempotencyKey = `approve-audit-shape-${suffix}`;
    const approvalPayload = {
      lease_id: lease.id,
      signed_by: "Lease Approval Audit Shape Tester",
      signed_at: "2026-07-07T12:00:00.000Z",
      approval_comments: "Audit shape normalization test approval",
      approval_document_url: "https://example.test/audit-shape-lease.pdf",
      field_reviews: {},
      idempotency_key: idempotencyKey,
    };

    const callApprove = () =>
      admin.rpc("approve_lease_workflow", {
        p_org_id: org.id,
        p_lease_id: lease.id,
        p_actor_user_id: actorUserId,
        p_actor_email: actorEmail,
        p_signed_by: approvalPayload.signed_by,
        p_signed_at: approvalPayload.signed_at,
        p_approval_comments: approvalPayload.approval_comments,
        p_approval_document_url: approvalPayload.approval_document_url,
        p_field_reviews: approvalPayload.field_reviews,
        p_abstract_snapshot: { fields: { tenant_name: lease.tenant_name } },
        p_critical_dates: [
          {
            date_type: "lease_expiration",
            due_date: "2030-12-31",
            status: "open",
            reminder_days_before: 180,
            source: "audit_shape_test",
          },
        ],
        p_idempotency_key: idempotencyKey,
        p_request_payload: approvalPayload,
      });

    const { data: approvalResult, error: approvalError } = await callApprove();
    assertNoError(approvalError);
    assertEquals(approvalResult.already_approved, false);
    assertExists(approvalResult.audit_log_id);
    assertExists(approvalResult.workflow_run_id);

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("*")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_abstract_approved");
    assertNoError(auditError);
    assertExists(auditRows);
    assertEquals(auditRows!.length, 1, "lease approval must write exactly one audit_logs row");

    const row = auditRows![0];
    assertEquals(row.id, approvalResult.audit_log_id);
    assertEquals(row.actor_user_id, actorUserId);
    assertEquals(row.actor_email, actorEmail);
    assertEquals(row.severity, "info");
    assertEquals(row.source, "edge_function");
    assertEquals(row.workflow_run_id, approvalResult.workflow_run_id);
    assertEquals(row.property_id, property.id);

    // Canonical before/after replace the legacy old_value/new_value columns.
    assertExists(row.before, "audit row must capture the pre-approval lease state in `before`");
    assertEquals(row.before.status, "pending");
    assertExists(row.after, "audit row must capture the post-approval lease state in `after`");
    assertEquals(row.after.status, "approved");
    assertEquals(row.after.abstract_status, "approved");

    // Legacy columns are no longer populated by this RPC.
    assertEquals(row.field_changed, null);
    assertEquals(row.old_value, null);
    assertEquals(row.new_value, null);

    // Previously-legacy values preserved inside metadata.
    assertEquals(row.metadata.signed_by, approvalPayload.signed_by);
    assertEquals(new Date(row.metadata.signed_at).getTime(), new Date(approvalPayload.signed_at).getTime());
    assertEquals(row.metadata.approval_comments, approvalPayload.approval_comments);
    assertEquals(row.metadata.approval_document_url, approvalPayload.approval_document_url);
    assertEquals(row.metadata.abstract_version, 1);
    assertEquals(row.metadata.critical_date_ids.length, approvalResult.critical_date_ids.length);
    assertEquals(row.metadata.workflow_run_id, approvalResult.workflow_run_id);
    assertEquals(row.metadata.idempotency_key, idempotencyKey);

    // Idempotent retry must not create a second audit row.
    const { data: retryResult, error: retryError } = await callApprove();
    assertNoError(retryError);
    assertEquals(retryResult.workflow_run_id, approvalResult.workflow_run_id);

    const { data: auditRowsAfterRetry, error: auditRetryError } = await admin
      .from("audit_logs")
      .select("id")
      .eq("org_id", org.id)
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "lease_abstract_approved");
    assertNoError(auditRetryError);
    assertEquals(auditRowsAfterRetry!.length, 1, "idempotent retry must not duplicate the audit_logs row");
  },
});

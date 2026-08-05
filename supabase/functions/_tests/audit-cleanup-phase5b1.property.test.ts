// Feature: enterprise-readiness-hardening Phase 5B-1 (audit cleanup + destructive-action hardening)
// Properties:
//   1. (Retired) HTTP compute-cam creating exactly one audit_logs row per
//      computation was covered here; compute-cam is now a permanent HTTP 410
//      stub (see supabase/functions/compute-cam/index.ts) with all CAM
//      calculation handled by run-cam-calculation-v2, so this property no
//      longer applies and its test was removed rather than left permanently
//      failing against a retired endpoint.
//   2. HTTP send-expense-classification-to-cam (the edge function, not the
//      raw RPC) creates exactly one audit_logs row total for the
//      classification — proves the edge function's now-removed second
//      insert ("expense_classification_sent_to_cam") is gone; only the
//      RPC's own in-transaction insert ("send_expense_classification_to_cam")
//      remains.
//   3. delete_lease_cascade reliably writes an audit_logs row for the delete
//      in the same transaction as the cascade itself.
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

async function setUpOrgAndUser(admin: ReturnType<typeof adminClient>, suffix: string) {
  const actorEmail = `audit-cleanup-${suffix}@example.test`;
  const password = `Pass-${suffix}!`;

  const { data: userData, error: userError } = await admin.auth.admin.createUser({
    email: actorEmail,
    password,
    email_confirm: true,
  });
  assertNoError(userError);
  const actorUserId = userData.user?.id;
  assertExists(actorUserId);

  const org = await insertOne(admin, "organizations", {
    name: `Audit Cleanup Org ${suffix}`,
    status: "active",
    primary_contact_email: actorEmail,
  });

  await admin.from("profiles").upsert({
    id: actorUserId,
    email: actorEmail,
    full_name: "Audit Cleanup Tester",
    role: "org_admin",
    status: "active",
  });

  await insertOne(admin, "memberships", {
    user_id: actorUserId,
    org_id: org.id,
    role: "org_admin",
  });

  const anon = createClient(SUPABASE_URL, ANON_KEY);
  const { data: signInData, error: signInError } = await anon.auth.signInWithPassword({
    email: actorEmail,
    password,
  });
  assertNoError(signInError);
  const accessToken = signInData.session?.access_token;
  assertExists(accessToken);

  return { org, actorUserId, actorEmail, accessToken };
}

function callFn(fnName: string, accessToken: string, body: Record<string, unknown>) {
  return fetch(`${SUPABASE_URL}/functions/v1/${fnName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
      "apikey": ANON_KEY,
    },
    body: JSON.stringify(body),
  });
}

Deno.test({
  name: "HTTP send-expense-classification-to-cam: exactly one audit_logs row total for the classification (edge-function duplicate removed)",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Audit Cleanup Expense Property ${suffix}`,
      status: "active",
    });

    const expense = await insertOne(admin, "expenses", {
      org_id: org.id,
      property_id: property.id,
      category: "CAM",
      amount: 1500,
      // CAM publication boundary hardening (20260905000000_cam_publication_rpcs.sql):
      // send_expense_classification_to_cam_workflow now requires the linked
      // expense to be approved.
      approval_status: "approved",
    });

    const classification = await insertOne(admin, "expense_classifications", {
      org_id: org.id,
      property_id: property.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      cam_status: "needs_review",
      approved_status: "draft",
      // Same hardening: the classification must be finalized before it can
      // be sent to CAM.
      classification_status: "finalized",
      amount: 1500,
      classification_key: `${org.id}:${expense.id}:manual`,
    });

    const sendRes = await callFn("send-expense-classification-to-cam", accessToken, {
      classification_id: classification.id,
      reason: "Manual send for audit-cleanup test",
      idempotency_key: `audit-cleanup-send-${suffix}`,
    });
    const sendBody = await sendRes.json();
    assertEquals(sendRes.status, 200, `expected send-expense-classification-to-cam to succeed: ${JSON.stringify(sendBody)}`);

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("id, action")
      .eq("org_id", org.id)
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id);
    assertNoError(auditError);
    assertEquals(auditRows?.length, 1, "sending an expense classification to CAM must write exactly one audit_logs row total, not one from the RPC plus a second from the edge function");
    assertEquals(auditRows?.[0]?.action, "send_expense_classification_to_cam");
  },
});

Deno.test({
  name: "delete_lease_cascade: writes an audit_logs row reliably in the same transaction as the delete",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, actorUserId, actorEmail } = await setUpOrgAndUser(admin, suffix);

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Audit Cleanup Lease Property ${suffix}`,
      status: "active",
    });

    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Audit Cleanup Tenant ${suffix}`,
      start_date: "2026-01-01",
      end_date: "2027-01-01",
      status: "pending",
      abstract_version: 0,
    });

    const { error: deleteError } = await admin.rpc("delete_lease_cascade", {
      target_lease_id: lease.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
    });
    assertNoError(deleteError);

    const { data: remainingLease } = await admin.from("leases").select("id").eq("id", lease.id).maybeSingle();
    assertEquals(remainingLease, null, "lease must actually be deleted");

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("id, action, actor_user_id, actor_email, org_id")
      .eq("entity_type", "Lease")
      .eq("entity_id", lease.id)
      .eq("action", "delete");
    assertNoError(auditError);
    assertEquals(auditRows?.length, 1, "delete_lease_cascade must write exactly one audit_logs row for the delete");
    assertEquals(auditRows?.[0]?.actor_user_id, actorUserId);
    assertEquals(auditRows?.[0]?.actor_email, actorEmail);
    assertEquals(auditRows?.[0]?.org_id, org.id);
  },
});

// Feature: enterprise-readiness-hardening Phase 5B-1 (audit cleanup + destructive-action hardening)
// Properties:
//   1. HTTP compute-cam creates exactly one audit_logs row for a computation
//      (the frontend's own duplicate "cam_compute" entry was removed from
//      CAMCalculation.jsx — this proves the backend side was, and remains,
//      exactly one row).
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
  name: "HTTP compute-cam: exactly one audit_logs row per computation",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const admin = adminClient();
    const suffix = crypto.randomUUID();
    const { org, accessToken } = await setUpOrgAndUser(admin, suffix);
    const fiscalYear = 2026;

    const property = await insertOne(admin, "properties", {
      org_id: org.id,
      name: `Audit Cleanup CAM Property ${suffix}`,
      status: "active",
      total_sqft: 10000,
    });

    // compute-cam requires at least one approved/budget-ready lease in scope.
    const lease = await insertOne(admin, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_name: `Audit Cleanup CAM Tenant ${suffix}`,
      start_date: "2026-01-01",
      end_date: "2027-01-01",
      status: "active",
      square_footage: 2000,
      abstract_version: 1,
    });

    // compute-cam also requires, for the scoped approved lease, at least one
    // approved + published CAM child rule (or a CAM-ready recoverable
    // expense) — otherwise it rejects with "No CAM-ready classifications,
    // CAM input rows, or approved published CAM lease rules found for this
    // scope" (see supabase/functions/compute-cam/index.ts:776-782). Mirrors
    // the fixture in finance-chain-integration.test.ts.
    const category = await insertOne(admin, "expense_categories", {
      org_id: org.id,
      category_name: `Audit Cleanup CAM Category ${suffix}`,
      normalized_key: `audit_cleanup_cam_${suffix.replace(/-/g, "_")}`,
      is_active: true,
    });

    const ruleSet = await insertOne(admin, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      status: "approved",
    });

    await insertOne(admin, "lease_expense_rules", {
      org_id: org.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      lease_id: lease.id,
      property_id: property.id,
      expense_category: `Audit Cleanup CAM Category ${suffix}`,
      row_status: "mapped",
      review_status: "approved",
      approval_status: "approved",
      is_recoverable: true,
      recoverable_from_tenant: true,
      cam_eligible: "yes",
      is_excluded: false,
      published_to_cam: true,
      payment_treatment: "reimbursable",
      recovery_method: "pro_rata",
      allocation_basis: "square_footage",
    });

    const computeRes = await callFn("compute-cam", accessToken, {
      property_id: property.id,
      fiscal_year: fiscalYear,
    });
    const computeBody = await computeRes.json();
    assertEquals(computeRes.status, 200, `expected compute-cam to succeed: ${JSON.stringify(computeBody)}`);

    const { data: auditRows, error: auditError } = await admin
      .from("audit_logs")
      .select("id, action")
      .eq("org_id", org.id)
      .eq("property_id", property.id)
      .eq("action", "cam_computed");
    assertNoError(auditError);
    assertEquals(auditRows?.length, 1, "compute-cam must write exactly one audit_logs row per computation");
  },
});

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

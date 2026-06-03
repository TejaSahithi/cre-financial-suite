import {
  assert,
  assertEquals,
  assertExists,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "http://127.0.0.1:54321";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

function adminClient() {
  return createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function assertNoError(error: unknown) {
  if (error) {
    const details = error as { message?: string; name?: string; status?: number; code?: string; details?: unknown; hint?: unknown };
    const message = details?.message
      ? JSON.stringify({
        name: details.name,
        status: details.status,
        code: details.code,
        message: details.message,
        details: details.details,
        hint: details.hint,
      })
      : JSON.stringify(error);
    throw new Error(message);
  }
}

async function insertOne(client: ReturnType<typeof adminClient>, table: string, values: Record<string, unknown>) {
  const { data, error } = await client.from(table).insert(values).select("*").single();
  assertNoError(error);
  assertExists(data);
  return data;
}

Deno.test({
  name: "DB finance chain: approve lease then send approved expense classification to CAM idempotently",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const supabase = adminClient();
    const suffix = crypto.randomUUID();
    const actorEmail = `finance-chain-${suffix}@example.test`;

    const { data: userData, error: userError } = await supabase.auth.admin.createUser({
      email: actorEmail,
      password: `Pass-${suffix}!`,
      email_confirm: true,
    });
    assertNoError(userError);
    const actorUserId = userData.user?.id;
    assertExists(actorUserId);

    const org = await insertOne(supabase, "organizations", {
      name: `Finance Chain Org ${suffix}`,
      status: "active",
      primary_contact_email: actorEmail,
    });

    const otherOrg = await insertOne(supabase, "organizations", {
      name: `Finance Chain Other Org ${suffix}`,
      status: "active",
      primary_contact_email: `other-${actorEmail}`,
    });

    await supabase.from("profiles").upsert({
      id: actorUserId,
      email: actorEmail,
      full_name: "Finance Chain Tester",
      role: "user",
      status: "active",
    });

    await insertOne(supabase, "memberships", {
      user_id: actorUserId,
      org_id: org.id,
      role: "org_admin",
    });

    const property = await insertOne(supabase, "properties", {
      org_id: org.id,
      name: `Finance Chain Property ${suffix}`,
      status: "active",
    });

    const tenant = await insertOne(supabase, "tenants", {
      org_id: org.id,
      name: `Tenant ${suffix}`,
      email: `tenant-${actorEmail}`,
      status: "active",
    });

    const lease = await insertOne(supabase, "leases", {
      org_id: org.id,
      property_id: property.id,
      tenant_id: tenant.id,
      tenant_name: tenant.name,
      start_date: "2026-01-01",
      end_date: "2030-12-31",
      status: "pending",
      monthly_rent: 10000,
      square_footage: 2500,
      abstract_status: "draft",
      abstract_version: 0,
    });

    const approvalIdempotencyKey = `approve-${suffix}`;
    const approvalPayload = {
      lease_id: lease.id,
      signed_by: "Finance Chain Tester",
      signed_at: "2026-06-03T12:00:00.000Z",
      approval_comments: "Integration approval",
      approval_document_url: "https://example.test/approved-lease.pdf",
      field_reviews: {
        start_date: {
          status: "accepted",
          value: "2026-01-01",
          raw_value: "January 1, 2026",
          reviewer: "Finance Chain Tester",
        },
      },
      idempotency_key: approvalIdempotencyKey,
    };

    const { data: approvalResult, error: approvalError } = await supabase.rpc("approve_lease_workflow", {
      p_org_id: org.id,
      p_lease_id: lease.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
      p_signed_by: approvalPayload.signed_by,
      p_signed_at: approvalPayload.signed_at,
      p_approval_comments: approvalPayload.approval_comments,
      p_approval_document_url: approvalPayload.approval_document_url,
      p_field_reviews: approvalPayload.field_reviews,
      p_abstract_snapshot: {
        fields: {
          start_date: "2026-01-01",
          tenant_name: tenant.name,
        },
      },
      p_critical_dates: [
        {
          date_type: "lease_expiration",
          due_date: "2030-12-31",
          status: "open",
          reminder_days_before: 180,
          source: "integration_test",
        },
      ],
      p_idempotency_key: approvalIdempotencyKey,
      p_request_payload: approvalPayload,
    });
    assertNoError(approvalError);
    assertEquals(approvalResult.already_approved, false);
    assertExists(approvalResult.workflow_run_id);
    assertExists(approvalResult.audit_log_id);

    const { data: approvalRetry, error: approvalRetryError } = await supabase.rpc("approve_lease_workflow", {
      p_org_id: org.id,
      p_lease_id: lease.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
      p_signed_by: approvalPayload.signed_by,
      p_signed_at: approvalPayload.signed_at,
      p_approval_comments: approvalPayload.approval_comments,
      p_approval_document_url: approvalPayload.approval_document_url,
      p_field_reviews: approvalPayload.field_reviews,
      p_abstract_snapshot: {
        fields: {
          start_date: "2026-01-01",
          tenant_name: tenant.name,
        },
      },
      p_critical_dates: [],
      p_idempotency_key: approvalIdempotencyKey,
      p_request_payload: approvalPayload,
    });
    assertNoError(approvalRetryError);
    assertEquals(approvalRetry.workflow_run_id, approvalResult.workflow_run_id);

    const { data: approvedLease, error: approvedLeaseError } = await supabase
      .from("leases")
      .select("status, abstract_status, abstract_version, abstract_snapshot")
      .eq("id", lease.id)
      .single();
    assertNoError(approvedLeaseError);
    assertExists(approvedLease);
    assertEquals(approvedLease.status, "approved");
    assertEquals(approvedLease.abstract_status, "approved");
    assertEquals(approvedLease.abstract_version, 1);

    const { data: approvalRuns, error: approvalRunsError } = await supabase
      .from("lease_approval_workflow_runs")
      .select("id,status,response_payload")
      .eq("org_id", org.id)
      .eq("idempotency_key", approvalIdempotencyKey);
    assertNoError(approvalRunsError);
    assertExists(approvalRuns);
    assertEquals(approvalRuns.length, 1);
    assertEquals(approvalRuns[0].status, "completed");

    const { data: approvalAudit, error: approvalAuditError } = await supabase
      .from("audit_logs")
      .select("id,source,action,metadata")
      .eq("id", approvalResult.audit_log_id)
      .single();
    assertNoError(approvalAuditError);
    assertExists(approvalAudit);
    assertEquals(approvalAudit.source, "edge_function");
    assertEquals(approvalAudit.action, "lease_abstract_approved");

    const category = await insertOne(supabase, "expense_categories", {
      org_id: org.id,
      category_name: "Repairs and Maintenance",
      subcategory_name: "HVAC",
      normalized_key: `repairs_hvac_${suffix}`,
      is_active: true,
    });

    const ruleSet = await insertOne(supabase, "lease_expense_rule_sets", {
      org_id: org.id,
      lease_id: lease.id,
      property_id: property.id,
      status: "approved",
      approved_by: actorUserId,
      approved_at: "2026-06-03T12:05:00.000Z",
    });

    const rule = await insertOne(supabase, "lease_expense_rules", {
      org_id: org.id,
      rule_set_id: ruleSet.id,
      expense_category_id: category.id,
      lease_id: lease.id,
      property_id: property.id,
      tenant_id: tenant.id,
      rule_key: `hvac-${suffix}`,
      expense_category: "Repairs and Maintenance",
      expense_subcategory: "HVAC",
      row_status: "mapped",
      review_status: "approved",
      approval_status: "approved",
      approved_by: actorUserId,
      approved_at: "2026-06-03T12:06:00.000Z",
      is_recoverable: true,
      recoverable_from_tenant: true,
      is_excluded: false,
      published_to_cam: true,
      payment_treatment: "reimbursable",
      recovery_method: "pro_rata",
      allocation_basis: "square_footage",
    });

    const expense = await insertOne(supabase, "expenses", {
      org_id: org.id,
      property_id: property.id,
      lease_id: lease.id,
      tenant_id: tenant.id,
      category: "Repairs and Maintenance",
      amount: 1250,
      fiscal_year: 2026,
      date: "2026-04-15",
      service_period_start: "2026-04-01",
      service_period_end: "2026-04-30",
      approved_status: "approved",
      review_status: "approved",
      recovery_status: "recoverable",
      recovery_rule_id: rule.id,
    });

    const classification = await insertOne(supabase, "expense_classifications", {
      org_id: org.id,
      expense_id: expense.id,
      actual_expense_id: expense.id,
      lease_expense_rule_id: rule.id,
      recovery_rule_id: rule.id,
      rule_set_id: ruleSet.id,
      property_id: property.id,
      lease_id: lease.id,
      tenant_id: tenant.id,
      category: "Repairs and Maintenance",
      subcategory: "HVAC",
      amount: 1250,
      service_period_start: "2026-04-01",
      service_period_end: "2026-04-30",
      recovery_status: "recoverable",
      recoverability_result: "recoverable",
      cam_eligible: "yes",
      recovery_method: "pro_rata",
      allocation_basis: "square_footage",
      approved_status: "approved",
      classification_status: "finalized",
      sent_to_cam: false,
      row_type: "matched_classification",
      classification_key: `${org.id}:${expense.id}:${rule.id}`,
    });

    const camIdempotencyKey = `send-cam-${suffix}`;
    const camPayload = {
      classification_id: classification.id,
      reason: null,
    };

    const { data: camResult, error: camError } = await supabase.rpc("send_expense_classification_to_cam_workflow", {
      p_org_id: org.id,
      p_classification_id: classification.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
      p_reason: null,
      p_idempotency_key: camIdempotencyKey,
      p_request_payload: camPayload,
    });
    assertNoError(camError);
    assertEquals(camResult.already_sent, false);
    assertExists(camResult.workflow_run_id);
    assertExists(camResult.audit_log_id);
    assertExists(camResult.cam_input_id);

    const { data: camRetry, error: camRetryError } = await supabase.rpc("send_expense_classification_to_cam_workflow", {
      p_org_id: org.id,
      p_classification_id: classification.id,
      p_actor_user_id: actorUserId,
      p_actor_email: actorEmail,
      p_reason: null,
      p_idempotency_key: camIdempotencyKey,
      p_request_payload: camPayload,
    });
    assertNoError(camRetryError);
    assertEquals(camRetry.workflow_run_id, camResult.workflow_run_id);
    assertEquals(camRetry.cam_input_id, camResult.cam_input_id);

    const { data: sentClassification, error: sentClassificationError } = await supabase
      .from("expense_classifications")
      .select("sent_to_cam, cam_status, sent_to_cam_at")
      .eq("id", classification.id)
      .single();
    assertNoError(sentClassificationError);
    assertExists(sentClassification);
    assertEquals(sentClassification.sent_to_cam, true);
    assertEquals(sentClassification.cam_status, "cam_ready");
    assert(sentClassification.sent_to_cam_at);

    const { data: camInputs, error: camInputsError } = await supabase
      .from("cam_expense_inputs")
      .select("id,status,amount,classification_result_id")
      .eq("classification_result_id", classification.id);
    assertNoError(camInputsError);
    assertExists(camInputs);
    assertEquals(camInputs.length, 1);
    assertEquals(camInputs[0].id, camResult.cam_input_id);
    assertEquals(Number(camInputs[0].amount), 1250);
    assertEquals(camInputs[0].status, "cam_ready");

    const { data: camRuns, error: camRunsError } = await supabase
      .from("expense_classification_cam_send_runs")
      .select("id,status,response_payload")
      .eq("org_id", org.id)
      .eq("idempotency_key", camIdempotencyKey);
    assertNoError(camRunsError);
    assertExists(camRuns);
    assertEquals(camRuns.length, 1);
    assertEquals(camRuns[0].status, "completed");

    const { data: camAudit, error: camAuditError } = await supabase
      .from("audit_logs")
      .select("id,source,action,workflow_run_id")
      .eq("id", camResult.audit_log_id)
      .single();
    assertNoError(camAuditError);
    assertExists(camAudit);
    assertEquals(camAudit.source, "edge_function");
    assertEquals(camAudit.action, "send_expense_classification_to_cam");
    assertEquals(camAudit.workflow_run_id, camResult.workflow_run_id);

    const { count: camAuditCount, error: camAuditCountError } = await supabase
      .from("audit_logs")
      .select("id", { count: "exact", head: true })
      .eq("entity_type", "ExpenseClassification")
      .eq("entity_id", classification.id)
      .eq("action", "send_expense_classification_to_cam");
    assertNoError(camAuditCountError);
    assertEquals(camAuditCount, 1);

    await assertRejects(
      async () => {
        const { error } = await supabase.rpc("send_expense_classification_to_cam_workflow", {
          p_org_id: otherOrg.id,
          p_classification_id: classification.id,
          p_actor_user_id: actorUserId,
          p_actor_email: actorEmail,
          p_reason: null,
          p_idempotency_key: `cross-org-${suffix}`,
          p_request_payload: {
            classification_id: classification.id,
            reason: null,
          },
        });
        if (error) throw new Error(error.message);
      },
      Error,
      "Expense classification not found for this organization",
    );

  },
});

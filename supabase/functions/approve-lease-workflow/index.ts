// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import {
  buildAbstractSnapshot,
  buildCriticalDateRows,
  generateApprovedRentSchedule,
  materializeApprovedLeaseObligations,
  validateApprovalPayload,
} from "../_shared/lease-approval-workflow.ts";
import { publishApprovedLeaseExpenseArtifacts } from "../_shared/approved-lease-expense-rules.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["LeaseReview", "Leases"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validateApprovalPayload(body);

    const { data: lease, error: leaseError } = await supabaseAdmin
      .from("leases")
      .select("*")
      .eq("id", payload.leaseId)
      .eq("org_id", orgId)
      .single();

    if (leaseError || !lease) {
      return jsonResponse({
        error: true,
        message: "Lease not found for this organization",
        error_code: "LEASE_NOT_FOUND",
      }, 404);
    }

    const nextVersion = Number(lease.abstract_version || 0) + 1;
    const approvedAt = new Date().toISOString();
    const abstractSnapshot = buildAbstractSnapshot({
      lease,
      fieldReviews: payload.fieldReviews,
      version: nextVersion,
      approvedBy: payload.signedBy,
      approvedAt,
    });
    const approvedLeasePreview = {
      ...lease,
      status: "approved",
      signed_by: payload.signedBy,
      signed_at: payload.signedAt,
      approval_comments: payload.approvalComments,
      approval_document_url: payload.approvalDocumentUrl,
      abstract_status: "approved",
      abstract_version: nextVersion,
      abstract_approved_at: approvedAt,
      abstract_approved_by: payload.signedBy,
      abstract_snapshot: abstractSnapshot,
      extraction_data: {
        ...(lease.extraction_data || {}),
        field_reviews: payload.fieldReviews,
        abstract: {
          approved_at: approvedAt,
          approved_by: payload.signedBy,
          version: nextVersion,
        },
      },
      extracted_fields: abstractSnapshot.fields,
    };
    const criticalDates = buildCriticalDateRows(approvedLeasePreview);

    const requestPayload = {
      lease_id: payload.leaseId,
      signed_by: payload.signedBy,
      signed_at: payload.signedAt,
      approval_comments: payload.approvalComments,
      approval_document_url: payload.approvalDocumentUrl,
      field_review_count: Object.keys(payload.fieldReviews || {}).length,
    };

    const { data, error } = await supabaseAdmin.rpc("approve_lease_workflow", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_signed_by: payload.signedBy,
      p_signed_at: payload.signedAt,
      p_approval_comments: payload.approvalComments,
      p_approval_document_url: payload.approvalDocumentUrl,
      p_field_reviews: payload.fieldReviews,
      p_abstract_snapshot: abstractSnapshot,
      p_critical_dates: criticalDates,
      p_idempotency_key: payload.idempotencyKey,
      p_request_payload: requestPayload,
    });

    if (error) {
      throw new Error(error.message || "approve_lease_workflow failed");
    }

    if (data?.already_approved && criticalDates.length > 0) {
      const { error: criticalDateBackfillError } = await supabaseAdmin
        .from("lease_critical_dates")
        .upsert(criticalDates, {
          onConflict: "lease_id,date_type,due_date",
          ignoreDuplicates: true,
        });
      if (criticalDateBackfillError) {
        console.warn(
          `[approve-lease-workflow] already-approved critical-date backfill skipped: ${criticalDateBackfillError.message}`,
        );
      }
    }

    // Publish lease-derived expense/CAM artifacts only after the approval RPC
    // has committed. The publisher materializes the exact LLM expense-rule
    // candidates captured during extraction; it does not run another model
    // call or reinterpret fields with TypeScript. Publication failure does
    // not roll back the approved abstract, but it is returned to the UI as
    // an explicit retryable status.
    let expenseRuleSync: Record<string, unknown>;
    try {
      expenseRuleSync = await publishApprovedLeaseExpenseArtifacts({
        supabaseAdmin,
        orgId,
        lease: data?.lease || approvedLeasePreview,
        actorUserId: user.id,
        actorEmail: user.email || null,
      });
    } catch (expenseRuleError) {
      console.error(
        `[approve-lease-workflow] approved expense-rule publication failed: ${expenseRuleError?.message || expenseRuleError}`,
      );
      expenseRuleSync = {
        status: "failed",
        lease_id: payload.leaseId,
        rules_persisted: 0,
        retryable: true,
        message: expenseRuleError?.message || "Approved expense-rule publication failed",
      };
    }

    // Generate the approved rent schedule synchronously, in the same request,
    // instead of relying on the client to fire-and-forget a compute-lease
    // call after redirecting. Reuses compute-lease's existing
    // ensureApprovedRentSchedules (delete+regenerate rows when
    // abstract_version changed) rather than duplicating that logic here.
    // A failure here does not roll back the approval that already committed
    // above — it's surfaced in the response so the UI can show a retry state.
    const rentSchedule = await generateApprovedRentSchedule({
      orgId,
      leaseId: payload.leaseId,
      req,
    });

    const obligationSync = await materializeApprovedLeaseObligations({
      supabaseAdmin,
      orgId,
      lease: data?.lease || approvedLeasePreview,
      criticalDates,
    });

    return jsonResponse({
      error: false,
      ...data,
      rent_schedule: rentSchedule,
      expense_rule_sync: expenseRuleSync,
      obligation_sync: obligationSync,
    });
  } catch (err) {
    const message = err?.message || "Lease approval workflow failed";
    const status = /unauthorized|missing authorization/i.test(message)
      ? 401
      : /access denied|permission/i.test(message)
        ? 403
        : /conflict|cannot be negative|must be after|positive whole number/i.test(message)
          ? 409
        : /required|valid date|idempotency/i.test(message)
          ? 400
          : 500;

    return jsonResponse({
      error: true,
      message,
      error_code: "LEASE_APPROVAL_WORKFLOW_FAILED",
    }, status);
  }
});

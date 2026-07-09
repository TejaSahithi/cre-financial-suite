// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_ACTIONS = new Set(["finalize", "reopen", "approve", "reject", "mark_na", "resolve"]);
const VALID_RECOVERY_STATUSES = new Set(["recoverable", "non_recoverable", "conditional", "excluded"]);
const VALID_APPROVED_STATUSES = new Set(["approved", "needs_review", "rejected"]);

function validatePayload(body: Record<string, unknown> = {}) {
  const classificationId = String(body.classification_id || "").trim();
  if (!UUID_RE.test(classificationId)) {
    throw new Error("classification_id is required");
  }

  const action = String(body.action || "").trim().toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error("action must be one of finalize, reopen, approve, reject, mark_na, resolve");
  }

  let recoveryStatus = null;
  if (action === "finalize" || action === "approve") {
    recoveryStatus = String(body.recovery_status || "").trim().toLowerCase();
    if (!VALID_RECOVERY_STATUSES.has(recoveryStatus)) {
      throw new Error("recovery_status must be one of recoverable, non_recoverable, conditional, excluded");
    }
  }

  let approvedStatus = null;
  if (action === "approve") {
    approvedStatus = String(body.approved_status || "").trim().toLowerCase();
    if (!VALID_APPROVED_STATUSES.has(approvedStatus)) {
      throw new Error("approved_status must be one of approved, needs_review, rejected");
    }
  }

  return { classificationId, action, recoveryStatus, approvedStatus };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|action must be|recovery_status must be|approved_status must be/i.test(message)) return 400;
  return 500;
}

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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification", "ExpenseReview"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("review_expense_classification", {
      p_org_id: orgId,
      p_classification_id: payload.classificationId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_action: payload.action,
      p_recovery_status: payload.recoveryStatus,
      p_approved_status: payload.approvedStatus,
    });

    if (error) {
      throw new Error(error.message || "review_expense_classification failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not review expense classification";
    return jsonResponse({
      error: true,
      message,
      error_code: "REVIEW_EXPENSE_CLASSIFICATION_FAILED",
    }, errorStatus(message));
  }
});

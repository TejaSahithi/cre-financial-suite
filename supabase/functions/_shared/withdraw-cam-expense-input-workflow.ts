// @ts-nocheck
import { corsHeaders } from "./cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "./supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission|organization|outside/i.test(message)) return 403;
  if (/required|reason|no active published/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  return 500;
}

/**
 * Withdraws an active published cam_expense_inputs row for a classification
 * (see withdraw_cam_expense_input, 20260905000000_cam_publication_rpcs.sql).
 * The RPC itself: marks the input 'withdrawn' (never deleted), returns the
 * classification to review, and marks affected CAM computation_snapshots
 * stale (unlocked) or restatement_required (locked, left immutable).
 */
export async function handleWithdrawCamExpenseInputRequest(req: Request) {
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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification", "ExpenseReview", "CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const classificationId = String(body.classification_id || body.classificationId || "").trim();
    const reason = String(body.reason || "").trim();

    if (!UUID_RE.test(classificationId)) {
      return jsonResponse({ error: true, message: "classification_id is required", error_code: "CLASSIFICATION_ID_REQUIRED" }, 400);
    }
    if (!reason) {
      return jsonResponse({ error: true, message: "A reason is required to withdraw a published CAM input", error_code: "REASON_REQUIRED" }, 400);
    }

    const { data, error } = await supabaseAdmin.rpc("withdraw_cam_expense_input", {
      p_org_id: orgId,
      p_classification_id: classificationId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_reason: reason,
    });

    if (error) {
      throw new Error(error.message || "withdraw_cam_expense_input failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Withdraw CAM expense input workflow failed";
    return jsonResponse({
      error: true,
      message,
      error_code: "WITHDRAW_CAM_EXPENSE_INPUT_WORKFLOW_FAILED",
    }, errorStatus(message));
  }
}

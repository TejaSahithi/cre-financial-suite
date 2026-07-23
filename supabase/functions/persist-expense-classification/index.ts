// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const expenseId = String(body.expense_id || "").trim();
  if (!UUID_RE.test(expenseId)) {
    throw new Error("expense_id is required");
  }

  const linkedExpenseRuleIdRaw = String(
    body.linked_expense_rule_id || body.lease_expense_rule_id || body.recovery_rule_id || "",
  ).trim();
  const linkedExpenseRuleId = UUID_RE.test(linkedExpenseRuleIdRaw) ? linkedExpenseRuleIdRaw : null;

  const recoveryStatus = body.recovery_status == null ? null : String(body.recovery_status);
  const recoverabilityResult = body.recoverability_result == null ? null : String(body.recoverability_result);
  const camEligible = body.cam_eligible == null ? null : String(body.cam_eligible);
  const camStatus = body.cam_status == null ? null : String(body.cam_status);
  const sentToCam = Boolean(body.sent_to_cam);

  // Phase 6X-1: optional paired write to the expenses table, in the same
  // transaction as the classification upsert. Only forwarded if present —
  // the RPC itself enforces the field whitelist (defense in depth, not the
  // sole check).
  const expensePatchRaw = body.expense_patch;
  if (expensePatchRaw != null && (typeof expensePatchRaw !== "object" || Array.isArray(expensePatchRaw))) {
    throw new Error("expense_patch must be an object");
  }
  const expensePatch = expensePatchRaw && typeof expensePatchRaw === "object" ? expensePatchRaw : null;

  // Everything else the client computed (category, amount, evidence, amount
  // buckets, etc.) is passed through as an opaque patch — the RPC does not
  // re-validate these; only the CAM/recoverability consistency fields above
  // are gated. See docs/server-owned-workflow-pattern.md.
  const patch = { ...body };
  delete patch.expense_id;
  delete patch.linked_expense_rule_id;
  delete patch.lease_expense_rule_id;
  delete patch.recovery_rule_id;
  delete patch.recovery_status;
  delete patch.recoverability_result;
  delete patch.cam_eligible;
  delete patch.cam_status;
  delete patch.sent_to_cam;
  delete patch.expense_patch;

  return { expenseId, linkedExpenseRuleId, recoveryStatus, recoverabilityResult, camEligible, camStatus, sentToCam, patch, expensePatch };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/classification rejected|required|not found|is not permitted|must be an object/i.test(message)) return 400;
  return 500;
}

function parseBlockers(message: string): string[] {
  const match = message.match(/Classification rejected: (.+)$/);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification", "ExpenseReview", "Expenses"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    let { data, error } = await supabaseAdmin.rpc("persist_expense_classification", {
      p_org_id: orgId,
      p_expense_id: payload.expenseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_recovery_status: payload.recoveryStatus,
      p_recoverability_result: payload.recoverabilityResult,
      p_cam_eligible: payload.camEligible,
      p_cam_status: payload.camStatus,
      p_linked_expense_rule_id: payload.linkedExpenseRuleId,
      p_sent_to_cam: payload.sentToCam,
      p_classification_patch: payload.patch,
      p_expense_patch: payload.expensePatch,
    });

    const missingClassificationBackend =
      error &&
      (["42P01", "42883", "PGRST202", "PGRST205"].includes(String(error.code || "").toUpperCase()) ||
        /persist_expense_classification|expense_classifications/i.test(error.message || ""));
    const isManualRecoveryUpdate =
      payload.expensePatch &&
      String(payload.patch?.rule_source || "").toLowerCase() === "manual";

    if (missingClassificationBackend && isManualRecoveryUpdate) {
      ({ data, error } = await supabaseAdmin.rpc("set_expense_recovery", {
        p_org_id: orgId,
        p_expense_id: payload.expenseId,
        p_actor_user_id: user.id,
        p_actor_email: user.email || null,
        p_recovery_status: payload.recoveryStatus,
        p_classification: payload.expensePatch?.classification || payload.recoveryStatus,
        p_approved_status: payload.patch?.approved_status || null,
        p_rule_source: payload.patch?.rule_source || "manual",
        p_recovery_reason: payload.patch?.recovery_reason || null,
      }));
    }

    if (error) {
      const message = error.message || "persist_expense_classification failed";
      const blockers = parseBlockers(message);
      if (blockers.length > 0) {
        return jsonResponse({
          error: true,
          message,
          error_code: "CLASSIFICATION_REJECTED",
          blockers,
        }, 400);
      }
      throw new Error(message);
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not persist expense classification";
    return jsonResponse({
      error: true,
      message,
      error_code: "PERSIST_EXPENSE_CLASSIFICATION_FAILED",
    }, errorStatus(message));
  }
});

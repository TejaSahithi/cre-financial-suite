// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const classificationId = String(body.classification_id || "").trim();
  if (!UUID_RE.test(classificationId)) {
    throw new Error("classification_id is required");
  }

  const overrideReason = String(body.override_reason || "").trim();
  if (!overrideReason) {
    throw new Error("override_reason is required");
  }

  const overrideType = body.override_type != null ? String(body.override_type) : null;

  const overridePreviousValue = body.override_previous_value ?? null;
  if (overridePreviousValue !== null && (typeof overridePreviousValue !== "object" || Array.isArray(overridePreviousValue))) {
    throw new Error("override_previous_value must be an object");
  }

  const overrideNewValue = body.override_new_value ?? null;
  if (overrideNewValue !== null && (typeof overrideNewValue !== "object" || Array.isArray(overrideNewValue))) {
    throw new Error("override_new_value must be an object");
  }

  return { classificationId, overrideReason, overrideType, overridePreviousValue, overrideNewValue };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be an object/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["LeaseExpenseClassification"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("manual_override_expense_classification", {
      p_org_id: orgId,
      p_classification_id: payload.classificationId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_override_reason: payload.overrideReason,
      p_override_type: payload.overrideType,
      p_override_previous_value: payload.overridePreviousValue,
      p_override_new_value: payload.overrideNewValue,
    });

    if (error) {
      throw new Error(error.message || "manual_override_expense_classification failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not apply manual override";
    return jsonResponse({
      error: true,
      message,
      error_code: "MANUAL_OVERRIDE_EXPENSE_CLASSIFICATION_FAILED",
    }, errorStatus(message));
  }
});

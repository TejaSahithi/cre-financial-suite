// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validatePayload(body: Record<string, unknown> = {}) {
  const ruleId = String(body.rule_id || "").trim();
  if (!UUID_RE.test(ruleId)) {
    throw new Error("rule_id is required");
  }

  const classification = body.classification;
  if (!classification || typeof classification !== "object" || Array.isArray(classification)) {
    throw new Error("classification must be an object");
  }

  return { ruleId, classification };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found|must be an object|is not permitted|non-negative|CAM-eligible/i.test(message)) return 400;
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

    const { data, error } = await supabaseAdmin.rpc("save_lease_rule_amount_cam_input", {
      p_org_id: orgId,
      p_rule_id: payload.ruleId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_classification: payload.classification,
    });

    if (error) {
      throw new Error(error.message || "save_lease_rule_amount_cam_input failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not save CAM rule amount";
    return jsonResponse({
      error: true,
      message,
      error_code: "SAVE_LEASE_RULE_AMOUNT_CAM_INPUT_FAILED",
    }, errorStatus(message));
  }
});

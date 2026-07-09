// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

function validatePayload(body: Record<string, unknown> = {}) {
  const leaseId = String(body.lease_id || "").trim();
  if (!leaseId) throw new Error("lease_id is required");

  const baseYear = body.base_year == null || body.base_year === "" ? null : Number(body.base_year);
  if (baseYear != null && !Number.isFinite(baseYear)) {
    throw new Error("base_year must be a number");
  }
  const excludedExpenses = Array.isArray(body.excluded_expenses)
    ? body.excluded_expenses.map((v: unknown) => String(v))
    : [];
  const configValues = body.config_values && typeof body.config_values === "object"
    ? body.config_values as Record<string, unknown>
    : {};

  return { leaseId, baseYear, excludedExpenses, configValues };
}

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|must be|out of range|not found/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["CAMDashboard", "CAMSetup"], "write");

    const body = await req.json().catch(() => ({}));
    const payload = validatePayload(body);

    const { data, error } = await supabaseAdmin.rpc("save_lease_config", {
      p_org_id: orgId,
      p_lease_id: payload.leaseId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_base_year: payload.baseYear,
      p_excluded_expenses: payload.excludedExpenses,
      p_config_values: payload.configValues,
    });

    if (error) {
      throw new Error(error.message || "save_lease_config failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not save lease CAM configuration";
    return jsonResponse({
      error: true,
      message,
      error_code: "SAVE_LEASE_CONFIG_FAILED",
    }, errorStatus(message));
  }
});

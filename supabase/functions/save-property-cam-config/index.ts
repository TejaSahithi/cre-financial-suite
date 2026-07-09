// @ts-nocheck
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const CAM_METHODS = new Set(["pro_rata", "fixed", "capped"]);
const RECOVERY_METHODS = new Set(["base_year", "full", "none"]);

function validatePayload(body: Record<string, unknown> = {}) {
  const propertyId = String(body.property_id || "").trim();
  if (!propertyId) throw new Error("property_id is required");

  const camCalculationMethod = String(body.cam_calculation_method || "pro_rata").trim();
  if (!CAM_METHODS.has(camCalculationMethod)) {
    throw new Error("cam_calculation_method must be one of pro_rata, fixed, capped");
  }
  const expenseRecoveryMethod = String(body.expense_recovery_method || "base_year").trim();
  if (!RECOVERY_METHODS.has(expenseRecoveryMethod)) {
    throw new Error("expense_recovery_method must be one of base_year, full, none");
  }
  const fiscalYearStart = Number(body.fiscal_year_start ?? 1);
  if (!Number.isFinite(fiscalYearStart) || fiscalYearStart < 1 || fiscalYearStart > 12) {
    throw new Error("fiscal_year_start must be between 1 and 12");
  }
  const configValues = body.config_values && typeof body.config_values === "object"
    ? body.config_values as Record<string, unknown>
    : {};

  return { propertyId, camCalculationMethod, expenseRecoveryMethod, fiscalYearStart, configValues };
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

    const { data, error } = await supabaseAdmin.rpc("save_property_cam_config", {
      p_org_id: orgId,
      p_property_id: payload.propertyId,
      p_actor_user_id: user.id,
      p_actor_email: user.email || null,
      p_cam_calculation_method: payload.camCalculationMethod,
      p_expense_recovery_method: payload.expenseRecoveryMethod,
      p_fiscal_year_start: payload.fiscalYearStart,
      p_config_values: payload.configValues,
    });

    if (error) {
      throw new Error(error.message || "save_property_cam_config failed");
    }

    return jsonResponse({ error: false, ...data });
  } catch (err) {
    const message = err?.message || "Could not save property CAM configuration";
    return jsonResponse({
      error: true,
      message,
      error_code: "SAVE_PROPERTY_CAM_CONFIG_FAILED",
    }, errorStatus(message));
  }
});

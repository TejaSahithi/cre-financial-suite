// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation pass, item H. Thin auth/validation wrapper around
// ../_shared/cam-engine-v2/setup/budget-readiness-report.ts. Read-only.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { buildBudgetReadinessReport } from "../_shared/cam-engine-v2/setup/budget-readiness-report.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found/i.test(message)) return 400;
  return 500;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["CAMSetup", "CAMSetupV2", "BudgetReadiness", "CreateBudget"], "read");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body?.property_id || "").trim();
    const recoveryPeriodId = String(body?.recovery_period_id || "").trim();
    if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
    if (!UUID_RE.test(recoveryPeriodId)) throw new Error("recovery_period_id is required");

    await assertPropertyAccess(req, propertyId);

    const report = await buildBudgetReadinessReport(supabaseAdmin, { orgId, propertyId, recoveryPeriodId });
    return jsonResponse({ error: false, ...report });
  } catch (err) {
    const message = err?.message || "Could not build budget readiness report";
    return jsonResponse({ error: true, message, error_code: "BUDGET_READINESS_REPORT_FAILED" }, errorStatus(message));
  }
});

// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — CAM Setup
// automation: "Prepare CAM Automatically."
//
// Thin auth/validation wrapper around
// ../_shared/cam-engine-v2/setup/prepare-cam-automatically.ts. All actual
// orchestration logic lives in that shared module so it can be unit tested
// without spinning up an HTTP request. This function itself does not read
// or write any table directly.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { prepareCamAutomatically } from "../_shared/cam-engine-v2/setup/prepare-cam-automatically.ts";

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
    await assertPageAccess(req, orgId, ["CAMSetup", "CAMSetupV2"], "write");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body?.property_id || "").trim();
    const recoveryPeriodId = String(body?.recovery_period_id || "").trim();
    if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
    if (!UUID_RE.test(recoveryPeriodId)) throw new Error("recovery_period_id is required");

    await assertPropertyAccess(req, propertyId);

    const result = await prepareCamAutomatically(supabaseAdmin, {
      orgId,
      propertyId,
      recoveryPeriodId,
      actorUserId: user.id,
      actorEmail: user.email ?? "unknown@example.com",
    });

    await supabaseAdmin.from("audit_logs").insert({
      org_id: orgId,
      property_id: propertyId,
      entity_type: "RecoveryPeriod",
      entity_id: recoveryPeriodId,
      action: "cam_prepare_automatically",
      actor_user_id: user.id,
      actor_email: user.email ?? "unknown@example.com",
      severity: "info",
      source: "edge_function",
      metadata: {
        policies_materialized: result.created.policies_materialized,
        suggested_pool_count: result.suggested.pools.length,
        duplicate_lease_group_count: result.conflicting.duplicate_lease_groups.length,
        blocking_count: result.blocking.length,
      },
      timestamp: new Date().toISOString(),
    });

    return jsonResponse({ error: false, ...result });
  } catch (err) {
    const message = err?.message || "Could not prepare CAM automatically";
    return jsonResponse({ error: true, message, error_code: "PREPARE_CAM_AUTOMATICALLY_FAILED" }, errorStatus(message));
  }
});

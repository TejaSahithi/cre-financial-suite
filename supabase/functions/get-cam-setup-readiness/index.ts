// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 2D: the
// ONLY read path exposed so far. Consolidates the recovery period, its
// pools, materialized policies, published/assigned/unassigned CAM expense
// inputs, and the evaluate_cam_readiness() result into one payload for the
// minimal CAM Setup (v2) page. Read-only — this function never calls a
// mutating RPC and never writes to any table itself.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorStatus(message: string) {
  if (/unauthorized|missing authorization/i.test(message)) return 401;
  if (/access denied|permission/i.test(message)) return 403;
  if (/required|not found/i.test(message)) return 400;
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
    await assertPageAccess(req, orgId, ["CAMSetup", "CAMDashboard"], "read");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body?.property_id || "").trim();
    const recoveryPeriodId = String(body?.recovery_period_id || "").trim();
    const scopeType = String(body?.scope_type || "property").trim();
    const scopeId = body?.scope_id ? String(body.scope_id).trim() : propertyId;

    if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
    if (!UUID_RE.test(recoveryPeriodId)) throw new Error("recovery_period_id is required");

    await assertPropertyAccess(req, propertyId);

    const { data: period, error: periodError } = await supabaseAdmin
      .from("recovery_periods")
      .select("*, recovery_calendars(name, calendar_type)")
      .eq("id", recoveryPeriodId)
      .eq("org_id", orgId)
      .maybeSingle();
    if (periodError) throw new Error(`Failed to load recovery period: ${periodError.message}`);
    if (!period) throw new Error("Recovery period not found for this organization");

    const [{ data: pools, error: poolsError }, { data: readiness, error: readinessError }] = await Promise.all([
      supabaseAdmin
        .from("recovery_pools")
        .select("*, recovery_pool_categories(*), recovery_pool_scope_members(*)")
        .eq("org_id", orgId)
        .eq("period_id", recoveryPeriodId),
      supabaseAdmin.rpc("evaluate_cam_readiness", {
        p_org_id: orgId,
        p_property_id: propertyId,
        p_recovery_period_id: recoveryPeriodId,
        p_scope_type: scopeType,
        p_scope_id: scopeId,
      }),
    ]);
    if (poolsError) throw new Error(`Failed to load recovery pools: ${poolsError.message}`);
    if (readinessError) throw new Error(`Failed to evaluate readiness: ${readinessError.message}`);

    const poolIds = (pools ?? []).map((p: any) => p.id);

    const [{ data: policies, error: policiesError }, { data: camInputs, error: camInputsError }, { data: assignments, error: assignmentsError }] = await Promise.all([
      supabaseAdmin
        .from("lease_recovery_policies")
        .select("*, lease_recovery_policy_steps(*), leases(tenant_name)")
        .eq("org_id", orgId)
        .in("status", ["approved", "draft"])
        .order("effective_from", { ascending: false }),
      supabaseAdmin
        .from("cam_expense_inputs")
        .select("*")
        .eq("org_id", orgId)
        .eq("property_id", propertyId)
        .eq("publication_status", "published"),
      poolIds.length > 0
        ? supabaseAdmin.from("cam_input_pool_assignments").select("*").eq("org_id", orgId).in("recovery_pool_id", poolIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (policiesError) throw new Error(`Failed to load recovery policies: ${policiesError.message}`);
    if (camInputsError) throw new Error(`Failed to load CAM expense inputs: ${camInputsError.message}`);
    if (assignmentsError) throw new Error(`Failed to load pool assignments: ${assignmentsError.message}`);

    const assignedInputIds = new Set((assignments ?? []).map((a: any) => a.cam_expense_input_id));
    const assignedCamInputs = (camInputs ?? []).filter((i: any) => assignedInputIds.has(i.id));
    const unassignedCamInputs = (camInputs ?? []).filter((i: any) => !assignedInputIds.has(i.id));

    return jsonResponse({
      error: false,
      recovery_period: period,
      pools: pools ?? [],
      policies: policies ?? [],
      cam_inputs: {
        assigned: assignedCamInputs,
        unassigned: unassignedCamInputs,
      },
      pool_assignments: assignments ?? [],
      readiness,
    });
  } catch (err) {
    const message = err?.message || "Could not load CAM setup readiness";
    return jsonResponse({ error: true, message, error_code: "GET_CAM_SETUP_READINESS_FAILED" }, errorStatus(message));
  }
});

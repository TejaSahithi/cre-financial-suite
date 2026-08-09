// @ts-nocheck
// Phase 3A — Next-Year Expense Budget Basis. Thin auth/dispatch wrapper —
// all computation lives in ../_shared/budget-basis.ts (see that file for the
// full design rationale), mirroring how run-cam-calculation-v2 wraps
// buildCamRunInputV2/runCamEngine.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { assertValidScopeHierarchy } from "../_shared/scope.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";
import { buildBudgetBasisSnapshot, BUDGET_BASIS_ENGINE_TYPE, BUDGET_BASIS_ENGINE_VERSION } from "../_shared/budget-basis.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  try {
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    // Reuses the existing budget pages — this phase adds no new UI/page yet.
    await assertPageAccess(req, orgId, ["CreateBudget", "BudgetDashboard"], "write");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body?.property_id || "").trim();
    const buildingId = body?.building_id ? String(body.building_id).trim() : null;
    const fiscalYear = Number(body?.fiscal_year);
    const categoryInputs = Array.isArray(body?.category_inputs) ? body.category_inputs : [];

    await assertPropertyAccess(req, propertyId);
    const scope = buildingId
      ? await assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, "building", buildingId)
      : await assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, "property", propertyId);

    const { snapshotInputs, snapshotOutputs } = await buildBudgetBasisSnapshot(supabaseAdmin, {
      orgId,
      propertyId,
      buildingId,
      scope: { scope_level: scope.scope_level, scope_id: scope.scope_id },
      fiscalYear,
      categoryInputs,
      actorUserId: user.id,
      actorEmail: user.email ?? null,
      triggerType: req.headers.get("x-compute-trigger") ?? "manual",
    });

    const existing = await findMatchingCompletedSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: BUDGET_BASIS_ENGINE_TYPE,
      fiscal_year: fiscalYear,
      inputs: snapshotInputs,
      outputs: snapshotOutputs,
      computed_by: user.email ?? user.id,
      engine_version: BUDGET_BASIS_ENGINE_VERSION,
    });
    if (existing?.outputs) {
      return jsonResponse({ error: false, budget_basis_id: existing.id, reused_snapshot: true, ...existing.outputs });
    }

    const snapshotId = await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: BUDGET_BASIS_ENGINE_TYPE,
      fiscal_year: fiscalYear,
      computed_by: user.email ?? user.id,
      engine_version: BUDGET_BASIS_ENGINE_VERSION,
      inputs: snapshotInputs,
      outputs: snapshotOutputs,
    });
    if (!snapshotId) throw new Error("Failed to persist budget basis snapshot");

    return jsonResponse({ error: false, budget_basis_id: snapshotId, reused_snapshot: false, ...snapshotOutputs });
  } catch (err) {
    console.error("[compute-budget-basis] Error:", err?.message || err);
    return jsonResponse({ error: true, message: err?.message || String(err) }, 400);
  }
});

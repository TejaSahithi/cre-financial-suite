// @ts-nocheck
// Phase 3B — Next-Year Budget CAM Estimate. Thin auth/dispatch wrapper —
// all assembly/summarization logic lives in ../_shared/budget-cam.ts, and
// the actual calculation is the real, unmodified CAM V2 engine
// (runCamEngine) imported from there. Mirrors compute-budget-basis's own
// split (auth wrapper + pure _shared module) and run-cam-calculation-v2's
// split (edge function + buildCamRunInputV2/runCamEngine).
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { assertValidScopeHierarchy } from "../_shared/scope.ts";
import { saveSnapshot, findMatchingCompletedSnapshot } from "../_shared/snapshot.ts";
import {
  buildBudgetCamRunInput,
  summarizeBudgetCamOutput,
  runCamEngine,
  validateCamRunOutput,
  BUDGET_CAM_ENGINE_TYPE,
  BUDGET_CAM_ENGINE_VERSION,
} from "../_shared/budget-cam.ts";

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

    await assertPropertyAccess(req, propertyId);
    const scope = buildingId
      ? await assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, "building", buildingId)
      : await assertValidScopeHierarchy(supabaseAdmin, orgId, propertyId, "property", propertyId);

    // ---------------------------------------------------------------
    // Required precondition: a completed Phase 3A budget-basis snapshot
    // for this exact property/scope/fiscal_year. This phase NEVER reads
    // expenses/expense_classifications/cam_expense_inputs itself — the
    // only expense-side input is this snapshot's already-computed,
    // already-authoritative planning amounts.
    // ---------------------------------------------------------------
    const { data: basisSnapshot, error: basisErr } = await supabaseAdmin
      .from("computation_snapshots")
      .select("id, outputs")
      .eq("org_id", orgId)
      .eq("property_id", propertyId)
      .eq("engine_type", "budget_basis")
      .eq("scope_level", scope.scope_level)
      .eq("scope_id", scope.scope_id)
      .eq("fiscal_year", fiscalYear)
      .eq("status", "completed")
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (basisErr) throw new Error(`Failed to load budget basis: ${basisErr.message}`);
    if (!basisSnapshot?.outputs) {
      throw new Error(
        `No completed FY${fiscalYear} budget basis exists yet for this property/scope. Run compute-budget-basis (Phase 3A) first — Budget CAM estimates are derived from its output, never from actual expenses.`,
      );
    }

    const { input, unmappedCategories, mappedCategoryLines, leasesConsidered, sourcePoolIds } = await buildBudgetCamRunInput(
      supabaseAdmin,
      {
        orgId,
        propertyId,
        buildingId,
        scope: { scope_level: scope.scope_level, scope_id: scope.scope_id },
        fiscalYear,
        budgetBasisOutputs: basisSnapshot.outputs,
      },
    );

    const output = await runCamEngine(input);
    const validationExceptions = validateCamRunOutput(input, output);
    const allExceptions = [...output.exceptions, ...validationExceptions];

    const summary = summarizeBudgetCamOutput({ output, leasesConsidered, mappedCategoryLines, unmappedCategories });

    const snapshotInputs = {
      property_id: propertyId,
      building_id: buildingId,
      fiscal_year: fiscalYear,
      scope_level: scope.scope_level,
      scope_id: scope.scope_id,
      budget_basis_snapshot_id: basisSnapshot.id,
      source_pool_ids: [...sourcePoolIds].sort(),
      source_lease_ids: leasesConsidered.map((l: any) => l.id).sort(),
      _compute: {
        page_scope: ["CreateBudget", "BudgetDashboard"],
        source_tables: ["computation_snapshots", "recovery_pools", "lease_recovery_policies", "leases"],
        source_row_ids: {
          budget_basis_snapshot: [basisSnapshot.id],
          recovery_pools: sourcePoolIds,
          leases: leasesConsidered.map((l: any) => l.id),
        },
        trigger_type: req.headers.get("x-compute-trigger") ?? "manual",
      },
    };
    const snapshotOutputs = {
      schema_version: "budget_cam_estimate.v1",
      kind: "planning_estimate", // never an actual CAM run — see file header of _shared/budget-cam.ts
      org_id: orgId,
      property_id: propertyId,
      building_id: buildingId,
      scope_level: scope.scope_level,
      scope_id: scope.scope_id,
      fiscal_year: fiscalYear,
      budget_basis_snapshot_id: basisSnapshot.id,
      ready_to_post: false, // a planning estimate is never postable/billable
      exceptions: allExceptions,
      ...summary,
    };

    const existing = await findMatchingCompletedSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: BUDGET_CAM_ENGINE_TYPE,
      fiscal_year: fiscalYear,
      inputs: snapshotInputs,
      outputs: snapshotOutputs,
      computed_by: user.email ?? user.id,
      engine_version: BUDGET_CAM_ENGINE_VERSION,
    });
    if (existing?.outputs) {
      return jsonResponse({ error: false, budget_cam_estimate_id: existing.id, reused_snapshot: true, ...existing.outputs });
    }

    const snapshotId = await saveSnapshot(supabaseAdmin, {
      org_id: orgId,
      property_id: propertyId,
      engine_type: BUDGET_CAM_ENGINE_TYPE,
      fiscal_year: fiscalYear,
      computed_by: user.email ?? user.id,
      engine_version: BUDGET_CAM_ENGINE_VERSION,
      inputs: snapshotInputs,
      outputs: snapshotOutputs,
    });
    if (!snapshotId) throw new Error("Failed to persist budget CAM estimate snapshot");

    return jsonResponse({ error: false, budget_cam_estimate_id: snapshotId, reused_snapshot: false, ...snapshotOutputs });
  } catch (err) {
    console.error("[compute-budget-cam-estimate] Error:", err?.message || err);
    return jsonResponse({ error: true, message: err?.message || String(err) }, 400);
  }
});

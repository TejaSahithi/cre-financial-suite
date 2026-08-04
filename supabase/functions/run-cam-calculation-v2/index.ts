// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-D: the
// end-to-end command wiring database -> pure engine -> ledger. Sequence
// mirrors the 12 Phase 3B-D requirements exactly:
//   1. Authorize organization and scope.
//   2. Create or load a draft cam_run (get_or_create_draft_cam_run RPC).
//   3-4. Build and freeze the input snapshot, which re-runs readiness
//        LIVE and fails closed on any blocking exception (in-process call
//        to _shared/cam-engine-v2/snapshot/build-cam-run-input.ts — the
//        same logic build-cam-run-input-v2 exposes standalone, not an
//        HTTP hop, since this call always originates from trusted server
//        code with orgId already resolved).
//   5. Execute the pure V2 engine (runCamEngine — no DB access inside it).
//   6. Validate output balancing and currency
//      (_shared/cam-engine-v2/validation/output-validation.ts) BEFORE
//      persistence — a structurally broken result never reaches the
//      ledger tables.
//   7. Persist results transactionally (persist_cam_run_results RPC,
//      which itself is one PL/pgSQL function call = one transaction; see
//      that migration's own header for why a partial write can never be
//      observed as "calculated").
//   8. input_hash/engine_version are passed straight through to the
//      persistence RPC; duration_ms is measured around the engine call.
//   9. Returns run/status/summaries/exceptions + a calculation-line COUNT
//      and cam_run_id (the caller queries cam_run_calculation_lines by
//      cam_run_id for the full ledger — this response deliberately does
//      NOT inline potentially hundreds of thousands of lines).
//  10. Idempotent retry: persist_cam_run_results already no-ops on an
//      unchanged input_hash against an already-calculated run.
//  11. A draft's recalculation replaces the previous draft result
//      atomically: persist_cam_run_results deletes-then-inserts inside
//      its own single transaction.
//  12. Terminal-status runs are rejected by both the snapshot builder and
//      the persistence RPC independently — two layers, not one.
import { corsHeaders } from "../_shared/cors.ts";
import { assertPageAccess, assertPropertyAccess, getUserOrgId, verifyUser } from "../_shared/supabase.ts";
import { buildCamRunInputV2 } from "../_shared/cam-engine-v2/snapshot/build-cam-run-input.ts";
import { runCamEngine } from "../_shared/cam-engine-v2/orchestrator/run-cam-engine.ts";
import { validateCamRunOutput } from "../_shared/cam-engine-v2/validation/output-validation.ts";

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

  const startedAt = Date.now();

  try {
    // ---- 1. Authorize organization and scope. ----
    const { user, supabaseAdmin } = await verifyUser(req);
    const orgId = await getUserOrgId(user.id, supabaseAdmin, req);
    await assertPageAccess(req, orgId, ["CAMSetup", "CAMDashboard"], "write");

    const body = await req.json().catch(() => ({}));
    const propertyId = String(body?.property_id || "").trim();
    const recoveryPeriodId = String(body?.recovery_period_id || "").trim();
    const scopeType = String(body?.scope_type || "property").trim();
    const scopeId = body?.scope_id ? String(body.scope_id).trim() : propertyId;
    const runType = String(body?.run_type || "standard").trim();
    const runMode = body?.run_mode === "posting_eligible" ? "posting_eligible" : "preview";
    const adjustmentOfRunId = body?.adjustment_of_run_id ? String(body.adjustment_of_run_id).trim() : null;
    const restatementOfRunId = body?.restatement_of_run_id ? String(body.restatement_of_run_id).trim() : null;

    if (!UUID_RE.test(propertyId)) throw new Error("property_id is required");
    if (!UUID_RE.test(recoveryPeriodId)) throw new Error("recovery_period_id is required");

    await assertPropertyAccess(req, propertyId);

    // ---- 2. Create or load a draft cam_run. ----
    const { data: draftResult, error: draftError } = await supabaseAdmin.rpc("get_or_create_draft_cam_run", {
      p_org_id: orgId, p_recovery_period_id: recoveryPeriodId, p_scope_type: scopeType, p_scope_id: scopeId,
      p_run_type: runType, p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
      p_adjustment_of_run_id: adjustmentOfRunId, p_restatement_of_run_id: restatementOfRunId,
    });
    if (draftError) throw new Error(`Failed to create or load draft cam_run: ${draftError.message}`);
    const camRun = draftResult.run;

    // ---- 3-4. Build and freeze the input snapshot (readiness re-check happens inside). ----
    const snapshot = await buildCamRunInputV2(supabaseAdmin, {
      orgId, propertyId, recoveryPeriodId, scopeType, scopeId, camRunId: camRun.id, runMode,
    });

    if (!snapshot.ready) {
      // Readiness failed live -- transition the draft to readiness_failed
      // and stop. No engine execution, no persistence attempt.
      await supabaseAdmin.from("cam_runs").update({ status: "readiness_failed" }).eq("id", camRun.id).eq("org_id", orgId);
      return jsonResponse({
        run_id: camRun.id, status: "readiness_failed", ready: false, readiness: snapshot.readiness,
        duration_ms: Date.now() - startedAt,
      }, 200);
    }

    // Bring the run into 'ready' before calculating, if it isn't already
    // (valid transitions: draft -> ready, readiness_failed -> ready).
    if (camRun.status === "draft" || camRun.status === "readiness_failed") {
      const { error: readyTransitionError } = await supabaseAdmin.from("cam_runs").update({ status: "ready" }).eq("id", camRun.id).eq("org_id", orgId);
      if (readyTransitionError) throw new Error(`Failed to transition run to ready: ${readyTransitionError.message}`);
    }

    // ---- 5. Execute the pure V2 engine. ----
    const engineStartedAt = Date.now();
    const output = await runCamEngine(snapshot.input as any);
    const engineDurationMs = Date.now() - engineStartedAt;

    // ---- 6. Validate output balancing and currency BEFORE persistence. ----
    const validationExceptions = validateCamRunOutput(snapshot.input as any, output);
    const allExceptions = [...output.exceptions, ...validationExceptions];
    const readyToPost = output.ready_to_post && validationExceptions.every((e) => e.severity !== "blocking");

    // ---- 7-8. Persist transactionally; record hash/version/duration. ----
    const { data: persistResult, error: persistError } = await supabaseAdmin.rpc("persist_cam_run_results", {
      p_org_id: orgId, p_cam_run_id: camRun.id, p_actor_user_id: user.id, p_actor_email: user.email ?? "unknown@example.com",
      p_input_hash: snapshot.input_hash, p_engine_version: (snapshot.input as any).run.engine_version, p_ready_to_post: readyToPost,
      p_pool_results: output.pool_results, p_lease_results: output.lease_results,
      p_calculation_lines: output.calculation_lines, p_exceptions: allExceptions, p_run_mode: runMode,
    });
    if (persistError) throw new Error(`Failed to persist run results: ${persistError.message}`);

    // ---- 9. Return summaries, exceptions, and calculation-line references (not the full ledger). ----
    return jsonResponse({
      run_id: camRun.id,
      status: persistResult.status,
      ready_to_post: readyToPost,
      idempotent_rerun: persistResult.idempotent_rerun,
      input_hash: snapshot.input_hash,
      engine_version: (snapshot.input as any).run.engine_version,
      pool_result_count: persistResult.pool_result_count,
      lease_result_count: persistResult.lease_result_count,
      calculation_line_count: persistResult.calculation_line_count,
      exception_count: persistResult.exception_count,
      exceptions: allExceptions,
      lease_results_summary: output.lease_results.map((r) => ({ lease_id: r.lease_id, final_recovery: r.final_recovery, amount_due_credit: r.amount_due_credit })),
      pool_results_summary: output.pool_results.map((r) => ({ pool_id: r.pool_id, actual_amount: r.actual_amount, adjusted_pool: r.adjusted_pool })),
      duration_ms: Date.now() - startedAt,
      engine_duration_ms: engineDurationMs,
    }, 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message, duration_ms: Date.now() - startedAt }, errorStatus(message));
  }
});

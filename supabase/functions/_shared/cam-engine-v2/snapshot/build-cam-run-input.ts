// @ts-nocheck
// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3B-B: the
// server-side snapshot builder's actual logic, shared between the
// standalone build-cam-run-input-v2 edge function (preview/inspection use)
// and run-cam-calculation-v2 (which calls this in-process as its own step
// 3-4, not over HTTP — avoiding the internal-service-key auth dance for a
// call that always originates from trusted server code with an org_id
// already resolved). This module has DATABASE ACCESS, unlike everything
// under cam-engine-v2/orchestrator, which is deliberately pure.
//
// See build-cam-run-input-v2/index.ts for the full 10-requirement mapping
// this implements.
import { computeInputHash } from "../orchestrator/run-cam-engine.ts";

const ENGINE_VERSION = "cam-engine-v2.0.0";

export interface BuildSnapshotParams {
  orgId: string;
  propertyId: string;
  recoveryPeriodId: string;
  scopeType: string;
  scopeId: string;
  camRunId: string;
  runMode: "preview" | "posting_eligible";
}

export interface BuildSnapshotResult {
  ready: boolean;
  readiness: unknown;
  snapshot_built: boolean;
  input_hash?: string;
  input?: Record<string, unknown>;
}

export async function buildCamRunInputV2(supabaseAdmin: any, params: BuildSnapshotParams): Promise<BuildSnapshotResult> {
  const { orgId, propertyId, recoveryPeriodId, scopeType, scopeId, camRunId, runMode } = params;

  const { data: camRun, error: camRunError } = await supabaseAdmin
    .from("cam_runs").select("*").eq("id", camRunId).eq("org_id", orgId).maybeSingle();
  if (camRunError) throw new Error(`Failed to load cam_run: ${camRunError.message}`);
  if (!camRun) throw new Error("cam_run not found for this organization");
  if (["posted", "superseded", "voided"].includes(camRun.status)) {
    throw new Error(`cam_run ${camRunId} is in terminal status ${camRun.status} — a snapshot cannot be (re)built for it`);
  }
  if (camRun.recovery_period_id !== recoveryPeriodId || camRun.scope_type !== scopeType || (camRun.scope_id ?? null) !== (scopeId ?? null)) {
    throw new Error("cam_run's own recovery_period_id/scope_type/scope_id do not match the request — refusing to build a mismatched snapshot");
  }

  const { data: period, error: periodError } = await supabaseAdmin
    .from("recovery_periods").select("*").eq("id", recoveryPeriodId).eq("org_id", orgId).maybeSingle();
  if (periodError) throw new Error(`Failed to load recovery period: ${periodError.message}`);
  if (!period) throw new Error("Recovery period not found for this organization");

  // Step 2-3: live readiness re-check; fail closed on any blocking exception.
  const { data: readiness, error: readinessError } = await supabaseAdmin.rpc("evaluate_cam_readiness", {
    p_org_id: orgId, p_property_id: propertyId, p_recovery_period_id: recoveryPeriodId,
    p_scope_type: scopeType, p_scope_id: scopeId,
  });
  if (readinessError) throw new Error(`Failed to evaluate readiness: ${readinessError.message}`);
  if (!readiness?.ready) {
    return { ready: false, readiness, snapshot_built: false };
  }

  // Step 4 + 10: one transactional read of every source table.
  const { data: raw, error: rawError } = await supabaseAdmin.rpc("build_cam_run_input_snapshot_data", {
    p_org_id: orgId, p_property_id: propertyId, p_recovery_period_id: recoveryPeriodId,
    p_scope_type: scopeType, p_scope_id: scopeId,
  });
  if (rawError) throw new Error(`Failed to read snapshot source data: ${rawError.message}`);

  const camRunInput = {
    run: {
      id: camRun.id, org_id: orgId, recovery_period_id: recoveryPeriodId, scope_type: scopeType, scope_id: scopeId,
      run_type: camRun.run_type, adjustment_of_run_id: null, restatement_of_run_id: null, engine_version: ENGINE_VERSION,
      currency: "USD", area_unit: "sqft", rounding_policy: camRun.rounding_policy, run_mode: runMode,
    },
    recovery_period: period,
    pools: (raw.pools ?? []).map((row: any) => ({ ...row.pool, categories: row.categories, scope_members: row.scope_members })),
    published_expense_inputs: raw.published_expense_inputs ?? [],
    pool_assignments: raw.pool_assignments ?? [],
    pool_lease_participants: raw.pool_lease_participants ?? [],
    leases: (raw.leases ?? []).map((row: any) => ({
      id: row.lease.id,
      premises: (row.premises ?? []).map((p: any) => ({ ...p.premises, spaces: p.spaces, area_periods: p.area_periods })),
    })),
    area_measurements: raw.area_measurements ?? [],
    occupancy_periods: raw.occupancy_periods ?? [],
    policies: (raw.policies ?? []).map((row: any) => ({ ...row.policy, steps: row.steps })),
    estimate_schedules: raw.estimate_schedules ?? [],
    prior_period_adjustments: raw.prior_period_adjustments ?? [],
    prior_cam_history: raw.prior_cam_history ?? [],
    base_year_snapshots: raw.base_year_snapshots ?? [],
    policy_materializer_versions: Object.fromEntries((raw.policies ?? []).map((row: any) => [row.policy.id, row.policy.materializer_version])),
    readiness_at_snapshot_time: readiness,
  };

  // computeInputHash() itself excludes readiness_at_snapshot_time (see its
  // own comment in run-cam-engine.ts) precisely so this call and the
  // engine's own internal hash computation always agree, and so a live
  // readiness re-check's fresh evaluated_at timestamp never defeats
  // idempotency against byte-identical underlying data.
  const inputHash = await computeInputHash(camRunInput as any);

  const sourceTables: Array<{ source_type: string; count: number }> = [
    { source_type: "recovery_pools", count: camRunInput.pools.length },
    { source_type: "lease_recovery_policies", count: camRunInput.policies.length },
    { source_type: "leases", count: camRunInput.leases.length },
    { source_type: "space_area_measurements", count: camRunInput.area_measurements.length },
    { source_type: "space_occupancy_periods", count: camRunInput.occupancy_periods.length },
    { source_type: "cam_expense_inputs", count: camRunInput.published_expense_inputs.length },
    { source_type: "cam_input_pool_assignments", count: camRunInput.pool_assignments.length },
    { source_type: "recovery_pool_lease_participants", count: camRunInput.pool_lease_participants.length },
    { source_type: "cam_estimate_schedules", count: camRunInput.estimate_schedules.length },
    { source_type: "cam_prior_period_adjustments", count: camRunInput.prior_period_adjustments.length },
  ];
  const { error: snapshotInsertError } = await supabaseAdmin.from("cam_run_input_snapshots").insert(
    sourceTables.map((t) => ({
      org_id: orgId, cam_run_id: camRunId, source_type: t.source_type, source_id: camRunId,
      source_version: String(t.count), source_updated_at: raw.snapshot_taken_at, payload_hash: inputHash,
    })),
  );
  if (snapshotInsertError) throw new Error(`Failed to persist input snapshot markers: ${snapshotInsertError.message}`);

  return { ready: true, readiness, snapshot_built: true, input_hash: inputHash, input: camRunInput };
}

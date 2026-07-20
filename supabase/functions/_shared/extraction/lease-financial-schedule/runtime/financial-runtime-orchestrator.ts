// @ts-nocheck
/**
 * P4.7 financial schedule runtime boundary.
 *
 * Runs after P2/P3 claims/package authority is available and before the
 * authoritative finalizer. Providers, parsers, field extractors and frontend
 * modules must not import this file.
 */

import {
  getLeaseFinancialScheduleMode,
  resolveFinancialScheduleModeCombination,
} from "../feature-mode.ts";
import { LEASE_FINANCIAL_PROJECTION_VERSION } from "../projection/financial-projection-version.ts";
import { disabledFinancialRuntimeResult, failedFinancialRuntimeResult } from "./financial-runtime-result.ts";
import { FINANCIAL_RUNTIME_ERROR_CODES, FinancialRuntimeError } from "./financial-runtime-errors.ts";
import type {
  FinancialRuntimeContext,
  FinancialRuntimeEnvLike,
  FinancialRuntimeInput,
  FinancialRuntimeModes,
  FinancialRuntimeResult,
} from "./financial-runtime-types.ts";

async function maybeSingle(query: unknown) {
  if (query && typeof (query as any).maybeSingle === "function") return await (query as any).maybeSingle();
  return await query;
}

async function selectRows(query: unknown) {
  const result = await query;
  if (Array.isArray(result)) return { data: result, error: null };
  return result ?? { data: [], error: null };
}

export function resolveFinancialRuntimeModes(envLike?: FinancialRuntimeEnvLike): FinancialRuntimeModes {
  return resolveFinancialScheduleModeCombination(envLike);
}

export function validateFinancialRuntimeModeCombination(
  modes: FinancialRuntimeModes,
  options: { packageAwareInput?: boolean } = {},
) {
  if (!["off", "shadow", "active"].includes(modes.financialMode) || !["off", "shadow", "active"].includes(modes.claimsMode) || !["off", "shadow", "active"].includes(modes.packageMode)) {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_MODE_CONFIGURATION_INVALID);
  }
  if (modes.financialMode === "shadow" && modes.claimsMode === "off") {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER);
  }
  if (modes.financialMode === "active" && modes.claimsMode !== "active") {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE);
  }
  if (modes.financialMode === "active" && options.packageAwareInput === true && modes.packageMode !== "active") {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE);
  }
}

async function fetchActiveFileAndLease(supabaseAdmin: any, context: FinancialRuntimeContext) {
  const fileResult = await maybeSingle(
    supabaseAdmin
      .from("uploaded_files")
      .select("id, org_id, active_generation_id")
      .eq("org_id", context.orgId)
      .eq("id", context.uploadedFileId),
  );
  if (fileResult.error) throw new Error(`uploaded_files fetch failed: ${fileResult.error.message}`);
  const file = fileResult.data;
  if (!file || file.active_generation_id !== context.generationId) {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_ACTIVE_GENERATION_MISMATCH);
  }

  let leaseId = context.leaseId ?? null;
  if (!leaseId) {
    const leaseResult = await maybeSingle(
      supabaseAdmin
        .from("leases")
        .select("id, source_file_id")
        .eq("org_id", context.orgId)
        .eq("source_file_id", context.uploadedFileId),
    );
    if (leaseResult.error) throw new Error(`leases fetch failed: ${leaseResult.error.message}`);
    leaseId = leaseResult.data?.id ?? null;
  }

  return { file, leaseId };
}

async function verifyExtractionRun(supabaseAdmin: any, context: FinancialRuntimeContext) {
  const runResult = await maybeSingle(
    supabaseAdmin
      .from("extraction_runs")
      .select("id, org_id, uploaded_file_id, generation_id, status")
      .eq("org_id", context.orgId)
      .eq("id", context.extractionRunId)
      .eq("uploaded_file_id", context.uploadedFileId)
      .eq("generation_id", context.generationId),
  );
  if (runResult.error) throw new Error(`extraction_runs fetch failed: ${runResult.error.message}`);
  if (!runResult.data) throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_EXTRACTION_RUN_MISMATCH);
}

async function loadCurrentPackageId(supabaseAdmin: any, context: FinancialRuntimeContext, input: FinancialRuntimeInput) {
  if (input.packageId || context.packageId) return input.packageId ?? context.packageId ?? null;
  const membership = await maybeSingle(
    supabaseAdmin
      .from("lease_package_documents")
      .select("package_id")
      .eq("org_id", context.orgId)
      .eq("uploaded_file_id", context.uploadedFileId)
      .eq("generation_id", context.generationId)
      .eq("membership_status", "confirmed")
      .limit(1),
  );
  return membership?.data?.package_id ?? null;
}

async function loadLatestCompletedCalculation(supabaseAdmin: any, context: FinancialRuntimeContext, leaseId: string | null, packageId: string | null) {
  let query = supabaseAdmin
    .from("lease_financial_calculation_runs")
    .select("id, org_id, lease_id, package_id, extraction_run_id, generation_id, status, input_hash, blocking_issue_count, validation_issue_count")
    .eq("org_id", context.orgId)
    .eq("generation_id", context.generationId)
    .order("completed_at", { ascending: false })
    .order("started_at", { ascending: false })
    .limit(1);
  query = packageId ? query.eq("package_id", packageId) : query.is("package_id", null);
  if (leaseId) query = query.eq("lease_id", leaseId);
  const result = await maybeSingle(query);
  if (result.error) throw new Error(`lease_financial_calculation_runs fetch failed: ${result.error.message}`);
  const row = result.data;
  if (!row) throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_CALCULATION_MISSING);
  if (row.generation_id !== context.generationId) throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_CALCULATION_STALE_GENERATION);
  if (row.status === "failed") throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_CALCULATION_FAILED);
  if (!["completed", "completed_with_warnings"].includes(row.status)) {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_CALCULATION_MISSING);
  }
  return row;
}

async function loadLatestCompletedProjection(supabaseAdmin: any, context: FinancialRuntimeContext, calculationRunId: string) {
  const result = await maybeSingle(
    supabaseAdmin
      .from("lease_financial_projection_runs")
      .select("id, org_id, lease_id, package_id, calculation_run_id, generation_id, status, projection_version, input_hash, validation_codes, diff_count")
      .eq("org_id", context.orgId)
      .eq("calculation_run_id", calculationRunId)
      .eq("generation_id", context.generationId)
      .order("completed_at", { ascending: false })
      .order("started_at", { ascending: false })
      .limit(1),
  );
  if (result.error) throw new Error(`lease_financial_projection_runs fetch failed: ${result.error.message}`);
  const row = result.data;
  if (!row) throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_PROJECTION_MISSING);
  if (row.generation_id !== context.generationId) throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_PROJECTION_STALE_GENERATION);
  if (row.status === "failed") throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_PROJECTION_FAILED);
  if (!["completed", "completed_with_warnings"].includes(row.status)) {
    throw new FinancialRuntimeError(FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_PROJECTION_MISSING);
  }
  return row;
}

async function loadCompatibilityPatch(supabaseAdmin: any, context: FinancialRuntimeContext, projectionRunId: string) {
  const result = await selectRows(
    supabaseAdmin
      .from("lease_financial_field_projections")
      .select("field_key, value_json, normalized_value_text, display_value, source_evidence")
      .eq("org_id", context.orgId)
      .eq("projection_run_id", projectionRunId)
      .eq("projection_status", "available"),
  );
  if (result.error) throw new Error(`lease_financial_field_projections fetch failed: ${result.error.message}`);
  const fields: Record<string, unknown> = {};
  const fieldEvidence: Record<string, unknown> = {};
  const confidenceScores: Record<string, unknown> = {};
  for (const row of result.data ?? []) {
    fields[row.field_key] = {
      value: row.normalized_value_text ?? row.display_value ?? row.value_json ?? null,
      raw_value: row.normalized_value_text ?? row.display_value ?? row.value_json ?? null,
      extraction_status: "p4_financial_projected",
      source: "p4_financial_projection",
    };
    const evidence = Array.isArray(row.source_evidence) ? row.source_evidence[0] : row.source_evidence;
    if (evidence) fieldEvidence[row.field_key] = evidence;
    confidenceScores[row.field_key] = null;
  }
  return { fields, field_evidence: fieldEvidence, confidence_scores: confidenceScores };
}

async function persistCompatibilityWriteBack(supabaseAdmin: any, context: FinancialRuntimeContext, params: {
  leaseId: string | null;
  packageId: string | null;
  calculationRunId: string;
  projectionRunId: string;
  compatibilityPatch: unknown;
}) {
  const idempotencyKey = [
    "p4.7",
    context.orgId,
    context.uploadedFileId,
    context.generationId,
    params.packageId ?? "single",
    params.calculationRunId,
    params.projectionRunId,
    LEASE_FINANCIAL_PROJECTION_VERSION,
  ].join(":");
  const { data, error } = await supabaseAdmin.rpc("persist_lease_financial_projection", {
    p_org_id: context.orgId,
    p_lease_id: params.leaseId,
    p_uploaded_file_id: context.uploadedFileId,
    p_extraction_run_id: context.extractionRunId,
    p_generation_id: context.generationId,
    p_package_id: params.packageId,
    p_calculation_run_id: params.calculationRunId,
    p_projection_run_id: params.projectionRunId,
    p_compatibility_patch: params.compatibilityPatch,
    p_idempotency_key: idempotencyKey,
  });
  if (error || !data?.success) {
    throw new Error(`persist_lease_financial_projection failed: ${error?.message ?? data?.error_code ?? "unknown"}`);
  }
  return data;
}

async function projectCriticalDates(supabaseAdmin: any, context: FinancialRuntimeContext, params: {
  leaseId: string | null;
  packageId: string | null;
  calculationRunId: string;
  projectionRunId: string;
}) {
  const { data, error } = await supabaseAdmin.rpc("project_lease_financial_critical_dates", {
    p_org_id: context.orgId,
    p_lease_id: params.leaseId,
    p_package_id: params.packageId,
    p_generation_id: context.generationId,
    p_calculation_run_id: params.calculationRunId,
    p_projection_run_id: params.projectionRunId,
    p_idempotency_key: [
      "p4.7.critical-dates",
      context.orgId,
      context.generationId,
      params.calculationRunId,
      params.projectionRunId,
    ].join(":"),
  });
  if (error || !data?.success) {
    throw new Error(`project_lease_financial_critical_dates failed: ${error?.message ?? data?.error_code ?? "unknown"}`);
  }
  return data;
}

export async function runLeaseFinancialScheduleRuntime(
  supabaseAdmin: any,
  context: FinancialRuntimeContext,
  input: FinancialRuntimeInput = {},
  envLike?: FinancialRuntimeEnvLike,
): Promise<FinancialRuntimeResult> {
  const modes = resolveFinancialRuntimeModes(envLike);
  if (modes.financialMode === "off") return disabledFinancialRuntimeResult();
  validateFinancialRuntimeModeCombination(modes, { packageAwareInput: input.packageAwareInput });

  await verifyExtractionRun(supabaseAdmin, context);
  const { leaseId } = await fetchActiveFileAndLease(supabaseAdmin, context);
  const packageId = await loadCurrentPackageId(supabaseAdmin, context, input);
  validateFinancialRuntimeModeCombination(modes, { packageAwareInput: Boolean(packageId || input.packageAwareInput) });

  const calculation = await loadLatestCompletedCalculation(supabaseAdmin, context, leaseId, packageId);
  const projection = await loadLatestCompletedProjection(supabaseAdmin, context, calculation.id);

  let compatibilityPersisted = false;
  let criticalDateProjectionStatus = "not_required";
  if (modes.financialMode === "active") {
    const compatibilityPatch = await loadCompatibilityPatch(supabaseAdmin, context, projection.id);
    await persistCompatibilityWriteBack(supabaseAdmin, context, {
      leaseId,
      packageId,
      calculationRunId: calculation.id,
      projectionRunId: projection.id,
      compatibilityPatch,
    });
    compatibilityPersisted = true;
    const criticalDateResult = await projectCriticalDates(supabaseAdmin, context, {
      leaseId,
      packageId,
      calculationRunId: calculation.id,
      projectionRunId: projection.id,
    });
    criticalDateProjectionStatus = criticalDateResult.status ?? "completed";
  } else {
    criticalDateProjectionStatus = "candidate_only";
  }

  const warnings = Number(calculation.validation_issue_count ?? 0) > 0 || Number(projection.diff_count ?? 0) > 0;
  return {
    enabled: true,
    mode: modes.financialMode,
    claimsMode: modes.claimsMode,
    packageMode: modes.packageMode,
    calculationRunId: calculation.id,
    projectionRunId: projection.id,
    diffStatus: Number(projection.diff_count ?? 0) > 0 ? "recorded" : "none",
    compatibilityPersisted,
    criticalDateProjectionStatus,
    status: warnings ? "completed_with_warnings" : "completed",
  };
}

export async function maybeRunLeaseFinancialScheduleRuntime(
  supabaseAdmin: any,
  context: FinancialRuntimeContext,
  input: FinancialRuntimeInput = {},
  envLike?: FinancialRuntimeEnvLike,
): Promise<FinancialRuntimeResult | null> {
  const mode = getLeaseFinancialScheduleMode(envLike);
  if (mode === "off") return disabledFinancialRuntimeResult();
  try {
    return await runLeaseFinancialScheduleRuntime(supabaseAdmin, context, input, envLike);
  } catch (error) {
    const errorCode = error instanceof FinancialRuntimeError
      ? error.errorCode
      : FINANCIAL_RUNTIME_ERROR_CODES.FINANCIAL_RUNTIME_FAILED;
    console.error(`[lease-financial-schedule-runtime] financial pipeline failed mode=${mode} error_code=${errorCode}:`, error?.message ?? error);
    if (mode === "active") throw error;
    return failedFinancialRuntimeResult(mode, errorCode);
  }
}
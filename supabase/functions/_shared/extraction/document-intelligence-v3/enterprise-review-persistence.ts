// @ts-nocheck

import type { EnterpriseReviewPayload } from "./enterprise-review-payload.ts";

export async function persistEnterpriseReviewPayload(args: {
  supabaseAdmin: any;
  payload: EnterpriseReviewPayload;
  supersedesPayloadId?: string | null;
  diagnostics?: {
    rolloutMode?: string | null;
    rolloutSource?: string | null;
    payloadBuildDurationMs?: number | null;
    registryVersion?: string | null;
    projectionAlgorithmVersion?: string | null;
    integrityViolationCount?: number | null;
  };
}): Promise<{ id: string | null; error: string | null }> {
  const row = {
    org_id: args.payload.orgId,
    uploaded_file_id: args.payload.uploadedFileId,
    run_id: args.payload.runId,
    generation_id: args.payload.generationId,
    schema_version: args.payload.schemaVersion,
    source_mode: args.payload.sourceMode,
    payload: args.payload,
    payload_hash: args.payload.payloadHash,
    coverage_summary: args.payload.coverage.totals,
    parity_summary: args.payload.compatibility.paritySummary,
    supersedes_payload_id: args.supersedesPayloadId ?? null,
    is_current: true,
    rollout_mode: args.diagnostics?.rolloutMode ?? args.payload.sourceMode,
    rollout_source: args.diagnostics?.rolloutSource ?? "default",
    fallback_count: args.payload.coverage?.totals?.legacyFallbacks ?? 0,
    material_mismatch_count: args.payload.compatibility?.paritySummary?.readiness?.materialMismatchCount ?? 0,
    blocking_finding_count: (args.payload.findings ?? []).filter((finding: any) => finding?.severity === "blocking" && finding?.resolutionStatus !== "resolved").length,
    payload_build_duration_ms: args.diagnostics?.payloadBuildDurationMs ?? null,
    registry_version: args.diagnostics?.registryVersion ?? null,
    projection_algorithm_version: args.diagnostics?.projectionAlgorithmVersion ?? "projection-resolution-v1",
    approval_readiness_summary: {
      eligible: args.payload.validationSummary?.approvalEligible ?? false,
      blockingCount: args.payload.validationSummary?.blockingIssueCount ?? 0,
      warningCount: args.payload.validationSummary?.warningCount ?? 0,
      conflictCount: args.payload.coverage?.totals?.conflicts ?? 0,
      missingRequiredCount: (args.payload.coverage?.entries ?? []).filter((entry: any) => entry?.requiredForApproval && entry?.coverageStatus === "missing").length,
      missingEvidenceCount: args.payload.coverage?.totals?.missingSourceEvidence ?? 0,
      fallbackCount: args.payload.coverage?.totals?.legacyFallbacks ?? 0,
    },
    integrity_violation_count: args.diagnostics?.integrityViolationCount ?? 0,
  };

  const { data: existing, error: existingError } = await args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .select("id")
    .eq("org_id", args.payload.orgId)
    .eq("uploaded_file_id", args.payload.uploadedFileId)
    .eq("run_id", args.payload.runId)
    .eq("schema_version", args.payload.schemaVersion)
    .eq("is_current", true)
    .maybeSingle();
  if (existingError) return { id: null, error: existingError.message };

  if (existing?.id) {
    const { error: updateError } = await args.supabaseAdmin
      .from("document_enterprise_review_payloads")
      .update({ is_current: false, superseded_at: new Date().toISOString() })
      .eq("id", existing.id)
      .eq("org_id", args.payload.orgId);
    if (updateError) return { id: null, error: updateError.message };
    row.supersedes_payload_id = existing.id;
  }

  const { data, error } = await args.supabaseAdmin
    .from("document_enterprise_review_payloads")
    .insert(row)
    .select("id")
    .single();
  if (error) return { id: null, error: error.message };
  return { id: data?.id ?? null, error: null };
}
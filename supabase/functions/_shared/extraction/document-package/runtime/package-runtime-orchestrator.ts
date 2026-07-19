// @ts-nocheck
/**
 * P3.7 package runtime orchestrator.
 *
 * One server-owned boundary between the completed P2 claims projection and
 * finalize_lease_extraction_for_review. Providers/parsers never import this
 * module, and mode=off callers do not invoke it from the runtime path.
 */

import { getLeaseClaimsLedgerMode } from "../../claims/feature-mode.ts";
import { getLeaseDocumentPackageMode } from "../feature-mode.ts";
import { resolvePackageMembershipForDocument } from "../package-membership-service.ts";
import { detectRelationshipsForPackage } from "../relationships/relationship-service.ts";
import { RELATIONSHIP_DETECTOR_CONTRACT_VERSION } from "../relationships/relationship-types.ts";
import { resolvePackageClaimsForPackage } from "../resolution/package-resolution-service.ts";
import { projectPackageCompatibilityForResolution } from "../projection/package-projection-service.ts";
import { PACKAGE_PROJECTION_VERSION } from "../projection/package-projection-version.ts";
import { disabledPackageRuntimeResult, failedPackageRuntimeResult } from "./package-runtime-result.ts";
import { PACKAGE_RUNTIME_ERROR_CODES, PackageRuntimeError } from "./package-runtime-errors.ts";
import type {
  PackageRuntimeContext,
  PackageRuntimeEnvLike,
  PackageRuntimeInput,
  PackageRuntimeModes,
  PackageRuntimeResult,
} from "./package-runtime-types.ts";

function unwrapRpcId(result: unknown, key: string): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  return (result as any)?.[key] || (result as any)?.data?.[key];
}

export function resolvePackageRuntimeModes(envLike?: PackageRuntimeEnvLike): PackageRuntimeModes {
  return {
    claimsMode: getLeaseClaimsLedgerMode(envLike),
    packageMode: getLeaseDocumentPackageMode(envLike),
  };
}

export function validatePackageRuntimeModeCombination(modes: PackageRuntimeModes) {
  if (!["off", "shadow", "active"].includes(modes.packageMode) || !["off", "shadow", "active"].includes(modes.claimsMode)) {
    throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_MODE_CONFIGURATION_INVALID);
  }
  if (modes.packageMode === "shadow" && modes.claimsMode === "off") {
    throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_MODE_REQUIRES_CLAIMS_LEDGER);
  }
  if (modes.packageMode === "active" && modes.claimsMode !== "active") {
    throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_ACTIVE_REQUIRES_CLAIMS_ACTIVE);
  }
}

async function maybeSingle(query: unknown) {
  if (query && typeof (query as any).maybeSingle === "function") return await (query as any).maybeSingle();
  return await query;
}

async function selectRows(query: unknown) {
  const result = await query;
  if (Array.isArray(result)) return { data: result, error: null };
  return result ?? { data: [], error: null };
}

async function fetchActiveFileAndLease(supabaseAdmin: any, context: PackageRuntimeContext) {
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
    throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_ACTIVE_GENERATION_MISMATCH);
  }

  let leaseId = context.leaseId ?? null;
  let isLegacySourceDocument = false;
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
    isLegacySourceDocument = leaseResult.data?.source_file_id === context.uploadedFileId;
  } else {
    const leaseResult = await maybeSingle(
      supabaseAdmin
        .from("leases")
        .select("id, source_file_id")
        .eq("org_id", context.orgId)
        .eq("id", leaseId),
    );
    if (leaseResult.error) throw new Error(`leases fetch failed: ${leaseResult.error.message}`);
    isLegacySourceDocument = leaseResult.data?.source_file_id === context.uploadedFileId;
  }

  return { file, leaseId, isLegacySourceDocument };
}

async function verifyExtractionRun(supabaseAdmin: any, context: PackageRuntimeContext) {
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
  if (!runResult.data) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_EXTRACTION_RUN_MISMATCH);
}

async function verifyP2LedgerAndProjection(supabaseAdmin: any, context: PackageRuntimeContext) {
  const claimsResult = await selectRows(
    supabaseAdmin
      .from("lease_claims")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("uploaded_file_id", context.uploadedFileId)
      .eq("generation_id", context.generationId),
  );
  if (claimsResult.error) throw new Error(`lease_claims fetch failed: ${claimsResult.error.message}`);
  if ((claimsResult.data ?? []).length === 0) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.CLAIM_LEDGER_MISSING);

  const projectionResult = await maybeSingle(
    supabaseAdmin
      .from("lease_claim_projection_runs")
      .select("id, status, generation_id")
      .eq("org_id", context.orgId)
      .eq("uploaded_file_id", context.uploadedFileId)
      .eq("generation_id", context.generationId)
      .order("created_at", { ascending: false })
      .limit(1),
  );
  if (projectionResult.error) throw new Error(`lease_claim_projection_runs fetch failed: ${projectionResult.error.message}`);
  const projection = projectionResult.data;
  if (!projection) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.CLAIM_PROJECTION_MISSING);
  if (projection.generation_id !== context.generationId) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.CLAIM_PROJECTION_STALE_GENERATION);
  if (projection.status === "failed") throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.CLAIM_PROJECTION_FAILED);
  if (projection.status !== "completed") throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.CLAIM_PROJECTION_MISSING);
  return projection;
}

async function loadProfile(supabaseAdmin: any, context: PackageRuntimeContext) {
  const result = await selectRows(
    supabaseAdmin
      .from("lease_document_profile_records")
      .select("id, segment_id, profile_key, classification_status, confidence")
      .eq("org_id", context.orgId)
      .eq("uploaded_file_id", context.uploadedFileId)
      .eq("generation_id", context.generationId)
      .in("classification_status", ["classified"]),
  );
  if (result.error) throw new Error(`lease_document_profile_records fetch failed: ${result.error.message}`);
  const rows = result.data ?? [];
  if (rows.length === 0) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_PROFILE_MISSING);
  const profileKeys = new Set(rows.map((row: any) => row.profile_key).filter(Boolean));
  if (profileKeys.size > 1) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_PROFILE_AMBIGUOUS);
  return rows[0];
}

async function loadClaimsForDocument(supabaseAdmin: any, context: PackageRuntimeContext) {
  const result = await selectRows(
    supabaseAdmin
      .from("lease_claims")
      .select("id, org_id, uploaded_file_id, extraction_run_id, generation_id, concept_key, scope_key, instance_key, assertion_status, normalized_value, raw_value_text, confidence, created_at, registry_status, producer_type, metadata")
      .eq("org_id", context.orgId)
      .eq("uploaded_file_id", context.uploadedFileId)
      .eq("generation_id", context.generationId),
  );
  if (result.error) throw new Error(`lease_claims fetch failed: ${result.error.message}`);
  return result.data ?? [];
}

function toMembershipClaimSignals(claims: any[]) {
  return claims.map((claim) => ({
    id: claim.id,
    uploadedFileId: claim.uploaded_file_id,
    extractionRunId: claim.extraction_run_id,
    generationId: claim.generation_id,
    conceptKey: claim.concept_key,
    normalizedValue: claim.normalized_value ?? null,
    assertionStatus: claim.assertion_status,
  }));
}

async function loadPackageDocuments(supabaseAdmin: any, orgId: string, packageId: string) {
  const result = await selectRows(
    supabaseAdmin
      .from("lease_package_documents")
      .select("id, org_id, package_id, uploaded_file_id, extraction_run_id, generation_id, canonical_profile_record_id, membership_role, membership_status")
      .eq("org_id", orgId)
      .eq("package_id", packageId)
      .in("membership_status", ["confirmed", "proposed", "ambiguous"]),
  );
  if (result.error) throw new Error(`lease_package_documents fetch failed: ${result.error.message}`);
  return result.data ?? [];
}

async function loadProfilesForPackageDocuments(supabaseAdmin: any, orgId: string, documents: any[]) {
  const byDocument = new Map();
  await Promise.all(documents.map(async (doc) => {
    const result = await selectRows(
      supabaseAdmin
        .from("lease_document_profile_records")
        .select("id, profile_key")
        .eq("org_id", orgId)
        .eq("uploaded_file_id", doc.uploaded_file_id)
        .eq("generation_id", doc.generation_id),
    );
    const profile = (result.data ?? []).find((row: any) => row.id === doc.canonical_profile_record_id) ?? (result.data ?? [])[0];
    byDocument.set(doc.id, profile?.profile_key ?? "unclassified");
  }));
  return byDocument;
}

async function loadPackageClaims(supabaseAdmin: any, orgId: string, documents: any[]) {
  const rows: any[] = [];
  const claimToDocument = new Map();
  await Promise.all(documents.map(async (doc) => {
    const result = await selectRows(
      supabaseAdmin
        .from("lease_claims")
        .select("id, org_id, uploaded_file_id, extraction_run_id, generation_id, concept_key, scope_key, instance_key, assertion_status, normalized_value, raw_value_text, confidence, created_at, registry_status, producer_type, metadata")
        .eq("org_id", orgId)
        .eq("uploaded_file_id", doc.uploaded_file_id)
        .eq("extraction_run_id", doc.extraction_run_id)
        .eq("generation_id", doc.generation_id),
    );
    for (const claim of result.data ?? []) {
      rows.push(claim);
      claimToDocument.set(claim.id, doc.id);
    }
  }));

  const evidenceResult = await selectRows(
    supabaseAdmin
      .from("lease_claim_evidence_links")
      .select("claim_id")
      .eq("org_id", orgId),
  );
  const evidenceIds = new Set((evidenceResult.data ?? []).map((row: any) => row.claim_id));
  return rows.map((claim) => ({
    id: claim.id,
    claimId: claim.id,
    orgId: claim.org_id,
    packageDocumentId: claimToDocument.get(claim.id),
    uploadedFileId: claim.uploaded_file_id,
    extractionRunId: claim.extraction_run_id,
    generationId: claim.generation_id,
    conceptKey: claim.concept_key,
    scopeKey: claim.scope_key ?? "lease",
    instanceKey: claim.instance_key ?? "default",
    assertionStatus: claim.assertion_status,
    normalizedValue: claim.normalized_value ?? null,
    rawValueText: claim.raw_value_text ?? null,
    confidence: claim.confidence == null ? null : Number(claim.confidence),
    createdAt: claim.created_at ?? null,
    registryStatus: claim.registry_status,
    producerType: claim.producer_type,
    hasEvidence: evidenceIds.has(claim.id),
    originalFieldKey: claim.metadata?.original_field_key ?? null,
    originalLabel: claim.metadata?.original_label ?? null,
  }));
}

async function loadPackageRelationships(supabaseAdmin: any, orgId: string, packageId: string) {
  const result = await selectRows(
    supabaseAdmin
      .from("lease_document_relationships")
      .select("id, org_id, package_id, source_package_document_id, target_package_document_id, relationship_type, relationship_status, validation_status, generation_id, evidence_claim_id")
      .eq("org_id", orgId)
      .eq("package_id", packageId),
  );
  if (result.error) throw new Error(`lease_document_relationships fetch failed: ${result.error.message}`);
  return (result.data ?? []).map((row: any) => ({
    id: row.id,
    orgId: row.org_id,
    packageId: row.package_id,
    sourcePackageDocumentId: row.source_package_document_id,
    targetPackageDocumentId: row.target_package_document_id,
    relationshipType: row.relationship_type,
    relationshipStatus: row.relationship_status,
    validationStatus: row.validation_status,
    generationId: row.generation_id,
    evidenceClaimId: row.evidence_claim_id,
    evidenceClaimIds: row.evidence_claim_id ? [row.evidence_claim_id] : [],
  }));
}

async function loadPackageRequirements(supabaseAdmin: any, orgId: string, packageId: string) {
  const result = await selectRows(
    supabaseAdmin
      .from("lease_related_document_requirements")
      .select("id, org_id, package_id, requesting_package_document_id, requirement_type, requirement_status, reason_code")
      .eq("org_id", orgId)
      .eq("package_id", packageId),
  );
  if (result.error) throw new Error(`lease_related_document_requirements fetch failed: ${result.error.message}`);
  return (result.data ?? []).map((row: any) => ({
    id: row.id,
    orgId: row.org_id,
    packageId: row.package_id,
    requestingPackageDocumentId: row.requesting_package_document_id,
    requirementType: row.requirement_type,
    requirementStatus: row.requirement_status,
    reasonCode: row.reason_code,
  }));
}

async function loadLatestCompletedResolution(supabaseAdmin: any, orgId: string, packageId: string) {
  const result = await maybeSingle(
    supabaseAdmin
      .from("lease_package_resolution_runs")
      .select("id, org_id, package_id, lease_id, status, resolution_version")
      .eq("org_id", orgId)
      .eq("package_id", packageId)
      .eq("status", "completed")
      .order("completed_at", { ascending: false })
      .limit(1),
  );
  if (result.error) throw new Error(`lease_package_resolution_runs fetch failed: ${result.error.message}`);
  return result.data ?? null;
}

async function loadCompletedResolutionRows(supabaseAdmin: any, orgId: string, packageId: string, resolutionRun: any) {
  const effectiveResult = await selectRows(
    supabaseAdmin
      .from("lease_package_effective_claims")
      .select("id, concept_key, scope_key, instance_key, effective_status, selected_source_claim_id, base_source_claim_id, overriding_source_claim_id, selected_package_document_id, source_relationship_id, precedence_rule, resolution_reason, related_document_requirement_id")
      .eq("org_id", orgId)
      .eq("resolution_run_id", resolutionRun.id),
  );
  const conflictResult = await selectRows(
    supabaseAdmin
      .from("lease_package_resolution_conflicts")
      .select("conflict_key, concept_key, scope_key, instance_key, conflict_type, candidate_claim_ids, candidate_relationship_ids, reason_codes")
      .eq("org_id", orgId)
      .eq("resolution_run_id", resolutionRun.id),
  );
  return {
    resolutionRun: {
      id: resolutionRun.id,
      orgId,
      packageId,
      leaseId: resolutionRun.lease_id ?? null,
      status: "completed",
      resolutionVersion: resolutionRun.resolution_version,
    },
    effectiveClaims: (effectiveResult.data ?? []).map((row: any) => ({
      conceptKey: row.concept_key,
      scopeKey: row.scope_key ?? "lease",
      instanceKey: row.instance_key ?? "default",
      status: row.effective_status,
      selectedClaimId: row.selected_source_claim_id ?? undefined,
      baseClaimId: row.base_source_claim_id ?? undefined,
      overridingClaimId: row.overriding_source_claim_id ?? undefined,
      sourcePackageDocumentId: row.selected_package_document_id ?? undefined,
      sourceRelationshipId: row.source_relationship_id ?? undefined,
      precedenceRule: row.precedence_rule ?? "persisted_package_resolution",
      reasonCodes: row.resolution_reason ? String(row.resolution_reason).split(",").filter(Boolean) : [],
      relationshipPath: [],
      relatedDocumentRequirementId: row.related_document_requirement_id ?? undefined,
    })),
    conflicts: (conflictResult.data ?? []).map((row: any) => ({
      conflictKey: row.conflict_key,
      conceptKey: row.concept_key,
      scopeKey: row.scope_key ?? "lease",
      instanceKey: row.instance_key ?? "default",
      conflictType: row.conflict_type,
      candidateClaimIds: row.candidate_claim_ids ?? [],
      candidateRelationshipIds: row.candidate_relationship_ids ?? [],
      reasonCodes: row.reason_codes ?? [],
    })),
  };
}

async function persistCompatibilityWriteBack(supabaseAdmin: any, context: PackageRuntimeContext, params: {
  leaseId: string | null;
  packageId: string;
  resolutionRunId: string;
  projectionRunId: string;
  compatibilitySlice: unknown;
}) {
  const idempotencyKey = [
    "p3.7",
    context.orgId,
    context.uploadedFileId,
    context.generationId,
    params.packageId,
    params.resolutionRunId,
    params.projectionRunId,
    PACKAGE_PROJECTION_VERSION,
  ].join(":");
  const { data, error } = await supabaseAdmin.rpc("persist_lease_package_claim_projection", {
    p_org_id: context.orgId,
    p_uploaded_file_id: context.uploadedFileId,
    p_lease_id: params.leaseId,
    p_generation_id: context.generationId,
    p_extraction_run_id: context.extractionRunId,
    p_package_id: params.packageId,
    p_package_resolution_run_id: params.resolutionRunId,
    p_package_projection_run_id: params.projectionRunId,
    p_compatibility_patch: params.compatibilitySlice,
    p_idempotency_key: idempotencyKey,
  });
  if (error || !data?.success) {
    throw new Error(`persist_lease_package_claim_projection failed: ${error?.message ?? data?.error_code ?? "unknown"}`);
  }
  return data;
}

export async function runLeaseDocumentPackagePipeline(
  supabaseAdmin: any,
  context: PackageRuntimeContext,
  input: PackageRuntimeInput = {},
  envLike?: PackageRuntimeEnvLike,
): Promise<PackageRuntimeResult> {
  const modes = resolvePackageRuntimeModes(envLike);
  if (modes.packageMode === "off") return disabledPackageRuntimeResult();
  validatePackageRuntimeModeCombination(modes);

  const activeWrites = modes.packageMode === "active";
  const [{ leaseId, isLegacySourceDocument }, _p2] = await Promise.all([
    fetchActiveFileAndLease(supabaseAdmin, context),
    verifyP2LedgerAndProjection(supabaseAdmin, context),
    verifyExtractionRun(supabaseAdmin, context),
  ]);
  const [profile, documentClaims] = await Promise.all([
    loadProfile(supabaseAdmin, context),
    loadClaimsForDocument(supabaseAdmin, context),
  ]);

  const membership = await resolvePackageMembershipForDocument(supabaseAdmin, {
    orgId: context.orgId,
    uploadedFileId: context.uploadedFileId,
    extractionRunId: context.extractionRunId,
    generationId: context.generationId,
    profileKey: profile.profile_key ?? "unclassified",
    claims: toMembershipClaimSignals(documentClaims),
    leaseId,
    isLegacySourceDocument,
  });

  if (!membership.packageId || membership.decision?.decision === "ambiguous") {
    return {
      ...failedPackageRuntimeResult(modes.packageMode, membership.decision?.decision === "ambiguous"
        ? PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_MEMBERSHIP_AMBIGUOUS
        : PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_MEMBERSHIP_MISSING),
      membershipDecisionId: membership.decisionLogId,
      status: membership.decision?.decision === "requires_related_document" ? "requires_related_document" : "needs_review",
    };
  }

  const packageDocuments = await loadPackageDocuments(supabaseAdmin, context.orgId, membership.packageId);
  const profileByDocument = await loadProfilesForPackageDocuments(supabaseAdmin, context.orgId, packageDocuments);
  const documents = packageDocuments.map((doc: any) => ({
    id: doc.id,
    orgId: doc.org_id,
    packageId: doc.package_id,
    uploadedFileId: doc.uploaded_file_id,
    extractionRunId: doc.extraction_run_id,
    generationId: doc.generation_id,
    profileKey: profileByDocument.get(doc.id) ?? "unclassified",
    membershipRole: doc.membership_role,
    membershipStatus: doc.membership_status,
  }));
  const packageClaims = await loadPackageClaims(supabaseAdmin, context.orgId, packageDocuments);

  const relationshipResult = await detectRelationshipsForPackage(supabaseAdmin, {
    orgId: context.orgId,
    packageId: membership.packageId,
    detectorContractVersion: RELATIONSHIP_DETECTOR_CONTRACT_VERSION,
    packagePrimaryDocumentId: packageDocuments.find((doc: any) => doc.membership_role === "primary_base_document")?.id ?? null,
    documents,
    claims: packageClaims,
  }, { allowActiveWrites: activeWrites });

  const relationships = await loadPackageRelationships(supabaseAdmin, context.orgId, membership.packageId);
  const requirements = await loadPackageRequirements(supabaseAdmin, context.orgId, membership.packageId);
  let completedResolution = await loadLatestCompletedResolution(supabaseAdmin, context.orgId, membership.packageId);
  let resolutionRows;
  if (completedResolution) {
    resolutionRows = await loadCompletedResolutionRows(supabaseAdmin, context.orgId, membership.packageId, completedResolution);
  } else {
    const resolution = await resolvePackageClaimsForPackage(supabaseAdmin, {
      orgId: context.orgId,
      packageId: membership.packageId,
      leaseId,
      documents,
      claims: packageClaims,
      relationships,
      requirements,
    }, { allowActiveWrites: activeWrites });
    const resolutionRunId = unwrapRpcId(resolution.persistResult, "resolution_run_id");
    if (!resolutionRunId) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_RESOLUTION_MISSING);
    completedResolution = { id: resolutionRunId, org_id: context.orgId, package_id: membership.packageId, lease_id: leaseId, status: "completed" };
    resolutionRows = {
      resolutionRun: { id: resolutionRunId, orgId: context.orgId, packageId: membership.packageId, leaseId, status: "completed" },
      effectiveClaims: resolution.resolutions,
      conflicts: resolution.conflicts,
    };
  }

  const projection = await projectPackageCompatibilityForResolution(supabaseAdmin, {
    orgId: context.orgId,
    packageId: membership.packageId,
    leaseId,
    resolutionRun: resolutionRows.resolutionRun,
    documents,
    sourceClaims: packageClaims,
    effectiveClaims: resolutionRows.effectiveClaims,
    conflicts: resolutionRows.conflicts,
    requirements,
  }, {
    singleDocumentCompatibility: input.singleDocumentCompatibility ?? null,
    allowActiveWrites: activeWrites,
  });
  const projectionRunId = unwrapRpcId(projection.persistResult, "projection_run_id");
  if (!projectionRunId) throw new PackageRuntimeError(PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_PROJECTION_MISSING);

  let compatibilityPersisted = false;
  if (modes.packageMode === "active") {
    await persistCompatibilityWriteBack(supabaseAdmin, context, {
      leaseId,
      packageId: membership.packageId,
      resolutionRunId: resolutionRows.resolutionRun.id,
      projectionRunId,
      compatibilitySlice: projection.compatibilitySlice,
    });
    compatibilityPersisted = true;
  }

  const hasConflicts = (projection.metadata?.needsReviewFieldCount ?? 0) > 0 || (resolutionRows.conflicts ?? []).length > 0;
  const hasRelatedDocumentNeed = (projection.metadata?.requiresRelatedDocumentCount ?? 0) > 0;
  return {
    enabled: true,
    mode: modes.packageMode,
    claimsMode: modes.claimsMode,
    packageId: membership.packageId,
    membershipDecisionId: membership.decisionLogId,
    relationshipCount: relationshipResult.candidates.length,
    resolutionRunId: resolutionRows.resolutionRun.id,
    projectionRunId,
    diffStatus: projection.diffSummary ? "recorded" : "comparison_unavailable",
    compatibilityPersisted,
    status: hasConflicts ? "needs_review" : hasRelatedDocumentNeed ? "requires_related_document" : "completed",
  };
}

export async function maybeRunLeaseDocumentPackagePipeline(
  supabaseAdmin: any,
  context: PackageRuntimeContext,
  input: PackageRuntimeInput = {},
  envLike?: PackageRuntimeEnvLike,
): Promise<PackageRuntimeResult | null> {
  const mode = getLeaseDocumentPackageMode(envLike);
  if (mode === "off") return disabledPackageRuntimeResult();
  try {
    return await runLeaseDocumentPackagePipeline(supabaseAdmin, context, input, envLike);
  } catch (error) {
    const errorCode = error instanceof PackageRuntimeError
      ? error.errorCode
      : PACKAGE_RUNTIME_ERROR_CODES.PACKAGE_RUNTIME_FAILED;
    console.error(`[lease-document-package-runtime] package pipeline failed mode=${mode} error_code=${errorCode}:`, error?.message ?? error);
    if (mode === "active") throw error;
    return failedPackageRuntimeResult(mode, errorCode);
  }
}

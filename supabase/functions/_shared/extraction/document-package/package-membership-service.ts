// @ts-nocheck
/**
 * Package-membership service — P3.3.
 *
 * Orchestrates candidate-finder -> resolver -> P3.2 RPCs, gated by
 * LEASE_DOCUMENT_PACKAGE_MODE. No pipeline call site invokes this yet
 * (reserved for P3.7) -- it exists to be called directly by isolated
 * service-level tests (and, later, by an orchestration harness in shadow
 * mode), exactly like claims-pipeline-orchestrator.ts's
 * runClaimsLedgerForStage was built ahead of its P2.7 pipeline wiring.
 *
 * Mode behavior:
 *   off:    resolver runs (if called directly), nothing is persisted.
 *   shadow: candidates/decision computed, decision-log + package/membership
 *           writes ARE persisted (this is the isolated orchestration path
 *           the mode's own docstring describes) -- legacy source-document
 *           behavior remains authoritative and untouched.
 *   active: recognized, but this module still requires an explicit
 *           opts.allowActiveWrites=true to persist -- there is no pipeline
 *           call site that could accidentally enable it in P3.3.
 */

import { getLeaseDocumentPackageMode } from "./feature-mode.ts";
import { computeDecisionKey, computeMembershipKey, computePackageKey } from "./package-membership-key.ts";
import { resolvePackageMembership } from "./package-membership-resolver.ts";
import {
  findPackageCandidatesByExplicitReference,
  findPackageCandidatesForLease,
  mergeCandidates,
} from "./package-candidate-finder.ts";
import type { MembershipClaimSignal, PackageMembershipDecision } from "./package-membership-types.ts";
import type { DocumentProfileKey } from "./profile-types.ts";

export interface ResolveMembershipContext {
  orgId: string;
  uploadedFileId: string;
  extractionRunId: string;
  generationId: string;
  profileKey: DocumentProfileKey | "unclassified";
  claims: MembershipClaimSignal[];
  leaseId: string | null;
  isLegacySourceDocument: boolean;
}

export interface ResolveMembershipResult {
  decision: PackageMembershipDecision;
  persisted: boolean;
  packageId?: string;
  membershipId?: string;
  decisionLogId?: string;
  requirementId?: string;
}

export async function resolvePackageMembershipForDocument(
  supabaseAdmin: any,
  context: ResolveMembershipContext,
): Promise<ResolveMembershipResult> {
  const candidateTiers = [];
  if (context.leaseId) {
    candidateTiers.push(
      await findPackageCandidatesForLease(supabaseAdmin, {
        orgId: context.orgId,
        leaseId: context.leaseId,
        matchedVia: context.isLegacySourceDocument ? "legacy_source_file" : "explicit_lease_linkage",
      }),
    );
  }
  candidateTiers.push(
    await findPackageCandidatesByExplicitReference(supabaseAdmin, { orgId: context.orgId, claims: context.claims }),
  );

  const decision = resolvePackageMembership({
    profileKey: context.profileKey,
    claims: context.claims,
    leaseLinkage: {
      leaseId: context.leaseId,
      isLegacySourceDocument: context.isLegacySourceDocument,
      propertyId: null,
      unitId: null,
      tenantId: null,
    },
    candidates: mergeCandidates(...candidateTiers),
  });

  const mode = getLeaseDocumentPackageMode();
  if (mode === "off") {
    return { decision, persisted: false };
  }

  return persistMembershipDecision(supabaseAdmin, context, decision);
}

async function persistMembershipDecision(
  supabaseAdmin: any,
  context: ResolveMembershipContext,
  decision: PackageMembershipDecision,
): Promise<ResolveMembershipResult> {
  const decisionKey = computeDecisionKey({
    orgId: context.orgId,
    uploadedFileId: context.uploadedFileId,
    extractionRunId: context.extractionRunId,
    generationId: context.generationId,
  });

  let packageId: string | undefined = decision.packageId;
  let membershipId: string | undefined;

  if (decision.decision === "create_package" || (decision.decision === "requires_related_document" && !packageId)) {
    const packageKey = computePackageKey({
      orgId: context.orgId,
      leaseId: context.leaseId,
      canonicalPrimaryUploadedFileId: context.uploadedFileId,
    });
    const createResult = await supabaseAdmin.rpc("create_lease_document_package", {
      p_org_id: context.orgId,
      p_lease_id: context.leaseId,
      p_package_key: packageKey,
    });
    if (createResult.error || !createResult.data?.success) {
      throw new Error(`create_lease_document_package failed: ${createResult.error?.message ?? createResult.data?.error_code}`);
    }
    packageId = createResult.data.package_id;
  }

  if (packageId && !membershipId && decision.decision !== "ambiguous" && decision.decision !== "propose_existing_package" && decision.decision !== "unsupported") {
    const membershipKey = computeMembershipKey({
      orgId: context.orgId,
      packageId,
      uploadedFileId: context.uploadedFileId,
      generationId: context.generationId,
      membershipRole: decision.membershipRole,
    });
    const addResult = await supabaseAdmin.rpc("add_document_to_lease_package", {
      p_org_id: context.orgId,
      p_package_id: packageId,
      p_uploaded_file_id: context.uploadedFileId,
      p_extraction_run_id: context.extractionRunId,
      p_generation_id: context.generationId,
      p_membership_role: decision.membershipRole,
      p_membership_source: decision.membershipSource === "reviewer" ? "reviewer" : decision.membershipSource,
      p_membership_key: membershipKey,
    });
    if (addResult.error || !addResult.data?.success) {
      throw new Error(`add_document_to_lease_package failed: ${addResult.error?.message ?? addResult.data?.error_code}`);
    }
    membershipId = addResult.data.membership_id;

    if (decision.membershipStatus === "confirmed") {
      const transitionResult = await supabaseAdmin.rpc("transition_package_document_membership", {
        p_org_id: context.orgId,
        p_membership_id: membershipId,
        p_new_status: "confirmed",
      });
      if (transitionResult.error || !transitionResult.data?.success) {
        throw new Error(`transition_package_document_membership failed: ${transitionResult.error?.message ?? transitionResult.data?.error_code}`);
      }
    }
  }

  let requirementId: string | undefined;
  if (decision.relatedDocumentRequirement && membershipId) {
    const requirementResult = await supabaseAdmin.rpc("record_related_document_requirement", {
      p_org_id: context.orgId,
      p_package_id: packageId,
      p_requesting_package_document_id: membershipId,
      p_requirement_type: decision.relatedDocumentRequirement.requirementType,
      p_reason_code: decision.relatedDocumentRequirement.reasonCode,
      p_evidence_claim_id: decision.evidenceClaimIds[0] ?? null,
    });
    if (!requirementResult.error && requirementResult.data?.success) {
      requirementId = requirementResult.data.requirement_id;
    }
  }

  const { data: insertedDecision, error: insertError } = await supabaseAdmin
    .from("lease_package_membership_decisions")
    .insert({
      org_id: context.orgId,
      uploaded_file_id: context.uploadedFileId,
      extraction_run_id: context.extractionRunId,
      generation_id: context.generationId,
      package_id: packageId ?? null,
      membership_id: membershipId ?? null,
      decision: decision.decision,
      membership_role: decision.membershipRole,
      membership_status: decision.membershipStatus,
      membership_source: decision.membershipSource,
      confidence: decision.confidence ?? null,
      reason_codes: decision.reasonCodes,
      evidence_claim_ids: decision.evidenceClaimIds,
      candidate_package_ids: decision.candidatePackageIds ?? [],
      related_document_requirement_type: decision.relatedDocumentRequirement?.requirementType ?? null,
      related_document_requirement_reason: decision.relatedDocumentRequirement?.reasonCode ?? null,
      decision_key: decisionKey,
    })
    .select("id")
    .maybeSingle();

  let decisionLogId = insertedDecision?.id;
  if (insertError) {
    // Idempotent replay: the same generation already produced a decision row.
    const { data: existing } = await supabaseAdmin
      .from("lease_package_membership_decisions")
      .select("id")
      .eq("org_id", context.orgId)
      .eq("decision_key", decisionKey)
      .maybeSingle();
    decisionLogId = existing?.id;
    if (!decisionLogId) throw new Error(`lease_package_membership_decisions insert failed: ${insertError.message}`);
  }

  return { decision, persisted: true, packageId, membershipId, decisionLogId, requirementId };
}

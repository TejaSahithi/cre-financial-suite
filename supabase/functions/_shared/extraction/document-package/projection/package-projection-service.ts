// @ts-nocheck
/**
 * P3.6 package projection service.
 *
 * No runtime pipeline imports this module. Mode=off computes only. Shadow may
 * persist isolated package projection records; active remains recognized but
 * requires explicit local/test opt-in.
 */

import { CLAIMS_REGISTRY_VERSION } from "../../claims/registry-version.ts";
import { computeRegistryHash } from "../../claims/concept-registry.ts";
import type { CompatibilityExtractionData } from "../../claims/adapters/compatibility-payload-builder.ts";
import { DOCUMENT_PROFILE_REGISTRY_VERSION } from "../profile-registry-version.ts";
import { computeDocumentProfileRegistryHash } from "../profile-registry.ts";
import { getLeaseDocumentPackageMode } from "../feature-mode.ts";
import { PACKAGE_RESOLUTION_VERSION } from "../resolution/package-resolution-version.ts";
import { buildPackageFieldProjection } from "./package-field-projector.ts";
import {
  buildPackageCompatibilityExtractionDataSlice,
  buildPackageCompatibilityProjectionMetadata,
} from "./package-compatibility-payload-builder.ts";
import { diffPackageCompatibilityFields, summarizePackageDiff } from "./package-projection-diff.ts";
import { hashPackageProjectionInput } from "./package-projection-key.ts";
import { PACKAGE_PROJECTION_VERSION, P2_FIELD_PROJECTION_VERSION } from "./package-projection-version.ts";
import type { PackageProjectionInput, PackageProjectionServiceResult } from "./package-projection-types.ts";

export interface BuildPackageProjectionOptions {
  singleDocumentCompatibility?: CompatibilityExtractionData | null;
  allowActiveWrites?: boolean;
}

export function buildPackageCompatibilityProjection(input: PackageProjectionInput) {
  const fieldProjection = buildPackageFieldProjection(input);
  const compatibilitySlice = buildPackageCompatibilityExtractionDataSlice(fieldProjection);
  const metadata = buildPackageCompatibilityProjectionMetadata(fieldProjection);
  return { fieldProjection, compatibilitySlice, metadata };
}

async function buildProjectionHash(input: PackageProjectionInput): Promise<string> {
  return await hashPackageProjectionInput(input.effectiveClaims);
}

export async function projectPackageCompatibilityForResolution(
  supabaseAdmin: any,
  input: PackageProjectionInput,
  opts: BuildPackageProjectionOptions = {},
): Promise<PackageProjectionServiceResult> {
  const projection = buildPackageCompatibilityProjection(input);
  const diff = opts.singleDocumentCompatibility
    ? diffPackageCompatibilityFields(opts.singleDocumentCompatibility.fields, projection.compatibilitySlice.fields, projection.fieldProjection)
    : undefined;
  const diffSummary = diff ? summarizePackageDiff(diff) : undefined;
  const mode = getLeaseDocumentPackageMode();
  if (mode === "off" || (mode === "active" && opts.allowActiveWrites !== true)) {
    return { ...projection, diff, diffSummary, persisted: false };
  }

  const persistResult = await persistPackageProjection(supabaseAdmin, input, projection, diff ?? [], diffSummary ?? {}, mode);
  return { ...projection, diff, diffSummary, persisted: true, persistResult };
}

export async function persistPackageProjection(
  supabaseAdmin: any,
  input: PackageProjectionInput,
  projection: ReturnType<typeof buildPackageCompatibilityProjection>,
  diff: unknown[],
  diffSummary: Record<string, number>,
  mode: string,
): Promise<unknown> {
  const [claimsRegistryHash, profileRegistryHash, inputHash] = await Promise.all([
    computeRegistryHash(),
    computeDocumentProfileRegistryHash(),
    buildProjectionHash(input),
  ]);
  const { data, error } = await supabaseAdmin.rpc("persist_lease_package_projection", {
    p_org_id: input.orgId,
    p_package_id: input.packageId,
    p_resolution_run_id: input.resolutionRun.id,
    p_projection_run: {
      lease_id: input.leaseId ?? input.resolutionRun.leaseId ?? null,
      package_projection_version: PACKAGE_PROJECTION_VERSION,
      p2_projection_version: P2_FIELD_PROJECTION_VERSION,
      claims_registry_version: CLAIMS_REGISTRY_VERSION,
      claims_registry_hash: claimsRegistryHash,
      profile_registry_version: DOCUMENT_PROFILE_REGISTRY_VERSION,
      profile_registry_hash: profileRegistryHash,
      compatibility_contract_version: CLAIMS_REGISTRY_VERSION,
      package_resolution_version: input.resolutionRun.resolutionVersion ?? PACKAGE_RESOLUTION_VERSION,
      mode,
      input_effective_claim_count: input.effectiveClaims.length,
      input_effective_claims_hash: inputHash,
      output_field_count: projection.metadata.projectedFieldCount,
      inherited_field_count: projection.metadata.inheritedFieldCount,
      overridden_field_count: projection.metadata.overriddenFieldCount,
      needs_review_field_count: projection.metadata.needsReviewFieldCount,
      requires_related_document_count: projection.metadata.requiresRelatedDocumentCount,
      dynamic_field_count: projection.metadata.dynamicFieldCount,
      conflict_count: projection.metadata.conflictCount,
    },
    p_field_projections: projection.fieldProjection.map((row) => ({
      fieldKey: row.fieldKey,
      instanceKey: row.instanceKey,
      conceptKey: row.conceptKey,
      selectedSourceClaimId: row.selectedSourceClaimId,
      baseSourceClaimId: row.baseSourceClaimId,
      overridingSourceClaimId: row.overridingSourceClaimId,
      sourcePackageDocumentId: row.sourcePackageDocumentId,
      sourceRelationshipId: row.sourceRelationshipId,
      normalizedValue: row.value,
      displayValue: row.value,
      extractionStatus: projection.compatibilitySlice.fields[row.fieldKey]?.extraction_status ?? null,
      confidence: row.confidence,
      evidenceSummary: {
        source_page: row.sourcePage,
        has_source_text: Boolean(row.sourceText),
        package_status: row.packageStatus,
      },
      packageStatus: row.packageStatus,
      precedenceRule: row.precedenceRule,
      projectionReason: row.projectionReason,
      relationshipPath: row.relationshipPath,
      relatedDocumentRequirementId: row.relatedDocumentRequirementId,
    })),
    p_projection_diff: {
      differences: diff,
      summary: diffSummary,
    },
  });
  if (error || !data?.success) {
    throw new Error(`persist_lease_package_projection failed: ${error?.message ?? data?.error_code ?? "unknown"}`);
  }
  return data;
}

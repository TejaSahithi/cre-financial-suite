// @ts-nocheck
/**
 * P3.5 package-resolution service.
 *
 * No existing pipeline imports this. Mode=off computes only. Mode=shadow may
 * persist an isolated resolution run through a bounded RPC. Active is parsed
 * but still requires an explicit test/local opt-in during P3.5.
 */

import { CLAIMS_REGISTRY_VERSION } from "../../claims/registry-version.ts";
import { computeRegistryHash } from "../../claims/concept-registry.ts";
import { DOCUMENT_PROFILE_REGISTRY_VERSION } from "../profile-registry-version.ts";
import { computeDocumentProfileRegistryHash } from "../profile-registry.ts";
import { getLeaseDocumentPackageMode } from "../feature-mode.ts";
import { RELATIONSHIP_DETECTOR_CONTRACT_VERSION } from "../relationships/relationship-types.ts";
import { resolvePackageClaims } from "./package-claim-resolver.ts";
import { hashResolutionInput } from "./package-resolution-key.ts";
import { PACKAGE_RESOLUTION_VERSION } from "./package-resolution-version.ts";
import type { PackageResolutionInput, PackageResolutionResult } from "./package-resolution-types.ts";

export interface ResolvePackageOptions {
  allowActiveWrites?: boolean;
}

export interface ResolvePackageResult extends PackageResolutionResult {
  persisted: boolean;
  persistResult?: unknown;
}

async function buildInputHashes(input: PackageResolutionInput) {
  return {
    input_package_documents_hash: await hashResolutionInput(input.documents),
    input_relationships_hash: await hashResolutionInput(input.relationships),
    input_claims_hash: await hashResolutionInput(input.claims),
  };
}

export async function resolvePackageClaimsForPackage(
  supabaseAdmin: any,
  input: PackageResolutionInput,
  opts: ResolvePackageOptions = {},
): Promise<ResolvePackageResult> {
  const result = resolvePackageClaims(input);
  const mode = getLeaseDocumentPackageMode();
  if (mode === "off" || (mode === "active" && opts.allowActiveWrites !== true)) {
    return { ...result, persisted: false };
  }

  const persistResult = await persistPackageResolution(supabaseAdmin, input, result, mode);
  return { ...result, persisted: true, persistResult };
}

export async function persistPackageResolution(
  supabaseAdmin: any,
  input: PackageResolutionInput,
  result: PackageResolutionResult,
  packageMode: string,
): Promise<unknown> {
  const hashes = await buildInputHashes(input);
  const [claimsRegistryHash, profileRegistryHash] = await Promise.all([
    computeRegistryHash(),
    computeDocumentProfileRegistryHash(),
  ]);
  const { data, error } = await supabaseAdmin.rpc("persist_lease_package_resolution", {
    p_org_id: input.orgId,
    p_package_id: input.packageId,
    p_resolution_run: {
      lease_id: input.leaseId ?? null,
      resolution_version: input.resolutionVersion ?? PACKAGE_RESOLUTION_VERSION,
      claims_registry_version: CLAIMS_REGISTRY_VERSION,
      claims_registry_hash: claimsRegistryHash,
      profile_registry_version: DOCUMENT_PROFILE_REGISTRY_VERSION,
      profile_registry_hash: profileRegistryHash,
      relationship_contract_version: RELATIONSHIP_DETECTOR_CONTRACT_VERSION,
      package_mode: packageMode,
      ...hashes,
      source_claim_count: input.claims.length,
      effective_claim_count: result.resolutions.length,
      override_count: result.overrides.length,
      inherited_claim_count: result.resolutions.filter((resolution) => resolution.status === "inherited").length,
      conflict_count: result.conflicts.length,
      related_document_requirement_count: result.resolutions.filter((resolution) => resolution.status === "requires_related_document").length,
    },
    p_effective_claims: result.resolutions,
    p_overrides: result.overrides,
    p_conflicts: result.conflicts,
  });
  if (error || !data?.success) {
    throw new Error(`persist_lease_package_resolution failed: ${error?.message ?? data?.error_code ?? "unknown"}`);
  }
  return data;
}

// @ts-nocheck
/**
 * P3.5 package-level conflict detector helpers.
 *
 * P3 conflicts are cross-document/package conflicts, not P2 same-generation
 * claim conflicts. The resolver preserves all candidates and marks the slot
 * needs_review rather than picking by confidence or recency.
 */

import { computePackageConflictKey } from "./package-resolution-key.ts";
import type { PackageConflict, PackageResolutionConflictType } from "./package-resolution-types.ts";

export function buildPackageConflict(params: {
  orgId: string;
  packageId: string;
  conceptKey: string;
  scopeKey: string;
  instanceKey: string;
  conflictType: PackageResolutionConflictType;
  candidateClaimIds: string[];
  candidateRelationshipIds: string[];
  reasonCodes?: string[];
  resolutionVersion?: string;
}): PackageConflict {
  const candidateClaimIds = [...new Set(params.candidateClaimIds)].sort();
  const candidateRelationshipIds = [...new Set(params.candidateRelationshipIds)].sort();
  return {
    conflictKey: computePackageConflictKey({
      orgId: params.orgId,
      packageId: params.packageId,
      conceptKey: params.conceptKey,
      scopeKey: params.scopeKey,
      instanceKey: params.instanceKey,
      conflictType: params.conflictType,
      candidateClaimIds,
      candidateRelationshipIds,
      resolutionVersion: params.resolutionVersion,
    }),
    conceptKey: params.conceptKey,
    scopeKey: params.scopeKey,
    instanceKey: params.instanceKey,
    conflictType: params.conflictType,
    candidateClaimIds,
    candidateRelationshipIds,
    reasonCodes: [...new Set(params.reasonCodes ?? ["COMPETING_CANDIDATES_NEED_REVIEW"])].sort(),
  };
}

export function conflictTypeForRelationshipTypes(types: string[]): PackageResolutionConflictType {
  const unique = new Set(types);
  if (unique.has("assigns")) return "competing_assignments";
  if (unique.has("resolves_commencement")) return "competing_commencement_certificates";
  if (unique.has("supersedes")) return "supersession_ambiguous";
  if (unique.has("amends")) return "multiple_explicit_overrides";
  if (unique.has("extends") || unique.has("renews")) return "amendment_order_ambiguous";
  return "relationship_ambiguous";
}

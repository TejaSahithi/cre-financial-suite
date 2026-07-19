// @ts-nocheck
/**
 * P3.6 adapter from package-effective claims to P2 field-projection input.
 */

import type { ClaimForProjection } from "../../claims/adapters/claims-to-field-projection.ts";
import type { PackageClaimResolution } from "../resolution/package-resolution-types.ts";
import type { PackageProjectionInput, PackageProjectionSourceClaim } from "./package-projection-types.ts";
import { validatePackageProjectionInput } from "./package-projection-validator.ts";

const VALUE_SELECTED = new Set(["effective", "inherited", "overridden"]);
const EXPLICIT_STATUS = new Set(["not_present", "not_applicable", "unreadable", "extraction_failed"]);

function factSlotKey(conceptKey: string, scopeKey = "lease", instanceKey = "default"): string {
  return `${conceptKey}|${scopeKey}|${instanceKey}`;
}

function sourceClaimId(claim: PackageProjectionSourceClaim): string {
  return claim.id ?? claim.claimId;
}

function createdAt(claim: PackageProjectionSourceClaim): string {
  return claim.createdAt ?? "2026-01-01T00:00:00.000Z";
}

export function selectedSourceClaimFor(
  input: PackageProjectionInput,
  resolution: PackageClaimResolution,
): PackageProjectionSourceClaim | null {
  if (!resolution.selectedClaimId) return null;
  return input.sourceClaims.find((claim) => sourceClaimId(claim) === resolution.selectedClaimId) ?? null;
}

export function adaptPackageEffectiveClaimsToProjectionInput(input: PackageProjectionInput): {
  claims: ClaimForProjection[];
  reviewDecisionsByFactSlot: Map<string, never[]>;
  openConflictFactSlots: Set<string>;
  effectiveClaimsByFactSlot: Map<string, PackageClaimResolution>;
} {
  validatePackageProjectionInput(input);

  const claims: ClaimForProjection[] = [];
  const openConflictFactSlots = new Set<string>();
  const effectiveClaimsByFactSlot = new Map<string, PackageClaimResolution>();

  for (const resolution of [...input.effectiveClaims].sort((a, b) =>
    factSlotKey(a.conceptKey, a.scopeKey, a.instanceKey).localeCompare(factSlotKey(b.conceptKey, b.scopeKey, b.instanceKey))
  )) {
    const scope = resolution.scopeKey || "lease";
    const instance = resolution.instanceKey || "default";
    const key = factSlotKey(resolution.conceptKey, scope, instance);
    effectiveClaimsByFactSlot.set(key, resolution);

    if (resolution.status === "needs_review") {
      openConflictFactSlots.add(key);
      continue;
    }
    if (!VALUE_SELECTED.has(resolution.status) && !EXPLICIT_STATUS.has(resolution.status)) continue;

    const selected = selectedSourceClaimFor(input, resolution);
    if (!selected) continue;
    claims.push({
      claimId: sourceClaimId(selected),
      conceptKey: selected.conceptKey,
      scopeKey: selected.scopeKey || scope,
      instanceKey: selected.instanceKey || instance,
      producerType: selected.producerType ?? "deterministic_mapper",
      assertionStatus: EXPLICIT_STATUS.has(resolution.status) ? resolution.status : selected.assertionStatus,
      normalizedValue: selected.normalizedValue,
      rawValueText: selected.rawValueText ?? selected.normalizedValue,
      sourcePage: selected.sourcePage ?? null,
      sourceText: selected.sourceText ?? null,
      confidence: selected.confidence ?? null,
      hasEvidence: selected.hasEvidence ?? Boolean(selected.sourceText),
      supersededByClaimId: selected.supersededByClaimId ?? null,
      createdAt: createdAt(selected),
    });
  }

  return {
    claims,
    reviewDecisionsByFactSlot: new Map(),
    openConflictFactSlots,
    effectiveClaimsByFactSlot,
  };
}

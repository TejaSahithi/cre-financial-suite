// @ts-nocheck
/**
 * Deterministic P3.5 package-resolution keys and input hashes.
 */

import { PACKAGE_RESOLUTION_VERSION } from "./package-resolution-version.ts";

function stablePart(value: unknown): string {
  if (value === null || value === undefined || value === "") return "none";
  if (Array.isArray(value)) return `[${value.map(stablePart).sort().join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${key}:${stablePart(item)}`)
      .join("|")}}`;
  }
  return String(value);
}

export async function hashResolutionInput(parts: unknown[]): Promise<string> {
  const canonical = stablePart(parts);
  const bytes = new TextEncoder().encode(`${PACKAGE_RESOLUTION_VERSION}\n${canonical}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function computeResolutionSlotKey(params: {
  orgId: string;
  packageId: string;
  conceptKey: string;
  scopeKey?: string | null;
  instanceKey?: string | null;
  resolutionVersion?: string;
}): string {
  return [
    "package-resolution-slot",
    stablePart(params.orgId),
    stablePart(params.packageId),
    stablePart(params.conceptKey),
    stablePart(params.scopeKey ?? "lease"),
    stablePart(params.instanceKey ?? "default"),
    stablePart(params.resolutionVersion ?? PACKAGE_RESOLUTION_VERSION),
  ].join(":");
}

export function computePackageConflictKey(params: {
  orgId: string;
  packageId: string;
  conceptKey: string;
  scopeKey?: string | null;
  instanceKey?: string | null;
  conflictType: string;
  candidateClaimIds?: string[];
  candidateRelationshipIds?: string[];
  resolutionVersion?: string;
}): string {
  return [
    "package-resolution-conflict",
    stablePart(params.orgId),
    stablePart(params.packageId),
    stablePart(params.conceptKey),
    stablePart(params.scopeKey ?? "lease"),
    stablePart(params.instanceKey ?? "default"),
    stablePart(params.conflictType),
    stablePart(params.candidateClaimIds ?? []),
    stablePart(params.candidateRelationshipIds ?? []),
    stablePart(params.resolutionVersion ?? PACKAGE_RESOLUTION_VERSION),
  ].join(":");
}

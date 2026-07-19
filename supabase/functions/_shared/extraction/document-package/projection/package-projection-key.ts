// @ts-nocheck
/**
 * Deterministic P3.6 package-projection keys and hashes.
 */

import { PACKAGE_PROJECTION_VERSION } from "./package-projection-version.ts";

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

export async function hashPackageProjectionInput(parts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(`${PACKAGE_PROJECTION_VERSION}\n${stablePart(parts)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function computePackageProjectionFieldKey(params: {
  orgId: string;
  packageId: string;
  projectionRunId?: string | null;
  fieldKey: string;
  instanceKey?: string | null;
}): string {
  return [
    "package-field-projection",
    stablePart(params.orgId),
    stablePart(params.packageId),
    stablePart(params.projectionRunId),
    stablePart(params.fieldKey),
    stablePart(params.instanceKey ?? "default"),
    PACKAGE_PROJECTION_VERSION,
  ].join(":");
}

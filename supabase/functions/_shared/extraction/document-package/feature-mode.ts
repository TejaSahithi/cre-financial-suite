// @ts-nocheck
/**
 * Lease Document Package — mode flag (P3.1).
 *
 * Direct structural copy of claims/feature-mode.ts (P2.2), itself a copy of
 * provenance/feature-flag.ts (P1.2) -- same injectable EnvLike, default-
 * closed on anything unrecognized, three real values:
 *   - "off":    no P3 package/profile/relationship runtime writes, no
 *               output changes (current behavior unchanged).
 *   - "shadow": classify documents/segments, build package/relationship
 *               records, compare against single-document behavior; runtime
 *               Lease Review output remains unchanged.
 *   - "active": recognized and parsed correctly in P3.1, but wired to
 *               nothing yet -- no runtime write path exists to gate until
 *               P3.7. Do not enable active mode during P3 local
 *               implementation (policy).
 * Invalid or unset resolves to "off" -- never throws, never defaults open.
 *
 * Read only server-side -- never accept a mode value from the request body.
 */

const FLAG_NAME = "LEASE_DOCUMENT_PACKAGE_MODE";

export type LeaseDocumentPackageMode = "off" | "shadow" | "active";

const VALID_MODES: ReadonlySet<LeaseDocumentPackageMode> = new Set(["off", "shadow", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseDocumentPackageMode(env: EnvLike = Deno.env): LeaseDocumentPackageMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  return VALID_MODES.has(raw) ? (raw as LeaseDocumentPackageMode) : "off";
}

export function isDocumentPackageActive(env: EnvLike = Deno.env): boolean {
  return getLeaseDocumentPackageMode(env) === "active";
}

export function isDocumentPackageAtLeastShadow(env: EnvLike = Deno.env): boolean {
  const mode = getLeaseDocumentPackageMode(env);
  return mode === "shadow" || mode === "active";
}

export const LEASE_DOCUMENT_PACKAGE_MODE_FLAG_NAME = FLAG_NAME;

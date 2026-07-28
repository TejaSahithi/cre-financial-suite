// @ts-nocheck
/**
 * Canonical Claim/Evidence Layer flag (Phase 2).
 *
 * Structural copy of llm-strict-outputs-mode.ts's convention (injectable
 * EnvLike, two real values, invalid/unset never throws, default OFF -- this
 * gates new, unproven diagnostics-only infrastructure, not a proven
 * improvement being pushed live).
 *
 *   - "active": orchestrator.ts additionally builds ExtractedClaim[] from
 *               the mapper/verifier/strict-shadow results this run already
 *               produced, runs evidence verification, and attaches them to
 *               extractionDebug.openai_fact_ledger.canonical_claims.
 *   - "off":    no claims are built at all. Zero behavior change, zero
 *               extra computation. Default.
 *
 * Purely additive either way -- never affects rows/method/warnings/
 * validationErrors or any existing extractionDebug key.
 */

import { isOrgAdmittedToCanary } from "./canary-gate.ts";

const FLAG_NAME = "LEASE_CANONICAL_CLAIMS_V1";
const ALLOWLIST_ENV_NAME = "LEASE_CANONICAL_CLAIMS_ORG_ALLOWLIST";
const SAMPLE_RATE_ENV_NAME = "LEASE_CANONICAL_CLAIMS_SAMPLE_RATE";

export type LeaseCanonicalClaimsMode = "off" | "active";

const VALID_MODES: ReadonlySet<LeaseCanonicalClaimsMode> = new Set(["off", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseCanonicalClaimsMode(env: EnvLike = Deno.env): LeaseCanonicalClaimsMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw as LeaseCanonicalClaimsMode;
  return "off";
}

export function isLeaseCanonicalClaimsActive(env: EnvLike = Deno.env): boolean {
  return getLeaseCanonicalClaimsMode(env) === "active";
}

/**
 * Full canary gate: top-level flag AND (org allowlist OR sample rate),
 * same convention as llm-strict-outputs-mode.ts's shouldRunStrictOutputsShadow.
 * Nothing calls this until the pipeline actually has an orgId/generationId
 * to gate on (orchestrator.ts only builds claims when a provenance context
 * was supplied at all -- see orchestrator.ts's canonicalClaimsContext).
 */
export function shouldBuildCanonicalClaims(
  args: { orgId: string; generationId: string },
  env: EnvLike = Deno.env,
): boolean {
  if (!isLeaseCanonicalClaimsActive(env)) return false;
  return isOrgAdmittedToCanary(
    { orgId: args.orgId, generationId: args.generationId, allowlistEnvVar: ALLOWLIST_ENV_NAME, sampleRateEnvVar: SAMPLE_RATE_ENV_NAME },
    env,
  );
}

export const LEASE_CANONICAL_CLAIMS_FLAG_NAME = FLAG_NAME;
export const LEASE_CANONICAL_CLAIMS_ORG_ALLOWLIST_FLAG_NAME = ALLOWLIST_ENV_NAME;
export const LEASE_CANONICAL_CLAIMS_SAMPLE_RATE_FLAG_NAME = SAMPLE_RATE_ENV_NAME;

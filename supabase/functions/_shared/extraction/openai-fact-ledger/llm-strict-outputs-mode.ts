// @ts-nocheck
/**
 * Strict Structured Outputs pilot — flag + canary gate (Phase 1, expenses_and_cam only).
 *
 * Structural copy of llm-primary-mapping-mode.ts's flag convention (injectable
 * EnvLike, two real values, invalid/unset never throws), with the opposite
 * default: this flag starts "off". LLM_PRIMARY_MAPPING_MODE defaults active
 * because it was a proven mapping improvement being pushed live; this one
 * gates an UNVERIFIED live-capability question (does the account's Azure
 * OpenAI deployment even accept `response_format: json_schema` in strict
 * mode?) with a shadow-only call that has no effect on the authoritative
 * result either way, so there is no reason to default it on.
 *
 * On top of the on/off flag, this module adds a canary gate so that turning
 * the flag on does not mean "every production extraction now fires a second
 * LLM call": LEASE_STRICT_OUTPUTS_ORG_ALLOWLIST (comma-separated org IDs) and
 * LEASE_STRICT_OUTPUTS_SAMPLE_RATE (0.0-1.0, deterministic per generation_id)
 * each independently admit a call into the shadow pilot; neither is required
 * if the other is set. Sampling is deterministic (a non-cryptographic hash
 * of generation_id, not Math.random()) so a retried generation gets the same
 * shadow-or-not decision every time, which matters for reproducing a
 * confusing shadow-diff result.
 *
 * Read only server-side -- never accept any of these three values from the
 * request body.
 */

const FLAG_NAME = "LEASE_STRICT_OUTPUTS_V1";
const ALLOWLIST_ENV_NAME = "LEASE_STRICT_OUTPUTS_ORG_ALLOWLIST";
const SAMPLE_RATE_ENV_NAME = "LEASE_STRICT_OUTPUTS_SAMPLE_RATE";

export type LeaseStrictOutputsMode = "off" | "active";

const VALID_MODES: ReadonlySet<LeaseStrictOutputsMode> = new Set(["off", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseStrictOutputsMode(env: EnvLike = Deno.env): LeaseStrictOutputsMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw as LeaseStrictOutputsMode;
  // Unset, or an unrecognized value (typo), both resolve to "off" -- the
  // opposite default from llm-primary-mapping-mode.ts, deliberately, per the
  // rationale above.
  return "off";
}

export function isLeaseStrictOutputsActive(env: EnvLike = Deno.env): boolean {
  return getLeaseStrictOutputsMode(env) === "active";
}

function parseOrgAllowlist(env: EnvLike): ReadonlySet<string> {
  const raw = String(env.get(ALLOWLIST_ENV_NAME) ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function parseSampleRate(env: EnvLike): number {
  const raw = env.get(SAMPLE_RATE_ENV_NAME);
  if (raw == null || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/**
 * Deterministic, non-cryptographic 32-bit hash (FNV-1a) normalized to
 * [0, 1). Not a security control -- just needs to be stable across calls for
 * the same input and roughly uniform, which FNV-1a is for this purpose.
 * crypto.subtle.digest is deliberately avoided here so the canary decision
 * can stay synchronous.
 */
function hashToUnitInterval(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * Whether this specific (org, generation) should fire the strict-outputs
 * shadow call. Pure and synchronous so it is unit-testable without touching
 * the extractor. False whenever the top-level flag is off, regardless of
 * allowlist/sample-rate configuration.
 */
export function shouldRunStrictOutputsShadow(
  args: { orgId: string; generationId: string },
  env: EnvLike = Deno.env,
): boolean {
  if (!isLeaseStrictOutputsActive(env)) return false;

  const allowlist = parseOrgAllowlist(env);
  if (allowlist.has(args.orgId)) return true;

  const sampleRate = parseSampleRate(env);
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return hashToUnitInterval(args.generationId) < sampleRate;
}

export const LEASE_STRICT_OUTPUTS_FLAG_NAME = FLAG_NAME;
export const LEASE_STRICT_OUTPUTS_ORG_ALLOWLIST_FLAG_NAME = ALLOWLIST_ENV_NAME;
export const LEASE_STRICT_OUTPUTS_SAMPLE_RATE_FLAG_NAME = SAMPLE_RATE_ENV_NAME;

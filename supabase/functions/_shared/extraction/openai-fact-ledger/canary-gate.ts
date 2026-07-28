// @ts-nocheck
/**
 * Shared canary-gating helpers -- org allowlist + deterministic sample rate.
 *
 * Extracted after this exact ~15-line pattern (allowlist parse, sample-rate
 * parse, FNV-1a hash to [0,1)) was independently needed a third time
 * (canonical-claims-mode.ts, multilabel-routing-mode.ts, after
 * llm-strict-outputs-mode.ts already had its own copy). llm-strict-outputs-mode.ts
 * is left as its own already-deployed, already-tested implementation rather
 * than refactored to depend on this -- no functional benefit to touching
 * verified, live code for a cosmetic dedupe.
 */

export interface EnvLike {
  get(key: string): string | undefined;
}

export function parseOrgAllowlist(env: EnvLike, envVarName: string): ReadonlySet<string> {
  const raw = String(env.get(envVarName) ?? "").trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export function parseSampleRate(env: EnvLike, envVarName: string): number {
  const raw = env.get(envVarName);
  if (raw == null || raw.trim() === "") return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(1, Math.max(0, parsed));
}

/** Deterministic, non-cryptographic 32-bit hash (FNV-1a) normalized to
 *  [0, 1) -- stable per input, not a security control. */
export function hashToUnitInterval(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0xffffffff;
}

/**
 * True when (orgId, generationId) is admitted to a canary gated by the
 * given allowlist/sample-rate env var pair. Callers still check their own
 * top-level on/off flag first -- this only answers "which org/generation,"
 * not "is the feature on at all."
 */
export function isOrgAdmittedToCanary(
  args: { orgId: string; generationId: string; allowlistEnvVar: string; sampleRateEnvVar: string },
  env: EnvLike = Deno.env,
): boolean {
  const allowlist = parseOrgAllowlist(env, args.allowlistEnvVar);
  if (allowlist.has(args.orgId)) return true;

  const sampleRate = parseSampleRate(env, args.sampleRateEnvVar);
  if (sampleRate <= 0) return false;
  if (sampleRate >= 1) return true;
  return hashToUnitInterval(args.generationId) < sampleRate;
}

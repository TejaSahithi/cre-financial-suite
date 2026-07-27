// @ts-nocheck
/**
 * Bounded per-domain enrich stage mode flag.
 *
 * Direct structural copy of document-package/feature-mode.ts /
 * claims/feature-mode.ts -- same injectable EnvLike, default-closed on
 * anything unrecognized, three real values:
 *   - "off":    today's single monolithic "enrich" pipeline_jobs stage runs
 *               unchanged. Zero behavior change, zero risk. Default.
 *   - "shadow": the old single-shot "enrich" stage stays authoritative (its
 *               result is what's persisted and shown) -- the new bounded
 *               10-stage chain ALSO runs afterward, purely to record its own
 *               timing/output for comparison, so it can be validated against
 *               real documents (including ones that 546 today) before it is
 *               ever trusted to be authoritative.
 *   - "active": the new bounded 10-stage chain is authoritative; the old
 *               monolithic "enrich" stage is not dispatched.
 * Invalid or unset resolves to "off" -- never throws, never defaults open.
 *
 * Read only server-side -- never accept a mode value from the request body.
 */

const FLAG_NAME = "ENRICH_BOUNDED_STAGE_MODE";

export type EnrichBoundedStageMode = "off" | "shadow" | "active";

const VALID_MODES: ReadonlySet<EnrichBoundedStageMode> = new Set(["off", "shadow", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getEnrichBoundedStageMode(env: EnvLike = Deno.env): EnrichBoundedStageMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  return VALID_MODES.has(raw) ? (raw as EnrichBoundedStageMode) : "off";
}

export function isEnrichBoundedStageAtLeastShadow(env: EnvLike = Deno.env): boolean {
  const mode = getEnrichBoundedStageMode(env);
  return mode === "shadow" || mode === "active";
}

export function isEnrichBoundedStageActive(env: EnvLike = Deno.env): boolean {
  return getEnrichBoundedStageMode(env) === "active";
}

export const ENRICH_BOUNDED_STAGE_MODE_FLAG_NAME = FLAG_NAME;

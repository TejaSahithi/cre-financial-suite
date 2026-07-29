// @ts-nocheck
/**
 * Bounded per-domain enrich stage mode flag.
 *
 * Three real values:
 *   - "off":    explicit rollback to the single monolithic "enrich" stage.
 *   - "shadow": the old single-shot "enrich" stage stays authoritative (its
 *               result is what's persisted and shown) -- the new bounded
 *               10-stage chain ALSO runs afterward, purely to record its own
 *               timing/output for comparison, so it can be validated against
 *               real documents (including ones that 546 today) before it is
 *               ever trusted to be authoritative.
 *   - "active": the new bounded 10-stage chain is authoritative; the old
 *               monolithic "enrich" stage is not dispatched. Default.
 * Invalid or unset resolves to "active" so a missing or misspelled secret
 * cannot silently restore the resource-exhausting monolithic function.
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
  return VALID_MODES.has(raw) ? (raw as EnrichBoundedStageMode) : "active";
}

export function isEnrichBoundedStageAtLeastShadow(env: EnvLike = Deno.env): boolean {
  const mode = getEnrichBoundedStageMode(env);
  return mode === "shadow" || mode === "active";
}

export function isEnrichBoundedStageActive(env: EnvLike = Deno.env): boolean {
  return getEnrichBoundedStageMode(env) === "active";
}

export const ENRICH_BOUNDED_STAGE_MODE_FLAG_NAME = FLAG_NAME;

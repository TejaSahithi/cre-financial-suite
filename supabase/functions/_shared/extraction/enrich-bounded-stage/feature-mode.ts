// @ts-nocheck
/**
 * Bounded per-domain enrich stage mode flag.
 *
 * Active is mandatory. The old single-shot "enrich" stage is the function
 * producing repeated downstream compute failures on long leases, so runtime
 * code ignores "off" and "shadow" values instead of allowing env drift to
 * restore monolithic enrichment.
 *
 * Read only server-side -- never accept a mode value from the request body.
 */

const FLAG_NAME = "ENRICH_BOUNDED_STAGE_MODE";

export type EnrichBoundedStageMode = "active";

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getEnrichBoundedStageMode(env: EnvLike = Deno.env): EnrichBoundedStageMode {
  void env.get(FLAG_NAME);
  return "active";
}

export function isEnrichBoundedStageAtLeastShadow(env: EnvLike = Deno.env): boolean {
  void getEnrichBoundedStageMode(env);
  return true;
}

export function isEnrichBoundedStageActive(env: EnvLike = Deno.env): boolean {
  void getEnrichBoundedStageMode(env);
  return true;
}

export const ENRICH_BOUNDED_STAGE_MODE_FLAG_NAME = FLAG_NAME;

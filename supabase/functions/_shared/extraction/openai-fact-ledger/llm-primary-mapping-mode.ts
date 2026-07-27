// @ts-nocheck
/**
 * LLM-primary schema-aware mapping mode flag.
 *
 * Structural copy of enrich-bounded-stage/feature-mode.ts's convention
 * (injectable EnvLike, two real values, invalid/unset never throws) with one
 * deliberate deviation: this flag defaults to "active", not "off".
 *
 * Every other mode flag in this codebase defaults closed because it was
 * validated only against synthetic fixtures before being offered as an
 * opt-in. This one is different by explicit, repeated user instruction this
 * session: stop optimizing around LLM call count, and get schema-aware
 * mapping live against real documents now rather than staged behind a flag
 * nobody flips. "off" still exists as a real, instant, no-redeploy rollback
 * to the pre-existing keyword-primary + bolted-on-validator path if a real
 * document shows this was the wrong call.
 *
 *   - "active": adaptive-extractor.ts's domain calls propose field
 *               assignments directly (schema-aware primary mapping);
 *               llm-field-validator.ts runs as a narrow self-consistency
 *               check on THIS run's own output only. Default.
 *   - "off":    today's path — domain calls extract loose categorized facts,
 *               fact-field-mapper.ts's keyword scorer assigns fields,
 *               llm-field-validator.ts reviews unmapped facts broadly.
 *
 * Read only server-side -- never accept a mode value from the request body.
 */

const FLAG_NAME = "LLM_PRIMARY_MAPPING_MODE";

export type LlmPrimaryMappingMode = "off" | "active";

const VALID_MODES: ReadonlySet<LlmPrimaryMappingMode> = new Set(["off", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLlmPrimaryMappingMode(env: EnvLike = Deno.env): LlmPrimaryMappingMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw as LlmPrimaryMappingMode;
  // Unset (not merely invalid) resolves to the "active" default described
  // above. An explicitly-set-but-unrecognized value (a typo, e.g.) is
  // treated the same as unset rather than silently coerced to "off" -- there
  // is no "unsafe open" direction to guard against here the way there is for
  // enrich-bounded-stage (this flag only changes which mapping mechanism
  // runs, never bypasses an approval/readiness gate).
  return "active";
}

export function isLlmPrimaryMappingActive(env: EnvLike = Deno.env): boolean {
  return getLlmPrimaryMappingMode(env) === "active";
}

export const LLM_PRIMARY_MAPPING_MODE_FLAG_NAME = FLAG_NAME;

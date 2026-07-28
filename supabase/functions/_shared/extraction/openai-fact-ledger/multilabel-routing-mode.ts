// @ts-nocheck
/**
 * Multi-label routing shadow flag (Phase 3).
 *
 * Same convention as canonical-claims-mode.ts / llm-strict-outputs-mode.ts:
 * injectable EnvLike, two real values, invalid/unset never throws, default
 * OFF (unproven diagnostics-only infrastructure).
 *
 *   - "active": adaptive-extractor.ts additionally computes
 *               routeSectionsMultiLabel() alongside the existing
 *               routeSections() call and attaches
 *               RoutingShadowDiagnostic[] to
 *               extractionDebug.openai_fact_ledger.routing_shadow.
 *   - "off":    no multi-label computation runs at all. Default.
 *
 * The authoritative domain-escalation loop in adaptive-extractor.ts always
 * uses plain routeSections()/byLlmCallDomain, regardless of this flag --
 * multi-label routing never becomes authoritative in this phase.
 */

import { isOrgAdmittedToCanary } from "./canary-gate.ts";

const FLAG_NAME = "LEASE_MULTILABEL_ROUTING_V1";
const ALLOWLIST_ENV_NAME = "LEASE_MULTILABEL_ROUTING_ORG_ALLOWLIST";
const SAMPLE_RATE_ENV_NAME = "LEASE_MULTILABEL_ROUTING_SAMPLE_RATE";

export type LeaseMultilabelRoutingMode = "off" | "active";

const VALID_MODES: ReadonlySet<LeaseMultilabelRoutingMode> = new Set(["off", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseMultilabelRoutingMode(env: EnvLike = Deno.env): LeaseMultilabelRoutingMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw as LeaseMultilabelRoutingMode;
  return "off";
}

export function isLeaseMultilabelRoutingActive(env: EnvLike = Deno.env): boolean {
  return getLeaseMultilabelRoutingMode(env) === "active";
}

/** Full canary gate: top-level flag AND (org allowlist OR sample rate). */
export function shouldComputeMultilabelRouting(
  args: { orgId: string; generationId: string },
  env: EnvLike = Deno.env,
): boolean {
  if (!isLeaseMultilabelRoutingActive(env)) return false;
  return isOrgAdmittedToCanary(
    { orgId: args.orgId, generationId: args.generationId, allowlistEnvVar: ALLOWLIST_ENV_NAME, sampleRateEnvVar: SAMPLE_RATE_ENV_NAME },
    env,
  );
}

export const LEASE_MULTILABEL_ROUTING_FLAG_NAME = FLAG_NAME;
export const LEASE_MULTILABEL_ROUTING_ORG_ALLOWLIST_FLAG_NAME = ALLOWLIST_ENV_NAME;
export const LEASE_MULTILABEL_ROUTING_SAMPLE_RATE_FLAG_NAME = SAMPLE_RATE_ENV_NAME;

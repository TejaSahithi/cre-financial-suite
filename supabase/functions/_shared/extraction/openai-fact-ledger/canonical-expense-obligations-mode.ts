// @ts-nocheck
/**
 * Canonical expense-obligation shadow flag (Phase 6A).
 *
 * Structurally identical to expense-specialists-mode.ts -- two-value
 * off/active + canary gate, since this layer has no shadow-vs-authoritative
 * distinction to justify the three-value off/shadow/active template
 * (claims/package/financial's feature-mode.ts). Independent flag from
 * Phase 5's LEASE_EXPENSE_SPECIALISTS_V1: this layer can be off while
 * specialists run (specialist output just sits unconverted), or on while
 * specialists are off (nothing to convert, runStatus:"specialist_output_missing").
 *
 *   - "active": orchestrator.ts additionally converts this run's expense-
 *               specialist shadow output into canonical ExpenseObligation
 *               records and attaches canonical_expense_obligations /
 *               canonical_expense_obligation_metrics to
 *               extractionDebug.openai_fact_ledger.
 *   - "off":    no conversion runs at all. Default.
 *
 * Never becomes authoritative in this phase -- see
 * expense-obligation-metrics.ts's measured authoritativeMutationCount.
 */

import { isOrgAdmittedToCanary } from "./canary-gate.ts";

const FLAG_NAME = "LEASE_CANONICAL_EXPENSE_OBLIGATIONS_V1";
const ALLOWLIST_ENV_NAME = "LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST";
const SAMPLE_RATE_ENV_NAME = "LEASE_CANONICAL_EXPENSE_OBLIGATIONS_SAMPLE_RATE";

export type LeaseCanonicalExpenseObligationsMode = "off" | "active";

const VALID_MODES: ReadonlySet<LeaseCanonicalExpenseObligationsMode> = new Set(["off", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseCanonicalExpenseObligationsMode(env: EnvLike = Deno.env): LeaseCanonicalExpenseObligationsMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw as LeaseCanonicalExpenseObligationsMode;
  return "off";
}

export function isLeaseCanonicalExpenseObligationsActive(env: EnvLike = Deno.env): boolean {
  return getLeaseCanonicalExpenseObligationsMode(env) === "active";
}

/** Full canary gate: top-level flag AND (org allowlist OR sample rate). */
export function shouldBuildCanonicalExpenseObligations(
  args: { orgId: string; generationId: string },
  env: EnvLike = Deno.env,
): boolean {
  if (!isLeaseCanonicalExpenseObligationsActive(env)) return false;
  return isOrgAdmittedToCanary(
    { orgId: args.orgId, generationId: args.generationId, allowlistEnvVar: ALLOWLIST_ENV_NAME, sampleRateEnvVar: SAMPLE_RATE_ENV_NAME },
    env,
  );
}

export const LEASE_CANONICAL_EXPENSE_OBLIGATIONS_FLAG_NAME = FLAG_NAME;
export const LEASE_CANONICAL_EXPENSE_OBLIGATIONS_ORG_ALLOWLIST_FLAG_NAME = ALLOWLIST_ENV_NAME;
export const LEASE_CANONICAL_EXPENSE_OBLIGATIONS_SAMPLE_RATE_FLAG_NAME = SAMPLE_RATE_ENV_NAME;

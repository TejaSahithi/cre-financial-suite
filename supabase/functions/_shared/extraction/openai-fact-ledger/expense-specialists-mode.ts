// @ts-nocheck
/**
 * Expense-specialist shadow flag (Phase 5).
 *
 * Same convention as canonical-claims-mode.ts / multilabel-routing-mode.ts:
 * injectable EnvLike, two real values, invalid/unset never throws, default
 * OFF (unproven diagnostics-only infrastructure). The two-value off/active
 * template (not the three-value off/shadow/active template used by
 * claims/package/financial's feature-mode.ts) is the right fit here --
 * Phase 5 specialists have no "active becomes authoritative" mode at all
 * this phase, matching multilabel-routing-mode.ts's own reasoning exactly.
 *
 *   - "active": adaptive-extractor.ts additionally runs the 5 Phase 5
 *               expense-specialist shadow calls after the main
 *               domain-escalation loop finishes, and attaches
 *               ExpenseSpecialistShadowRecord[] to
 *               extractionDebug.openai_fact_ledger.expense_specialist_shadow.
 *   - "off":    no specialist calls run at all. Default.
 *
 * The authoritative domain-escalation loop never reads specialist output --
 * specialists never become authoritative in this phase (see the Phase 5
 * plan's "explicitly deferred" section).
 */

import { isOrgAdmittedToCanary } from "./canary-gate.ts";

const FLAG_NAME = "LEASE_EXPENSE_SPECIALISTS_V1";
const ALLOWLIST_ENV_NAME = "LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST";
const SAMPLE_RATE_ENV_NAME = "LEASE_EXPENSE_SPECIALISTS_SAMPLE_RATE";

export type LeaseExpenseSpecialistsMode = "off" | "active";

const VALID_MODES: ReadonlySet<LeaseExpenseSpecialistsMode> = new Set(["off", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export function getLeaseExpenseSpecialistsMode(env: EnvLike = Deno.env): LeaseExpenseSpecialistsMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  if (VALID_MODES.has(raw)) return raw as LeaseExpenseSpecialistsMode;
  return "off";
}

export function isLeaseExpenseSpecialistsActive(env: EnvLike = Deno.env): boolean {
  return getLeaseExpenseSpecialistsMode(env) === "active";
}

/** Full canary gate: top-level flag AND (org allowlist OR sample rate). */
export function shouldRunLeaseExpenseSpecialists(
  args: { orgId: string; generationId: string },
  env: EnvLike = Deno.env,
): boolean {
  if (!isLeaseExpenseSpecialistsActive(env)) return false;
  return isOrgAdmittedToCanary(
    { orgId: args.orgId, generationId: args.generationId, allowlistEnvVar: ALLOWLIST_ENV_NAME, sampleRateEnvVar: SAMPLE_RATE_ENV_NAME },
    env,
  );
}

export const LEASE_EXPENSE_SPECIALISTS_FLAG_NAME = FLAG_NAME;
export const LEASE_EXPENSE_SPECIALISTS_ORG_ALLOWLIST_FLAG_NAME = ALLOWLIST_ENV_NAME;
export const LEASE_EXPENSE_SPECIALISTS_SAMPLE_RATE_FLAG_NAME = SAMPLE_RATE_ENV_NAME;

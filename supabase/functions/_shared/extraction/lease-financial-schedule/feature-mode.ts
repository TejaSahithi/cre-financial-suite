// @ts-nocheck
/**
 * P4.1 financial schedule mode flag.
 *
 * Server-owned only. Request bodies and browser input must never choose this
 * mode. Invalid or unset values resolve to off so P4 remains default closed.
 */

import { getLeaseClaimsLedgerMode } from "../claims/feature-mode.ts";
import { getLeaseDocumentPackageMode } from "../document-package/feature-mode.ts";

const FLAG_NAME = "LEASE_FINANCIAL_SCHEDULE_MODE";

export type LeaseFinancialScheduleMode = "off" | "shadow" | "active";

const VALID_MODES: ReadonlySet<LeaseFinancialScheduleMode> = new Set(["off", "shadow", "active"]);

export interface EnvLike {
  get(key: string): string | undefined;
}

export interface FinancialScheduleModeCombination {
  claimsMode: "off" | "shadow" | "active";
  packageMode: "off" | "shadow" | "active";
  financialMode: LeaseFinancialScheduleMode;
}

export const FINANCIAL_SCHEDULE_MODE_ERROR_CODES = {
  FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER: "FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER",
  FINANCIAL_SHADOW_REQUIRES_CLAIMS_LEDGER: "FINANCIAL_SHADOW_REQUIRES_CLAIMS_LEDGER",
  FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE: "FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE",
  FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE: "FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE",
  FINANCIAL_ACTIVE_PACKAGE_REQUIRES_PACKAGE_MODE: "FINANCIAL_ACTIVE_PACKAGE_REQUIRES_PACKAGE_MODE",
  FINANCIAL_MODE_CONFIGURATION_INVALID: "FINANCIAL_MODE_CONFIGURATION_INVALID",
} as const;

export class FinancialScheduleModeError extends Error {
  errorCode: string;

  constructor(errorCode: string) {
    super(errorCode);
    this.name = "FinancialScheduleModeError";
    this.errorCode = errorCode;
  }
}

export function getLeaseFinancialScheduleMode(env: EnvLike = Deno.env): LeaseFinancialScheduleMode {
  const raw = String(env.get(FLAG_NAME) ?? "").trim().toLowerCase();
  return VALID_MODES.has(raw) ? (raw as LeaseFinancialScheduleMode) : "off";
}

export function isFinancialScheduleActive(env: EnvLike = Deno.env): boolean {
  return getLeaseFinancialScheduleMode(env) === "active";
}

export function isFinancialScheduleAtLeastShadow(env: EnvLike = Deno.env): boolean {
  const mode = getLeaseFinancialScheduleMode(env);
  return mode === "shadow" || mode === "active";
}

export function resolveFinancialScheduleModeCombination(env: EnvLike = Deno.env): FinancialScheduleModeCombination {
  return {
    claimsMode: getLeaseClaimsLedgerMode(env),
    packageMode: getLeaseDocumentPackageMode(env),
    financialMode: getLeaseFinancialScheduleMode(env),
  };
}

export function validateFinancialScheduleModeCombination(
  modes: FinancialScheduleModeCombination,
  options: { packageAwareInput?: boolean } = {},
) {
  if (!VALID_MODES.has(modes.financialMode) || !["off", "shadow", "active"].includes(modes.claimsMode) || !["off", "shadow", "active"].includes(modes.packageMode)) {
    throw new FinancialScheduleModeError(FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_MODE_CONFIGURATION_INVALID);
  }
  if (modes.financialMode === "shadow" && modes.claimsMode === "off") {
    throw new FinancialScheduleModeError(FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_MODE_REQUIRES_CLAIMS_LEDGER);
  }
  if (modes.financialMode === "active" && modes.claimsMode !== "active") {
    throw new FinancialScheduleModeError(FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE);
  }
  if (modes.financialMode === "active" && options.packageAwareInput === true && modes.packageMode !== "active") {
    throw new FinancialScheduleModeError(FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_PACKAGE_ACTIVE);
  }
}

export const LEASE_FINANCIAL_SCHEDULE_MODE_FLAG_NAME = FLAG_NAME;

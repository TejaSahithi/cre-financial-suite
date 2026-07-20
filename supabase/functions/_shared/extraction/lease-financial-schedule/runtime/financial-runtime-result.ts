// @ts-nocheck
import type { LeaseFinancialScheduleMode } from "../feature-mode.ts";
import type { FinancialRuntimeResult } from "./financial-runtime-types.ts";

export function disabledFinancialRuntimeResult(): FinancialRuntimeResult {
  return {
    enabled: false,
    mode: "off",
    compatibilityPersisted: false,
    status: "disabled",
  };
}

export function failedFinancialRuntimeResult(mode: LeaseFinancialScheduleMode, errorCode: string): FinancialRuntimeResult {
  return {
    enabled: mode !== "off",
    mode,
    compatibilityPersisted: false,
    status: "failed",
    errorCode,
  };
}
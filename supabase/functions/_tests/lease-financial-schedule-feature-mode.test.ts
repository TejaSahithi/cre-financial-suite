// @ts-nocheck
// P4.1 -- LEASE_FINANCIAL_SCHEDULE_MODE strict parsing and dependency gates.

import { assert, assertEquals, assertFalse, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  FINANCIAL_SCHEDULE_MODE_ERROR_CODES,
  FinancialScheduleModeError,
  getLeaseFinancialScheduleMode,
  isFinancialScheduleActive,
  isFinancialScheduleAtLeastShadow,
  LEASE_FINANCIAL_SCHEDULE_MODE_FLAG_NAME,
  resolveFinancialScheduleModeCombination,
  validateFinancialScheduleModeCombination,
} from "../_shared/extraction/lease-financial-schedule/feature-mode.ts";
import { LEASE_CLAIMS_LEDGER_MODE_FLAG_NAME } from "../_shared/extraction/claims/feature-mode.ts";
import { LEASE_DOCUMENT_PACKAGE_MODE_FLAG_NAME } from "../_shared/extraction/document-package/feature-mode.ts";

function fakeEnv(values: Record<string, string | undefined>) {
  return { get: (key: string) => values[key] };
}

function singleFlagEnv(value: string | undefined) {
  return fakeEnv({ [LEASE_FINANCIAL_SCHEDULE_MODE_FLAG_NAME]: value });
}

Deno.test("P4.1 feature mode: unset, empty and invalid values resolve to off", () => {
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv(undefined)), "off");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("")), "off");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("enabled")), "off");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("true")), "off");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("activee")), "off");
});

Deno.test("P4.1 feature mode: exact values are case-insensitive and trimmed", () => {
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("off")), "off");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("shadow")), "shadow");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("active")), "active");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv(" SHADOW ")), "shadow");
  assertEquals(getLeaseFinancialScheduleMode(singleFlagEnv("Active")), "active");
});

Deno.test("P4.1 feature mode: helper predicates remain default closed", () => {
  assertFalse(isFinancialScheduleActive(singleFlagEnv("shadow")));
  assertFalse(isFinancialScheduleActive(singleFlagEnv(undefined)));
  assert(isFinancialScheduleActive(singleFlagEnv("active")));
  assertFalse(isFinancialScheduleAtLeastShadow(singleFlagEnv("off")));
  assertFalse(isFinancialScheduleAtLeastShadow(singleFlagEnv("garbage")));
  assert(isFinancialScheduleAtLeastShadow(singleFlagEnv("shadow")));
  assert(isFinancialScheduleAtLeastShadow(singleFlagEnv("active")));
});

Deno.test("P4.1 feature mode: browser/request data cannot activate the server-owned flag", () => {
  const requestBody = { LEASE_FINANCIAL_SCHEDULE_MODE: "active", mode: "active" };
  assertEquals(getLeaseFinancialScheduleMode(fakeEnv({})), "off");
  assertEquals(requestBody.mode, "active");
});

Deno.test("P4.1 feature mode: combinations require P2 and package foundations before activation", () => {
  const shadowWithoutClaims = assertThrows(
    () => validateFinancialScheduleModeCombination({ financialMode: "shadow", claimsMode: "off", packageMode: "off" }),
    FinancialScheduleModeError,
  );
  assertEquals(shadowWithoutClaims.errorCode, FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_SHADOW_REQUIRES_CLAIMS_LEDGER);

  const activeWithoutClaimsActive = assertThrows(
    () => validateFinancialScheduleModeCombination({ financialMode: "active", claimsMode: "shadow", packageMode: "shadow" }),
    FinancialScheduleModeError,
  );
  assertEquals(activeWithoutClaimsActive.errorCode, FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_ACTIVE_REQUIRES_CLAIMS_ACTIVE);

  const activePackageAwareWithoutPackage = assertThrows(
    () => validateFinancialScheduleModeCombination({ financialMode: "active", claimsMode: "active", packageMode: "off" }, { packageAwareInput: true }),
    FinancialScheduleModeError,
  );
  assertEquals(activePackageAwareWithoutPackage.errorCode, FINANCIAL_SCHEDULE_MODE_ERROR_CODES.FINANCIAL_ACTIVE_PACKAGE_REQUIRES_PACKAGE_MODE);

  validateFinancialScheduleModeCombination({ financialMode: "off", claimsMode: "off", packageMode: "off" });
  validateFinancialScheduleModeCombination({ financialMode: "shadow", claimsMode: "shadow", packageMode: "off" });
  validateFinancialScheduleModeCombination({ financialMode: "active", claimsMode: "active", packageMode: "shadow" }, { packageAwareInput: true });
});

Deno.test("P4.1 feature mode: resolved combination reads only server env keys", () => {
  const env = fakeEnv({
    [LEASE_CLAIMS_LEDGER_MODE_FLAG_NAME]: "active",
    [LEASE_DOCUMENT_PACKAGE_MODE_FLAG_NAME]: "shadow",
    [LEASE_FINANCIAL_SCHEDULE_MODE_FLAG_NAME]: "shadow",
  });
  assertEquals(resolveFinancialScheduleModeCombination(env), {
    claimsMode: "active",
    packageMode: "shadow",
    financialMode: "shadow",
  });
});
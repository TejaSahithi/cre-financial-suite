// @ts-nocheck
// P2.2 -- LEASE_CLAIMS_LEDGER_MODE strict parsing tests. Mirrors
// extraction-provenance-feature-flag.test.ts's shape exactly (same
// injectable-EnvLike template), three-value parse instead of boolean.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getLeaseClaimsLedgerMode,
  isClaimsLedgerActive,
  isClaimsLedgerAtLeastShadow,
  LEASE_CLAIMS_LEDGER_MODE_FLAG_NAME,
} from "../_shared/extraction/claims/feature-mode.ts";

function fakeEnv(value: string | undefined) {
  return { get: (key: string) => (key === LEASE_CLAIMS_LEDGER_MODE_FLAG_NAME ? value : undefined) };
}

Deno.test("unset env resolves to off", () => {
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv(undefined)), "off");
});

Deno.test("empty string, garbage, and near-miss values all resolve to off", () => {
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("nope")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("enabled")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("true")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("1")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("shado")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("activee")), "off");
});

Deno.test("exact valid values resolve correctly, case-insensitively and trimmed", () => {
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("off")), "off");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("shadow")), "shadow");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("active")), "active");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("SHADOW")), "shadow");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("Active")), "active");
  assertEquals(getLeaseClaimsLedgerMode(fakeEnv("  shadow  ")), "shadow");
});

Deno.test("isClaimsLedgerActive is true only for active", () => {
  assertFalse(isClaimsLedgerActive(fakeEnv("off")));
  assertFalse(isClaimsLedgerActive(fakeEnv("shadow")));
  assertFalse(isClaimsLedgerActive(fakeEnv(undefined)));
  assertFalse(isClaimsLedgerActive(fakeEnv("garbage")));
  assert(isClaimsLedgerActive(fakeEnv("active")));
});

Deno.test("isClaimsLedgerAtLeastShadow is true for shadow and active, false for off/unset/invalid", () => {
  assertFalse(isClaimsLedgerAtLeastShadow(fakeEnv("off")));
  assertFalse(isClaimsLedgerAtLeastShadow(fakeEnv(undefined)));
  assertFalse(isClaimsLedgerAtLeastShadow(fakeEnv("garbage")));
  assert(isClaimsLedgerAtLeastShadow(fakeEnv("shadow")));
  assert(isClaimsLedgerAtLeastShadow(fakeEnv("active")));
});

Deno.test("real Deno.env, unset by default in this test run, resolves to off", () => {
  Deno.env.delete(LEASE_CLAIMS_LEDGER_MODE_FLAG_NAME);
  assertEquals(getLeaseClaimsLedgerMode(), "off");
  assertFalse(isClaimsLedgerActive());
  assertFalse(isClaimsLedgerAtLeastShadow());
});

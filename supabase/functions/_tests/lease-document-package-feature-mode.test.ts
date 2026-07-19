// @ts-nocheck
// P3.1 -- LEASE_DOCUMENT_PACKAGE_MODE strict parsing tests. Mirrors
// lease-claims-feature-mode.test.ts's shape exactly.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getLeaseDocumentPackageMode,
  isDocumentPackageActive,
  isDocumentPackageAtLeastShadow,
  LEASE_DOCUMENT_PACKAGE_MODE_FLAG_NAME,
} from "../_shared/extraction/document-package/feature-mode.ts";

function fakeEnv(value: string | undefined) {
  return { get: (key: string) => (key === LEASE_DOCUMENT_PACKAGE_MODE_FLAG_NAME ? value : undefined) };
}

Deno.test("unset env resolves to off", () => {
  assertEquals(getLeaseDocumentPackageMode(fakeEnv(undefined)), "off");
});

Deno.test("empty string, garbage, and near-miss values all resolve to off", () => {
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("")), "off");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("nope")), "off");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("enabled")), "off");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("true")), "off");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("shado")), "off");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("activee")), "off");
});

Deno.test("exact valid values resolve correctly, case-insensitively and trimmed", () => {
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("off")), "off");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("shadow")), "shadow");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("active")), "active");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("SHADOW")), "shadow");
  assertEquals(getLeaseDocumentPackageMode(fakeEnv("  active  ")), "active");
});

Deno.test("isDocumentPackageActive is true only for active; recognized but not enabled during P3.1", () => {
  assertFalse(isDocumentPackageActive(fakeEnv("off")));
  assertFalse(isDocumentPackageActive(fakeEnv("shadow")));
  assertFalse(isDocumentPackageActive(fakeEnv(undefined)));
  assert(isDocumentPackageActive(fakeEnv("active")));
});

Deno.test("isDocumentPackageAtLeastShadow is true for shadow and active, false for off/unset/invalid", () => {
  assertFalse(isDocumentPackageAtLeastShadow(fakeEnv("off")));
  assertFalse(isDocumentPackageAtLeastShadow(fakeEnv(undefined)));
  assertFalse(isDocumentPackageAtLeastShadow(fakeEnv("garbage")));
  assert(isDocumentPackageAtLeastShadow(fakeEnv("shadow")));
  assert(isDocumentPackageAtLeastShadow(fakeEnv("active")));
});

Deno.test("real Deno.env, unset by default in this test run, resolves to off", () => {
  Deno.env.delete(LEASE_DOCUMENT_PACKAGE_MODE_FLAG_NAME);
  assertEquals(getLeaseDocumentPackageMode(), "off");
  assertFalse(isDocumentPackageActive());
});

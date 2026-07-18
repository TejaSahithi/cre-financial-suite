// @ts-nocheck
import { assert, assertFalse } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { isExtractionProvenanceEnabled } from "../_shared/extraction/provenance/feature-flag.ts";

// Mirrors document-intelligence-v3.test.ts's feature-flag test shape exactly
// (P1's design doc: "one canonical, already-tested place to gate v3
// behavior" — same template reused here for ENABLE_EXTRACTION_PROVENANCE).

function fakeEnv(value: string | undefined) {
  return { get: (key: string) => (key === "ENABLE_EXTRACTION_PROVENANCE" ? value : undefined) };
}

Deno.test("isExtractionProvenanceEnabled: unset env means disabled (current behavior unchanged)", () => {
  assertFalse(isExtractionProvenanceEnabled(fakeEnv(undefined)));
});

Deno.test("isExtractionProvenanceEnabled: empty string, garbage, and 'false' all mean disabled", () => {
  assertFalse(isExtractionProvenanceEnabled(fakeEnv("")));
  assertFalse(isExtractionProvenanceEnabled(fakeEnv("nope")));
  assertFalse(isExtractionProvenanceEnabled(fakeEnv("false")));
  assertFalse(isExtractionProvenanceEnabled(fakeEnv("0")));
});

Deno.test("isExtractionProvenanceEnabled: explicit truthy values enable it, case-insensitively", () => {
  assert(isExtractionProvenanceEnabled(fakeEnv("true")));
  assert(isExtractionProvenanceEnabled(fakeEnv("TRUE")));
  assert(isExtractionProvenanceEnabled(fakeEnv("1")));
  assert(isExtractionProvenanceEnabled(fakeEnv("on")));
  assert(isExtractionProvenanceEnabled(fakeEnv("yes")));
});

Deno.test("isExtractionProvenanceEnabled: real Deno.env, unset by default in this test run, is disabled", () => {
  Deno.env.delete("ENABLE_EXTRACTION_PROVENANCE");
  assertFalse(isExtractionProvenanceEnabled());
});

// @ts-nocheck
// Regression test for the live-routing fail-safe default: an unset
// BUSINESS_EXTRACTION_PROVIDER must resolve to an OpenAI-enabled mode, not
// silently fall back to a rule-only path. This is deliberately a SEPARATE
// concern from normalizeBusinessExtractionMode()'s own "!raw -> legacy_hybrid"
// default (business-extraction-provenance.test.ts), which stays correct and
// untouched for interpreting already-persisted historical rows.
//
// Run: deno test --allow-env --no-lock business-extraction-provider-default-failsafe.test.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: normalizeTest } = await import("../normalize-pdf-output/index.ts");
(Deno as any).serve = realServe;

function withEnvVar(name: string, value: string | undefined, fn: () => void) {
  const previous = Deno.env.get(name);
  try {
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete(name);
    else Deno.env.set(name, previous);
  }
}

Deno.test("resolveBusinessExtractionProvider: unset BUSINESS_EXTRACTION_PROVIDER resolves to an OpenAI-enabled mode, not legacy_hybrid", () => {
  withEnvVar("BUSINESS_EXTRACTION_PROVIDER", undefined, () => {
    assertEquals(normalizeTest.resolveBusinessExtractionProvider(null), "openai_primary_legacy_fallback");
  });
});

Deno.test("resolveBusinessExtractionProvider: empty-string BUSINESS_EXTRACTION_PROVIDER also resolves to an OpenAI-enabled mode", () => {
  withEnvVar("BUSINESS_EXTRACTION_PROVIDER", "", () => {
    assertEquals(normalizeTest.resolveBusinessExtractionProvider(null), "openai_primary_legacy_fallback");
  });
});

Deno.test("resolveBusinessExtractionProvider: an explicitly configured provider is still respected, not overridden by the fail-safe default", () => {
  withEnvVar("BUSINESS_EXTRACTION_PROVIDER", "legacy_hybrid", () => {
    assertEquals(normalizeTest.resolveBusinessExtractionProvider(null), "legacy_hybrid");
  });
  withEnvVar("BUSINESS_EXTRACTION_PROVIDER", "openai_fact_ledger", () => {
    assertEquals(normalizeTest.resolveBusinessExtractionProvider(null), "openai_fact_ledger");
  });
});

Deno.test("resolveBusinessExtractionProvider: an internal debug override still takes precedence over both the env var and the fail-safe default", () => {
  withEnvVar("BUSINESS_EXTRACTION_PROVIDER", undefined, () => {
    assertEquals(normalizeTest.resolveBusinessExtractionProvider("legacy_hybrid"), "legacy_hybrid");
  });
});

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

Deno.test("enforceLeaseExtractionArchitecture: active lease mode overrides every configured provider to the compatibility LLM-primary provider", () => {
  withEnvVar("LEASE_WHOLE_DOCUMENT_LLM_V1", undefined, () => {
    assertEquals(normalizeTest.enforceLeaseExtractionArchitecture("lease", "legacy_hybrid"), "openai_primary_legacy_fallback");
    assertEquals(normalizeTest.enforceLeaseExtractionArchitecture("leases", "legacy_hybrid"), "openai_primary_legacy_fallback");
    assertEquals(normalizeTest.enforceLeaseExtractionArchitecture("lease", "openai_fact_ledger"), "openai_primary_legacy_fallback");
  });
});

Deno.test("enforceLeaseExtractionArchitecture: only explicit off permits the legacy rollback", () => {
  withEnvVar("LEASE_WHOLE_DOCUMENT_LLM_V1", "off", () => {
    assertEquals(normalizeTest.enforceLeaseExtractionArchitecture("lease", "legacy_hybrid"), "legacy_hybrid");
  });
});

Deno.test("assertAuthoritativeLeaseExtractionResult: rejects a legacy-shaped result while direct-schema mode is active", () => {
  withEnvVar("LEASE_WHOLE_DOCUMENT_LLM_V1", "active", () => {
    let message = "";
    try {
      normalizeTest.assertAuthoritativeLeaseExtractionResult("leases", {
        metadata: { extractionDebug: { openai_fact_ledger: { facts_extracted_count: 56, facts_mapped_count: 24 } } },
      });
    } catch (error) {
      message = String(error?.message ?? error);
    }
    assertEquals(message.includes("LEASE_EXTRACTION_ARCHITECTURE_VIOLATION"), true);
  });
});

Deno.test("assertAuthoritativeLeaseExtractionResult: accepts whole_document_llm_v2", () => {
  withEnvVar("LEASE_WHOLE_DOCUMENT_LLM_V1", "active", () => {
    normalizeTest.assertAuthoritativeLeaseExtractionResult("lease", {
      metadata: { extractionDebug: { openai_fact_ledger: { extraction_mode: "whole_document_llm_v2" } } },
    });
  });
});

Deno.test("assertAuthoritativeLeaseExtractionResult: rejects explicit legacy fallback by default while direct-schema mode is active", () => {
  withEnvVar("LEASE_WHOLE_DOCUMENT_LLM_V1", "active", () => {
    withEnvVar("LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK", undefined, () => {
      let message = "";
      try {
        normalizeTest.assertAuthoritativeLeaseExtractionResult("leases", {
          metadata: {
            provenance: {
              fallback_used: true,
              effective_provider: "legacy_hybrid",
            },
          },
        });
      } catch (error) {
        message = String(error?.message ?? error);
      }
      assertEquals(message.includes("LEASE_EXTRACTION_ARCHITECTURE_VIOLATION"), true);
    });
  });
});

Deno.test("assertAuthoritativeLeaseExtractionResult: accepts explicit legacy fallback only when rollback env is enabled", () => {
  withEnvVar("LEASE_WHOLE_DOCUMENT_LLM_V1", "active", () => {
    withEnvVar("LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK", "true", () => {
      normalizeTest.assertAuthoritativeLeaseExtractionResult("leases", {
        metadata: {
          provenance: {
            fallback_used: true,
            effective_provider: "legacy_hybrid",
          },
        },
      });
    });
  });
});

Deno.test("classifyNoMeaningfulExtraction: whole-document invalid/omitted claims are reported as WHOLE_DOCUMENT_LLM_FAILED, not AI_EMPTY_EXTRACTION", () => {
  const result = normalizeTest.classifyNoMeaningfulExtraction({
    extraction_mode: "whole_document_llm_v2",
    invalid_or_omitted_claim_count: 52,
    facts_extracted_count: 1,
    facts_mapped_count: 1,
  }, 1, 1);
  assertEquals(result.errorCode, "WHOLE_DOCUMENT_LLM_FAILED");
  assertEquals(result.wholeDocumentFailureClassification, "invalid_or_omitted_claims:52");
});
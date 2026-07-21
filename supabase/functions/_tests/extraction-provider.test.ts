// @ts-nocheck
// Regression tests proving parser provider selection fails closed: Azure
// Document Intelligence is the only supported provider, and an explicitly
// supplied but unsupported value (a deprecated vendor name, a retired mode,
// or garbage) throws instead of being silently remapped to Azure.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  resolveExtractionProvider,
  isAzureLayoutOutput,
  UnsupportedExtractionProviderError,
} from "../_shared/extraction/extraction-provider.ts";

function withEnv(key: string, value: string | undefined, fn: () => void) {
  const previous = Deno.env.get(key);
  try {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
    fn();
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
}

Deno.test("resolveExtractionProvider: no override and no env var defaults to azure_document_intelligence", () => {
  withEnv("EXTRACTION_PROVIDER", undefined, () => {
    const result = resolveExtractionProvider(undefined);
    assertEquals(result, { mode: "azure_document_intelligence", source: "default" });
  });
});

Deno.test("resolveExtractionProvider: explicit azure_document_intelligence override succeeds", () => {
  const result = resolveExtractionProvider("azure_document_intelligence");
  assertEquals(result, { mode: "azure_document_intelligence", source: "override" });
});

Deno.test("resolveExtractionProvider: whitespace/case-insensitive azure_document_intelligence override succeeds", () => {
  const result = resolveExtractionProvider("  Azure_Document_Intelligence  ");
  assertEquals(result.mode, "azure_document_intelligence");
});

const DEPRECATED_OR_UNSUPPORTED_OVERRIDES = [
  "vertex_ai",
  "docling",
  "vision_only",
  "vision_first",
  "gemini_vision",
  "legacy",
  "azure_with_legacy_fallback",
  "shadow_compare",
  "not_a_real_provider",
];

for (const value of DEPRECATED_OR_UNSUPPORTED_OVERRIDES) {
  Deno.test(`resolveExtractionProvider: explicit override "${value}" throws UnsupportedExtractionProviderError, never falls back to Azure`, () => {
    assertThrows(
      () => resolveExtractionProvider(value),
      UnsupportedExtractionProviderError,
    );
  });
}

Deno.test("resolveExtractionProvider: EXTRACTION_PROVIDER=azure_document_intelligence env var succeeds", () => {
  withEnv("EXTRACTION_PROVIDER", "azure_document_intelligence", () => {
    const result = resolveExtractionProvider(undefined);
    assertEquals(result, { mode: "azure_document_intelligence", source: "env" });
  });
});

for (const value of ["vertex_ai", "docling", "gemini_vision"]) {
  Deno.test(`resolveExtractionProvider: EXTRACTION_PROVIDER=${value} env var throws, never falls back to Azure`, () => {
    withEnv("EXTRACTION_PROVIDER", value, () => {
      assertThrows(
        () => resolveExtractionProvider(undefined),
        UnsupportedExtractionProviderError,
      );
    });
  });
}

Deno.test("resolveExtractionProvider: override takes precedence over env var", () => {
  withEnv("EXTRACTION_PROVIDER", "azure_document_intelligence", () => {
    assertThrows(
      () => resolveExtractionProvider("vertex_ai"),
      UnsupportedExtractionProviderError,
    );
  });
});

Deno.test("UnsupportedExtractionProviderError: message names the rejected value and source", () => {
  try {
    resolveExtractionProvider("vertex_ai");
    assert(false, "must throw");
  } catch (err) {
    assert(err instanceof UnsupportedExtractionProviderError);
    assert(err.message.includes("vertex_ai"));
    assertEquals(err.source, "override");
  }
});

Deno.test("isAzureLayoutOutput: recognizes azure_layout extraction_method and azure_document_intelligence provider metadata", () => {
  assertEquals(isAzureLayoutOutput(null), false);
  assertEquals(isAzureLayoutOutput({ extraction_method: "azure_layout" }), true);
  assertEquals(isAzureLayoutOutput({ _metadata: { provider: "azure_document_intelligence" } }), true);
  assertEquals(isAzureLayoutOutput({ extraction_method: "docling" }), false);
});

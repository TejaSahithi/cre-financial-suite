// @ts-nocheck
// Regression tests for normalizeBusinessExtractionMode's fail-closed
// behavior: a fresh override/env value that isn't a recognized mode (or one
// of its legacy vertex_* aliases, which name an internal algorithm choice,
// not a vendor) must throw. Reading an already-persisted historical row's
// mode value stays lenient (defaults to legacy_hybrid) since that path is
// interpreting old stored data, not selecting a provider for new work.

import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  normalizeBusinessExtractionMode,
  buildProvenance,
  UnsupportedBusinessExtractionModeError,
} from "../_shared/extraction/business-extraction-provenance.ts";

Deno.test("normalizeBusinessExtractionMode: canonical values pass through unchanged for override/env sources", () => {
  for (const mode of ["legacy_hybrid", "openai_fact_ledger", "openai_primary_legacy_fallback"]) {
    assertEquals(normalizeBusinessExtractionMode(mode, { source: "override" }), mode);
    assertEquals(normalizeBusinessExtractionMode(mode, { source: "env" }), mode);
  }
});

Deno.test("normalizeBusinessExtractionMode: legacy vertex_* aliases map to their openai_* equivalents even for override/env sources", () => {
  assertEquals(normalizeBusinessExtractionMode("vertex_fact_ledger", { source: "override" }), "openai_fact_ledger");
  assertEquals(normalizeBusinessExtractionMode("vertex_primary_legacy_fallback", { source: "env" }), "openai_primary_legacy_fallback");
});

Deno.test("normalizeBusinessExtractionMode: no value supplied defaults to legacy_hybrid regardless of source", () => {
  assertEquals(normalizeBusinessExtractionMode(null, { source: "override" }), "legacy_hybrid");
  assertEquals(normalizeBusinessExtractionMode(undefined, { source: "env" }), "legacy_hybrid");
  assertEquals(normalizeBusinessExtractionMode("", { source: "override" }), "legacy_hybrid");
});

Deno.test("normalizeBusinessExtractionMode: unrecognized override value throws UnsupportedBusinessExtractionModeError", () => {
  assertThrows(
    () => normalizeBusinessExtractionMode("vision_only", { source: "override" }),
    UnsupportedBusinessExtractionModeError,
  );
  assertThrows(
    () => normalizeBusinessExtractionMode("gemini_fact_ledger", { source: "override" }),
    UnsupportedBusinessExtractionModeError,
  );
});

Deno.test("normalizeBusinessExtractionMode: unrecognized env value throws UnsupportedBusinessExtractionModeError", () => {
  assertThrows(
    () => normalizeBusinessExtractionMode("docling_fact_ledger", { source: "env" }),
    UnsupportedBusinessExtractionModeError,
  );
});

Deno.test("normalizeBusinessExtractionMode: unrecognized value from a persisted historical row degrades leniently to legacy_hybrid, not a throw", () => {
  const result = normalizeBusinessExtractionMode("some_ancient_mode_no_longer_supported", { source: "persisted_row" });
  assertEquals(result, "legacy_hybrid");
});

Deno.test("normalizeBusinessExtractionMode: default source (unspecified) behaves as persisted_row (lenient)", () => {
  const result = normalizeBusinessExtractionMode("some_ancient_mode_no_longer_supported");
  assertEquals(result, "legacy_hybrid");
});

Deno.test("UnsupportedBusinessExtractionModeError: message names the rejected value and source", () => {
  try {
    normalizeBusinessExtractionMode("vision_only", { source: "override" });
    assert(false, "must throw");
  } catch (err) {
    assert(err instanceof UnsupportedBusinessExtractionModeError);
    assert(err.message.includes("vision_only"));
    assertEquals(err.source, "override");
  }
});

Deno.test("buildProvenance: no longer emits deprecated vertex_attempt_count/vertex_model mirror fields", () => {
  const provenance = buildProvenance({
    attemptId: "attempt-1",
    requestedProvider: "openai_fact_ledger",
    effectiveProvider: "openai_fact_ledger",
    acceptanceState: "accepted",
    fallbackUsed: false,
    openaiAttemptCount: 1,
    openaiModel: "gpt-4o-mini",
    correlationId: "corr-1",
  });
  assertEquals(provenance.openai_attempt_count, 1);
  assertEquals(provenance.openai_model, "gpt-4o-mini");
  assert(!("vertex_attempt_count" in provenance), "deprecated mirror field must not be emitted");
  assert(!("vertex_model" in provenance), "deprecated mirror field must not be emitted");
});

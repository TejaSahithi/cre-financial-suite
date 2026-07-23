// @ts-nocheck
// Azure + OpenAI Phase 4E (local implementation): unit tests for
// fact-ledger-extractor.ts's dominant-classification priority logic
// (Correction round 3, item 1 — chunk-failure aggregation, not
// last-chunk-wins). Pure-function tests only — no DB, no network.
// Run: deno test --allow-env --allow-read --no-lock fact-ledger-chunk-aggregation.test.ts

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../_shared/extraction/openai-fact-ledger/fact-ledger-extractor.ts";

const { dominantClassification } = __test__;

Deno.test("dominantClassification: authentication always wins the priority, even when other eligible errors are also present", () => {
  assertEquals(dominantClassification(["timeout", "authentication", "rate_limit"]), "authentication");
});

Deno.test("dominantClassification: rate_limit outranks provider_server_error/transport/timeout", () => {
  assertEquals(dominantClassification(["timeout", "transport", "rate_limit", "provider_server_error"]), "rate_limit");
});

Deno.test("dominantClassification: provider_server_error outranks transport/budget_exhausted/malformed/empty/timeout", () => {
  assertEquals(dominantClassification(["timeout", "empty_extraction", "provider_server_error", "malformed_response"]), "provider_server_error");
});

Deno.test("dominantClassification: malformed_response outranks empty_extraction and timeout", () => {
  assertEquals(dominantClassification(["timeout", "empty_extraction", "malformed_response"]), "malformed_response");
});

Deno.test("dominantClassification: empty_extraction outranks timeout", () => {
  assertEquals(dominantClassification(["timeout", "empty_extraction"]), "empty_extraction");
});

Deno.test("dominantClassification: a single classification is returned unchanged", () => {
  assertEquals(dominantClassification(["timeout"]), "timeout");
});

Deno.test("dominantClassification: no classifications present returns undefined", () => {
  assertEquals(dominantClassification([undefined, undefined]), undefined);
  assertEquals(dominantClassification([]), undefined);
});

Deno.test("dominantClassification: undefined entries mixed with real ones are ignored, not treated as 'unknown'", () => {
  assertEquals(dominantClassification([undefined, "timeout", undefined]), "timeout");
});

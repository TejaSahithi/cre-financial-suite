// @ts-nocheck
//
// Regression tests for incomplete whole-document LLM responses.
//
// OBSERVED FAILURE THIS PINS
//   A real lease extraction reported:
//     openai_facts_extracted_count:        3
//     openai_invalid_or_omitted_claim_count: 47
//     openai_failure_classification:       (none)
//   i.e. the model was asked for ~50 fields, answered for 3, said nothing at
//   all about the other 47, and the run was still surfaced to the user as
//   "Extraction ready / Review completed". 3 + 47 = 50 = the full schema, so
//   nothing was wrong with reading the document — the ANSWER was incomplete.
//
// Two causes were possible and neither was detected:
//   1. the response was truncated at max_output_tokens (llm.ts has always
//      documented finishReason === "length" as truncated JSON, but no code in
//      the extraction path read it);
//   2. the model simply abandoned most of the schema.
//
// Both now fail the run instead of publishing a near-empty extraction.
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../_shared/extraction/whole-document-llm/extractor.ts";

const { isTruncatedFinishReason, maxOmittedFieldRatio } = __test__;

Deno.test("truncation: finish_reason 'length' is recognised as a cut-off response", () => {
  assertEquals(isTruncatedFinishReason("length"), true);
  assertEquals(isTruncatedFinishReason("LENGTH"), true);
  // Provider spelling variants seen across OpenAI chat/responses APIs.
  assertEquals(isTruncatedFinishReason("max_tokens"), true);
  assertEquals(isTruncatedFinishReason("max_output_tokens"), true);
});

Deno.test("truncation: a normally-completed response is NOT treated as truncated", () => {
  assertEquals(isTruncatedFinishReason("stop"), false);
  assertEquals(isTruncatedFinishReason("completed"), false);
  // A missing/unknown finish_reason must not be assumed truncated — that
  // would fail every provider that omits the field.
  assertEquals(isTruncatedFinishReason(undefined), false);
  assertEquals(isTruncatedFinishReason(null), false);
  assertEquals(isTruncatedFinishReason("unknown"), false);
  // content_filter is a real failure, but a DIFFERENT one; it is classified
  // by the existing structured-status path, not as truncation.
  assertEquals(isTruncatedFinishReason("content_filter"), false);
});

Deno.test("mass omission: the default ratio rejects the observed 47-of-50 loss but tolerates ordinary sloppiness", () => {
  const limit = maxOmittedFieldRatio();
  assertEquals(limit, 0.5);

  // The real failure: 47 of 50 fields omitted -> must be rejected.
  assertEquals(47 / 50 > limit, true);

  // A couple of omissions in a 50-field schema is model sloppiness, not a
  // truncated answer, and must NOT fail a run that previously succeeded.
  assertEquals(2 / 50 > limit, false);
  assertEquals(10 / 50 > limit, false);

  // Exactly at the limit is tolerated (the guard uses strictly-greater-than),
  // so the threshold can be tuned to an exact fraction without surprise.
  assertEquals(25 / 50 > limit, false);
});

Deno.test("mass omission: the ratio is configurable and rejects out-of-range values", () => {
  const original = Deno.env.get("LEASE_WHOLE_DOCUMENT_LLM_MAX_OMITTED_FIELD_RATIO");
  const restore = () => {
    if (original === undefined) Deno.env.delete("LEASE_WHOLE_DOCUMENT_LLM_MAX_OMITTED_FIELD_RATIO");
    else Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_OMITTED_FIELD_RATIO", original);
  };
  try {
    Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_OMITTED_FIELD_RATIO", "0.1");
    assertEquals(maxOmittedFieldRatio(), 0.1);

    // Zero is a legitimate setting: reject ANY omission (strictest mode).
    Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_OMITTED_FIELD_RATIO", "0");
    assertEquals(maxOmittedFieldRatio(), 0);

    // Out-of-range and garbage fall back to the safe default rather than
    // silently disabling the guard.
    for (const bad of ["-0.5", "1.5", "abc", ""]) {
      Deno.env.set("LEASE_WHOLE_DOCUMENT_LLM_MAX_OMITTED_FIELD_RATIO", bad);
      assertEquals(maxOmittedFieldRatio(), 0.5, `expected fallback for ${JSON.stringify(bad)}`);
    }
  } finally {
    restore();
  }
});

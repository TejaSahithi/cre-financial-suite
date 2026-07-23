// @ts-nocheck
// Regression test for lease-workflow.ts's profileSignalContext() length cap.
// This function builds the text scanned by ~80 amendment/assignment/
// full-lease signal regexes on every document. It was previously unbounded
// -- fullText + every non-blank field's value + every extracted item's
// source text concatenated with no limit, which measured over 165,000
// characters for a real multi-page lease (more than double this codebase's
// own MAX_STORED_TEXT_CHARS=80,000 convention used everywhere else) and is
// a real contributor to the "CPU Time exceeded" crashes observed during the
// enrich stage. Signal detection is title/recital-level classification, not
// field extraction, so capping it does not lose real data.
//
// Run: deno test --allow-env --no-lock lease-workflow-profile-signal-context-cap.test.ts

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ } from "../_shared/extraction/lease-workflow.ts";

const { profileSignalContext, PROFILE_SIGNAL_CONTEXT_MAX_CHARS } = __test__;

Deno.test("profileSignalContext caps its output at PROFILE_SIGNAL_CONTEXT_MAX_CHARS for an oversized document", () => {
  const hugeText = "A".repeat(200_000);
  const result = profileSignalContext(hugeText, "base_lease", {}, []);
  assert(result.length <= PROFILE_SIGNAL_CONTEXT_MAX_CHARS);
  assertEquals(result.length, PROFILE_SIGNAL_CONTEXT_MAX_CHARS);
});

Deno.test("profileSignalContext leaves a normal-sized document's context untouched", () => {
  const normalText = "FIRST AMENDMENT TO LEASE\n\nThis amendment is entered into...";
  const result = profileSignalContext(normalText, "amendment", {}, []);
  assert(result.includes("first amendment to lease") || result.toLowerCase().includes("first amendment to lease"));
  assert(result.length < PROFILE_SIGNAL_CONTEXT_MAX_CHARS);
});

Deno.test("profileSignalContext still detects a title-level signal that survives truncation", () => {
  const withTitleUpfront = `FIRST AMENDMENT TO LEASE\n\n${"filler text ".repeat(20_000)}`;
  const result = profileSignalContext(withTitleUpfront, null, {}, []);
  assert(result.length <= PROFILE_SIGNAL_CONTEXT_MAX_CHARS);
  assert(result.toLowerCase().startsWith("first amendment to lease"));
});

Deno.test("profileSignalContext combines documentSubtype, fullText, field values, and item source text", () => {
  const result = profileSignalContext(
    "base lease body text",
    "base_lease",
    { tenant_name: { value: "Acme Corp" } } as any,
    [{ item_type: "clause", field_key: "x", business_area: "y", value: "z", source_text: "extracted snippet" }],
  );
  assert(result.includes("base_lease"));
  assert(result.includes("base lease body text"));
  assert(result.includes("Acme Corp") || result.includes("acme corp"));
  assert(result.includes("extracted snippet"));
});

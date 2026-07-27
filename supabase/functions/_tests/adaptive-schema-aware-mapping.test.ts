// @ts-nocheck
// LLM-primary schema-aware mapping — golden-corpus-style tests.
//
// Covers the new mapping path (adaptive-extractor.ts's schema-aware domain
// calls, fact-field-mapper.ts's llmProposedFieldKey fast-path, and
// llm-field-validator.ts's narrowed self-consistency pass), following the
// same adversarial-fixture convention golden-lease-corpus.test.ts already
// established. No live LLM calls -- pure function tests against the
// __test__-exported internals and synthetic Fact objects.

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ as adaptive } from "../_shared/extraction/openai-fact-ledger/adaptive-extractor.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { applyValidationCorrections } from "../_shared/extraction/openai-fact-ledger/llm-field-validator.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";
import type { ExtractedRecord } from "../_shared/extraction/types.ts";

const { fieldsForDomain, buildDomainFieldReference, parseFieldAssignmentResponse, assignmentsToFacts } = adaptive;

// ── Part 1: per-domain field list ────────────────────────────────────────────

Deno.test("fieldsForDomain: rent_and_charges includes monthly_rent, excludes term-date fields", () => {
  const fields = fieldsForDomain("rent_and_charges", "lease");
  const keys = fields.map(([key]) => key);
  assert(keys.includes("monthly_rent"), "monthly_rent must route to rent_and_charges");
  assert(!keys.includes("commencement_date"), "commencement_date belongs to core_terms, not rent_and_charges");
});

Deno.test("fieldsForDomain: every returned field is non-derived", () => {
  const fields = fieldsForDomain("core_terms", "lease");
  for (const [, def] of fields) {
    assert(!def.derived, "fieldsForDomain must never include a derived field -- the LLM is not asked to compute anything");
  }
});

Deno.test("buildDomainFieldReference: includes each field's real description, not just its key", () => {
  const fields = fieldsForDomain("rent_and_charges", "lease").filter(([key]) => key === "monthly_rent");
  const ref = buildDomainFieldReference(fields);
  assert(ref.includes("monthly_rent"));
  assert(ref.length > "monthly_rent".length + 20, "reference must carry the field's description, not just its bare key");
});

// ── Part 2: response parsing ─────────────────────────────────────────────────

Deno.test("parseFieldAssignmentResponse: a normal assignment parses with its source_text", () => {
  const valid = new Set(["monthly_rent", "annual_rent"]);
  const out = parseFieldAssignmentResponse(
    { fields: { monthly_rent: { value: 2100, source_text: "Base Rent shall be $2,100.00 per month.", source_page: 3, confidence: 0.95 } } },
    valid,
  );
  assertEquals(out.monthly_rent.value, 2100);
  assertEquals(out.monthly_rent.sourceText, "Base Rent shall be $2,100.00 per month.");
  assertEquals(out.monthly_rent.notStated, false);
});

Deno.test("parseFieldAssignmentResponse: not_stated produces no entry at all (never a guessed value)", () => {
  const valid = new Set(["monthly_rent"]);
  const out = parseFieldAssignmentResponse({ fields: { monthly_rent: { not_stated: true } } }, valid);
  assertEquals(out.monthly_rent, undefined, "a field the model reports as not_stated must not appear in the output at all");
});

Deno.test("parseFieldAssignmentResponse: a field key outside this domain's own list is dropped, even if the model returned one", () => {
  const valid = new Set(["monthly_rent"]); // deliberately excludes tenant_name
  const out = parseFieldAssignmentResponse(
    { fields: { tenant_name: { value: "Acme LLC", source_text: "Tenant: Acme LLC", source_page: 1, confidence: 0.9 } } },
    valid,
  );
  assertEquals(out.tenant_name, undefined, "the model must stay within the field list it was given for this call");
});

Deno.test("parseFieldAssignmentResponse: a value with no real source_text is treated as not_stated, never trusted ungrounded", () => {
  const valid = new Set(["monthly_rent"]);
  const out = parseFieldAssignmentResponse(
    { fields: { monthly_rent: { value: 2100, source_text: "", source_page: null, confidence: 0.9 } } },
    valid,
  );
  assertEquals(out.monthly_rent, undefined);
});

// ── Part 3: semantic veto on the model's own proposal ────────────────────────

Deno.test("assignmentsToFacts: a genuine base-rent assignment passes the semantic gate cleanly", () => {
  const facts = assignmentsToFacts(
    "rent_and_charges",
    { monthly_rent: { value: 2100, sourceText: "Base Rent shall be $2,100.00 per month.", sourcePage: 3, confidence: 0.95, notStated: false } },
    0,
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].llmProposedFieldKey, "monthly_rent");
  assertEquals(facts[0].semanticVetoReason, null);
});

Deno.test("assignmentsToFacts: a surcharge-framed value proposed for monthly_rent is flagged, not silently trusted", () => {
  // The exact adversarial pattern this whole investigation traced: a
  // maintenance surcharge described as being "added to" the rent is not the
  // rent itself, even though the sentence contains the words "monthly rent."
  const facts = assignmentsToFacts(
    "rent_and_charges",
    {
      monthly_rent: {
        value: 174.55,
        sourceText: "A $174.55 grease trap maintenance charge will be added to the monthly rent effective January 1.",
        sourcePage: 21,
        confidence: 0.8,
        notStated: false,
      },
    },
    0,
  );
  assertEquals(facts.length, 1);
  assertEquals(facts[0].llmProposedFieldKey, "monthly_rent");
  assertExists(facts[0].semanticVetoReason, "an additional-charge sentence proposed for monthly_rent must be flagged by the semantic gate, not accepted unqualified");
});

// ── Part 4: fact-field-mapper.ts's fast-path priority ────────────────────────

Deno.test("mapFactsToStandardFields: an llmProposedFieldKey fact wins its field even against a higher-labeled competitor", () => {
  const facts: Fact[] = [
    {
      category: "clause:rent",
      value: 2100,
      sourceText: "Base Rent shall be $2,100.00 per month.",
      sourcePage: 3,
      confidence: 0.95,
      chunkIndex: 0,
      llmProposedFieldKey: "monthly_rent",
      semanticVetoReason: null,
    },
    // A generic keyword-scored competitor for the same field -- must not win.
    {
      category: "clause:default",
      value: 999,
      sourceText: "Monthly rent monthly rent monthly rent -- a keyword-stuffed distractor with no real evidentiary weight.",
      sourcePage: 9,
      confidence: 0.99,
      chunkIndex: 1,
    },
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.monthly_rent.value, 2100, "the LLM's own schema-aware proposal must win, not a higher-confidence keyword-only guess");
  assertEquals(result.records[0].fields.monthly_rent.llmPrimaryMapped, true);
});

Deno.test("mapFactsToStandardFields: a semantic-veto-flagged assignment still populates the field, marked needs_review, not hard-blanked", () => {
  const facts: Fact[] = [
    {
      category: "clause:rent",
      value: 174.55,
      sourceText: "A $174.55 grease trap maintenance charge will be added to the monthly rent effective January 1.",
      sourcePage: 21,
      confidence: 0.8,
      chunkIndex: 0,
      llmProposedFieldKey: "monthly_rent",
      semanticVetoReason: "monthly_rent: rejected monetary role additional_rent (expected base_rent)",
    },
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const field = result.records[0].fields.monthly_rent;
  assertEquals(field.value, 174.55, "a vetoed proposal is flagged, never silently dropped to null");
  assertEquals(field.extractionStatus, "needs_review");
  assertEquals(field.requiresReview, true);
});

Deno.test("mapFactsToStandardFields: an additional_facts entry (content outside the domain's named field list) reaches unmappedFacts, not silently dropped", () => {
  // Proves the fix for the gap found when a real reviewer pointed out that
  // the schema-aware prompt only asks about its own named fields -- content
  // real and relevant to the document but not one of the 88 fields must
  // still reach surfaceDynamicFacts's dynamic-row path (unmappedFacts is
  // exactly that path's input), the same as the old broad-extraction prompt
  // always provided.
  const facts: Fact[] = [
    {
      category: "clause:default",
      value: "Tenant shall maintain a certificate of pest control quarterly.",
      sourceText: "Tenant shall maintain a certificate of pest control quarterly, at Tenant's sole cost.",
      sourcePage: 14,
      confidence: 0.8,
      chunkIndex: 0,
      // No llmProposedFieldKey -- this came back in additional_facts, not fields.
    },
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assert(
    result.unmappedFacts.some((f) => f.sourceText.includes("pest control")),
    "an additional-facts entry with no matching named field must land in unmappedFacts so it can surface as a dynamic row, not vanish",
  );
});

Deno.test("mapFactsToStandardFields: a field with no llmProposedFieldKey fact falls through to ordinary keyword scoring unchanged", () => {
  const facts: Fact[] = [
    {
      category: "clause:party_identification",
      value: "Acme LLC",
      sourceText: "Tenant: Acme LLC",
      sourcePage: 1,
      confidence: 0.9,
      chunkIndex: 0,
      // No llmProposedFieldKey -- e.g. this domain's schema-aware call
      // reported not_stated, or LLM_PRIMARY_MAPPING_MODE is off.
    },
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0].fields.tenant_name?.value, "Acme LLC", "legacy keyword-scoring path must still resolve fields the LLM-primary mapper didn't touch");
});

// ── Part 5: verification pass stays within its narrowed scope ──────────────

Deno.test("applyValidationCorrections: a 'null' decision clears an llmPrimaryMapped field", () => {
  const records: ExtractedRecord[] = [{
    rowIndex: 0,
    fields: {
      monthly_rent: { value: 174.55, source: "llm", confidence: 0.8, llmPrimaryMapped: true },
    },
  }];
  const { cleared, confirmed } = applyValidationCorrections({
    records,
    results: [{ field: "monthly_rent", decision: "null", reason: "quote describes a surcharge, not base rent" }],
  });
  assertEquals(cleared, 1);
  assertEquals(confirmed, 0);
  assertEquals(records[0].fields.monthly_rent, undefined);
});

Deno.test("applyValidationCorrections: a 'confirm' decision leaves the field untouched", () => {
  const records: ExtractedRecord[] = [{
    rowIndex: 0,
    fields: {
      monthly_rent: { value: 2100, source: "llm", confidence: 0.95, llmPrimaryMapped: true },
    },
  }];
  const { confirmed } = applyValidationCorrections({
    records,
    results: [{ field: "monthly_rent", decision: "confirm", reason: "quote directly states the base rent amount" }],
  });
  assertEquals(confirmed, 1);
  assertEquals(records[0].fields.monthly_rent.value, 2100);
});

Deno.test("applyValidationCorrections: a decision targeting a field NOT set by this run's primary mapper is refused, not applied blindly", () => {
  // This is the exact gap the original (pre-rework) validator had: acting on
  // a field it had no history with. The narrowed contract only trusts
  // fields explicitly marked llmPrimaryMapped by fact-field-mapper.ts.
  const records: ExtractedRecord[] = [{
    rowIndex: 0,
    fields: {
      tenant_name: { value: "Acme LLC", source: "llm", confidence: 0.9 }, // no llmPrimaryMapped flag -- keyword-mapped, out of scope
    },
  }];
  const { cleared, confirmed } = applyValidationCorrections({
    records,
    results: [{ field: "tenant_name", decision: "null", reason: "unrelated guess" }],
  });
  assertEquals(cleared, 0);
  assertEquals(confirmed, 0);
  assertEquals(records[0].fields.tenant_name.value, "Acme LLC", "a field this run's primary mapper never touched must survive untouched, regardless of what the verification pass says about it");
});

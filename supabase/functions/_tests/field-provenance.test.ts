// @ts-nocheck
// Micro-step 0 (pipeline-audit provenance) tests. See
// LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md Section 16 for the design these
// verify. Every test here proves ONE of two things: (a) fieldProvenance is
// populated correctly for a given scenario, or (b) the two guardrail
// invariants hold — selection is unchanged, and candidate lists stay capped
// — regardless of whether fieldProvenance is inspected at all.
//
// Scope note (disclosed, not silent): this Micro-step only instruments the
// openai_fact_ledger pipeline (fact-field-mapper.ts), since that is the
// active path for the Craven Wings document this audit investigates
// (diagnostics showed openai_extraction_attempted: false — the legacy_hybrid
// fallback never ran). FieldPipelinePath's "legacy_rule" / "legacy_targeted_llm"
// / "table_extraction" values are reserved for a future pass instrumenting
// rule-extractor.ts/llm-extractor.ts — no code in this PR ever produces them,
// so no test here claims to exercise them.
// Run: deno test --allow-env --allow-read --allow-net --no-lock field-provenance.test.ts

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    category: "clause:default",
    value: "test value",
    sourceText: "Some source text",
    sourcePage: 1,
    confidence: 0.8,
    ...overrides,
  };
}

// ── 1. Fact-ledger selected field: happy path ───────────────────────────────

Deno.test("field-provenance: a cleanly-winning monthly_rent fact populates full selectionProvenance", () => {
  const facts: Fact[] = [
    makeFact({
      category: "clause:rent",
      value: 6004,
      sourceText: "Base Rent: $6,004.00 per month.",
      sourcePage: 14,
      confidence: 0.93,
      chunkIndex: 2,
    }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });

  assertEquals(mapped.records[0]?.fields?.monthly_rent?.value, 6004);
  const prov = mapped.fieldProvenance?.monthly_rent;
  assert(prov, "expected fieldProvenance.monthly_rent to be populated");
  assertEquals(prov.pipelinePath, "openai_fact_ledger");
  assertEquals(prov.chunkIndex, 2);
  assertEquals(prov.shapeGuard.passed, true);
  assertEquals(prov.selected.value, 6004);
  assertEquals(prov.selected.sourcePage, 14);
  assert(prov.mapperScore !== null && prov.mapperScore > 0);
  // Cross-cutting assertion: provenance must not have altered the selected value.
  assertEquals(prov.selected.value, mapped.records[0].fields.monthly_rent.value);
});

// ── 2. Guard-rejected candidate is recorded, and does not win ───────────────

Deno.test("field-provenance: a reletting-clause fact loses/rejects for broker_name and a real broker fact wins", () => {
  const badFact = makeFact({
    category: "clause:default",
    value: "advertising costs",
    sourceText:
      "In addition to all other damages, Tenant will also pay to Landlord its costs of reletting which include brokerage commissions, advertising costs, attorney's fees.",
    sourcePage: 8,
    confidence: 0.7,
  });
  const goodFact = makeFact({
    category: "clause:default",
    value: "Acme Realty, LLC",
    sourceText: "Broker: Acme Realty, LLC, a licensed real estate broker.",
    sourcePage: 8,
    confidence: 0.85,
  });
  const mapped = mapFactsToStandardFields({ facts: [badFact, goodFact], moduleType: "lease" });

  // Asserting against fieldProvenance.selected (the MAPPER's own decision),
  // not mapped.records[0].fields.broker_name.value — a separate, pre-existing
  // downstream sanitizer in validator.ts may independently null an entity
  // field's final value for reasons unrelated to mapping/scoring (confirmed
  // during test development: validator.ts nulls this exact fixture's value
  // while leaving sourceText/confidence untouched). That backend validation
  // behavior is out of scope for this Micro-step (see the guardrail: "do not
  // change ... validation ... behavior") — fieldProvenance's job is to
  // explain the MAPPER's winner, which is what this test verifies.
  const prov = mapped.fieldProvenance?.broker_name;
  assert(prov);
  assertEquals(prov.selected.value, "Acme Realty, LLC");
  assertEquals(prov.shapeGuard.passed, true);
  const rejected = prov.competingCandidates.find((c) => c.value === "advertising costs")
    ?? prov.rejectedCandidates.find((c) => c.value === "advertising costs");
  assert(rejected, "expected the reletting-clause candidate to appear in competingCandidates or rejectedCandidates");
});

// ── 3. A field with no configured guard reports guard: null ────────────────

Deno.test("field-provenance: ti_allowance's formula-area contamination gap (originally confirmed by this audit) is now closed by the semantic compatibility layer", () => {
  // History: this test originally asserted that ti_allowance had NO shape
  // guard at all, so a candidate carrying the AREA operand (2,848 sq ft) from
  // a "$24.00 x 2,848 sq ft = $68,352.00" formula would incorrectly pass
  // through unguarded -- a confirmed audit gap. The semantic-compatibility
  // layer (semantic-compatibility.ts's ti_allowance rule) now hard-rejects a
  // candidate whose value matches a left-hand formula operand instead of the
  // computed total, closing this gap. See LEASE_EXTRACTION_GOLDEN_CORPUS.md.
  const areaOperandFact = makeFact({
    category: "clause:default",
    value: 2848,
    sourceText: "$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance.",
    sourcePage: 21,
    confidence: 0.75,
  });
  const mapped = mapFactsToStandardFields({ facts: [areaOperandFact], moduleType: "lease" });
  const prov = mapped.fieldProvenance?.ti_allowance;
  assert(prov, "expected fieldProvenance.ti_allowance to be populated even though the candidate is rejected");
  assertEquals(prov.shapeGuard.guard, "ti_allowance_shape_guard", "ti_allowance now has a semantic-compatibility guard");
  assertEquals(prov.shapeGuard.passed, false, "the area operand must be hard-rejected, not silently accepted");
  assertEquals(prov.selected.value, null, "no ti_allowance value should be selected from only the area-operand candidate");

  // The computed total, when present as its own candidate fact, is accepted.
  const totalFact = makeFact({
    category: "clause:default",
    value: 68352,
    sourceText: "$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance.",
    sourcePage: 21,
    confidence: 0.75,
  });
  const mappedTotal = mapFactsToStandardFields({ facts: [totalFact], moduleType: "lease" });
  assertEquals(mappedTotal.records[0]?.fields?.ti_allowance?.value, 68352);
});

// ── 4/5. Candidate lists stay capped at 5 (guardrail requirement) ──────────

Deno.test("field-provenance: competingCandidates and rejectedCandidates are capped at 5 even with more than 5 candidates", () => {
  const winner = makeFact({
    category: "clause:default",
    value: "Acme Realty, LLC",
    sourceText: "Broker: Acme Realty, LLC, a licensed real estate broker.",
    sourcePage: 8,
    confidence: 0.95,
  });
  const competitors = Array.from({ length: 7 }, (_, i) =>
    makeFact({
      category: "clause:default",
      value: `Broker Candidate ${i}`,
      sourceText: `Broker: Broker Candidate ${i}, a licensed real estate broker.`,
      sourcePage: 8,
      confidence: 0.5,
    }),
  );
  const rejected = Array.from({ length: 7 }, (_, i) =>
    makeFact({
      category: "clause:default",
      value: `rejected value ${i}`,
      sourceText: `Tenant will pay to Landlord its costs of reletting, damages, and attorneys fees, item ${i}.`,
      sourcePage: 8,
      confidence: 0.5,
    }),
  );
  const mapped = mapFactsToStandardFields({ facts: [winner, ...competitors, ...rejected], moduleType: "lease" });
  const prov = mapped.fieldProvenance?.broker_name;
  assert(prov);
  // See the previous test's comment: asserting against the mapper's own
  // decision (fieldProvenance), not the post-validator.ts final value.
  assertEquals(prov.selected.value, "Acme Realty, LLC");
  assert(prov.competingCandidates.length <= 5, `expected competingCandidates.length <= 5, got ${prov.competingCandidates.length}`);
  assert(prov.rejectedCandidates.length <= 5, `expected rejectedCandidates.length <= 5, got ${prov.rejectedCandidates.length}`);
});

// ── 6. No winner: provenance still reports what was considered ─────────────

Deno.test("field-provenance: a tracked field with only rejected candidates has no winning value, but reports why", () => {
  const facts: Fact[] = [
    makeFact({
      category: "clause:default",
      value: "not a broker",
      sourceText: "Tenant will pay to Landlord its costs of reletting, damages, and attorney's fees.",
      sourcePage: 8,
      confidence: 0.6,
    }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.broker_name, undefined, "no broker_name value should have been selected — cross-cutting invariant");
  const prov = mapped.fieldProvenance?.broker_name;
  assert(prov);
  assertEquals(prov.selected.value, null);
  assert(prov.rejectedCandidates.length >= 1);
});

// ── 7. sourceText truncation ─────────────────────────────────────────────

Deno.test("field-provenance: candidate sourceText is truncated for payload-size safety", () => {
  const longText = "Broker: Acme Realty, a licensed real estate broker. " + "x".repeat(1000);
  const facts: Fact[] = [makeFact({ value: "Acme Realty", sourceText: longText, sourcePage: 8, confidence: 0.9 })];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const prov = mapped.fieldProvenance?.broker_name;
  assert(prov);
  assert(prov.selected.sourceText.length <= 601, `expected truncated sourceText, got length ${prov.selected.sourceText.length}`);
});

// ── 8. Cross-cutting: selection is identical for tracked vs. untracked fields ─

Deno.test("field-provenance: tracking a field for provenance never changes which fact wins it", () => {
  // property_name is NOT in TRACKED_PROVENANCE_FIELDS, monthly_rent IS —
  // both should select their best candidate identically regardless.
  const facts: Fact[] = [
    makeFact({ category: "clause:rent", value: 6004, sourceText: "Base Rent: $6,004.00 per month.", sourcePage: 14, confidence: 0.9 }),
    makeFact({ value: "Markets at Choto", sourceText: "known as The Markets at Choto shopping center", sourcePage: 1, confidence: 0.9 }),
  ];
  const mappedOnce = mapFactsToStandardFields({ facts, moduleType: "lease" });
  const mappedTwice = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mappedOnce.records[0].fields.monthly_rent.value, mappedTwice.records[0].fields.monthly_rent.value);
  assertEquals(mappedOnce.records[0].fields.property_name?.value, mappedTwice.records[0].fields.property_name?.value);
  // property_name has no fieldProvenance entry (untracked) — selection must
  // still succeed identically to the tracked monthly_rent field.
  assertEquals(mappedOnce.fieldProvenance?.property_name, undefined);
  assert(mappedOnce.fieldProvenance?.monthly_rent);
});

// ── 9. Paired-date mirroring is distinguishable from genuine scoring ───────

Deno.test("field-provenance: expiration_date assigned via resolveLeaseTermDatePair's date-pair heuristic is flagged as such, not as its own scoring win", () => {
  // Mirrors openai-fact-ledger.test.ts's own convention for this mechanism:
  // two distinct clause:lease_term facts sharing one sourceText get consumed
  // by resolveLeaseTermDatePair before the main per-fact scoring loop ever
  // runs, so expiration_date genuinely never appears as a scored candidate.
  const sourceText = "5. Term. The lease term shall be from an initial five-year period from March 1, 2019 through December 31, 2023.";
  const facts: Fact[] = [
    makeFact({ category: "clause:lease_term", value: "March 1, 2019", sourceText, sourcePage: 1, confidence: 0.91 }),
    makeFact({ category: "clause:lease_term", value: "December 31, 2023", sourceText, sourcePage: 1, confidence: 0.92 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(mapped.records[0]?.fields?.expiration_date?.value, "2023-12-31");
  const prov = mapped.fieldProvenance?.expiration_date;
  assert(prov, "expiration_date is tracked and should have a provenance entry even when assigned via the date-pair heuristic");
  assert(
    prov.shapeGuard.reasons.some((r) => /paired-date-field heuristic/i.test(r)),
    `expected a paired-date-field heuristic note, got: ${JSON.stringify(prov.shapeGuard.reasons)}`,
  );
  assertEquals(prov.mapperScore, null, "a heuristic-assigned field has no per-fact mapper score of its own");
});

// ── 10. Legacy-payload compatibility: fieldProvenance absent must be safe ──

Deno.test("field-provenance: a consumer that ignores fieldProvenance entirely still reads a correct, unchanged result (legacy compatibility)", () => {
  const facts: Fact[] = [
    makeFact({ category: "clause:rent", value: 6004, sourceText: "Base Rent: $6,004.00 per month.", sourcePage: 14, confidence: 0.9 }),
  ];
  const mapped = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // Simulate an old consumer destructuring only the pre-Micro-step-0 shape.
  const { records, validationErrors, unmappedFacts, rejectedCandidates } = mapped;
  assert(Array.isArray(records));
  assert(Array.isArray(validationErrors));
  assert(Array.isArray(unmappedFacts));
  assert(Array.isArray(rejectedCandidates));
  assertEquals(records[0].fields.monthly_rent.value, 6004);
  // fieldProvenance being present or absent must not matter for this shape.
  const withoutProvenance: any = { records, validationErrors, unmappedFacts, rejectedCandidates };
  assertEquals(withoutProvenance.fieldProvenance, undefined);
});

// @ts-nocheck
// Regression tests for a real production bug found while tracing the
// strict-outputs pilot's confirmed-field-goes-missing investigation:
// dedupeFacts() (fact-ledger-extractor.ts) keyed only on
// [category, sourcePage, sourceText, value] -- with no notion of WHICH
// field a fact was proposed for. A single clause routinely supports several
// distinct field claims with the identical value and identical quoted text
// ("Tenant does pay for all electricity, HVAC, water, sewer... together
// with all taxes..." legitimately grounds electric_responsibility,
// water_sewer_responsibility, AND tax_responsibility as three separate
// semantic claims) -- whichever sorted first silently ate the other two
// before they ever reached field-mapping or verification.
//
// Fix: llmProposedFieldKey (set only by adaptive-extractor.ts's
// schema-aware mapping path) is appended to the dedup key. Facts with no
// proposed field (the legacy broad-category extraction path, not yet tied
// to any one field) are completely unaffected -- their original,
// field-blind dedup behavior is preserved exactly, since deduping
// identical category+text+value facts BEFORE keyword-scoring is still
// intentional for that path (prevents overlapping chunks from inflating a
// single field's candidate score).

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { __test__ as factLedgerExtractorTest } from "../_shared/extraction/openai-fact-ledger/fact-ledger-extractor.ts";
import type { Fact } from "../_shared/extraction/openai-fact-ledger/types.ts";

const { dedupeFacts } = factLedgerExtractorTest;

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    category: "clause:default",
    value: "tenant",
    sourceText: "Some source text",
    sourcePage: 1,
    confidence: 0.9,
    chunkIndex: 0,
    ...overrides,
  };
}

Deno.test("dedupeFacts: preserves multiple field-specific claims from one clause (the real NAREN repro)", () => {
  const sourceText =
    "8.1 Utilities... Tenant does pay for all electricity, HVAC, water, sewer, and other utilities " +
    "and services used at the Premises, together with all taxes, penalties, surcharges, and " +
    "maintenance charges pertaining thereto.";
  const facts = [
    makeFact({ category: "clause:utilities", value: "tenant", sourceText, sourcePage: 8, llmProposedFieldKey: "electric_responsibility" }),
    makeFact({ category: "clause:utilities", value: "tenant", sourceText, sourcePage: 8, llmProposedFieldKey: "water_sewer_responsibility" }),
    makeFact({ category: "clause:utilities", value: "tenant", sourceText, sourcePage: 8, llmProposedFieldKey: "tax_responsibility" }),
  ];
  const result = dedupeFacts(facts);
  assertEquals(result.length, 3, "three distinct field proposals sharing category/page/sourceText/value must all survive");
  const survivingFieldKeys = new Set(result.map((f) => f.llmProposedFieldKey));
  assertEquals(survivingFieldKeys, new Set(["electric_responsibility", "water_sewer_responsibility", "tax_responsibility"]));
});

Deno.test("dedupeFacts: an exact duplicate (same field, same everything) still collapses to one", () => {
  const original = makeFact({ llmProposedFieldKey: "electric_responsibility", sourceText: "same quote", value: "tenant" });
  const result = dedupeFacts([original, { ...original }, { ...original }]);
  assertEquals(result.length, 1);
});

Deno.test("dedupeFacts: same field, different values both survive (conflict is Lease Truth Assembly's job, not dedup's)", () => {
  const result = dedupeFacts([
    makeFact({ llmProposedFieldKey: "tax_responsibility", value: "tenant", sourceText: "clause A" }),
    makeFact({ llmProposedFieldKey: "tax_responsibility", value: "landlord", sourceText: "clause B" }),
  ]);
  assertEquals(result.length, 2, "a real value conflict must not be silently resolved by dedup -- value is already part of the key");
});

Deno.test("dedupeFacts: intentional field aliases (tax_responsibility / responsibility_taxes) do not eat each other", () => {
  const sourceText = "Tenant shall be responsible for all real estate taxes.";
  const result = dedupeFacts([
    makeFact({ llmProposedFieldKey: "tax_responsibility", value: "tenant", sourceText }),
    makeFact({ llmProposedFieldKey: "responsibility_taxes", value: "tenant", sourceText }),
  ]);
  assertEquals(result.length, 2);
  const survivingFieldKeys = result.map((f) => f.llmProposedFieldKey).sort();
  assertEquals(survivingFieldKeys, ["responsibility_taxes", "tax_responsibility"]);
});

Deno.test("dedupeFacts: legacy facts with NO proposed field keep the original, unchanged field-blind behavior", () => {
  // No llmProposedFieldKey at all -- the broad-category extraction path
  // (callDomainLlm / extractFactLedger's whole-document chunking), which
  // this fix must not touch: deduping identical category+text+value BEFORE
  // keyword-scoring is still intentional there.
  const sourceText = "Rent is $5,000 per month, due on the first of each month.";
  const result = dedupeFacts([
    makeFact({ category: "clause:rent", value: "5000", sourceText, sourcePage: 2 }),
    makeFact({ category: "clause:rent", value: "5000", sourceText, sourcePage: 2 }),
  ]);
  assertEquals(result.length, 1, "the pre-existing field-blind collapse for never-mapped facts must be unchanged");
});

Deno.test("dedupeFacts: a legacy fact and a field-proposed fact sharing category/text/value do not collide with each other", () => {
  // One fact from the broad-extraction path (no field yet) and one from the
  // schema-aware mapper (already tied to a field) happen to describe the
  // same clause identically -- these are two different pipeline stages'
  // output, not duplicates of each other.
  const sourceText = "Tenant shall maintain general liability insurance.";
  const result = dedupeFacts([
    makeFact({ category: "clause:insurance", value: "tenant", sourceText }),
    makeFact({ category: "clause:insurance", value: "tenant", sourceText, llmProposedFieldKey: "tenant_insurance_required" }),
  ]);
  assertEquals(result.length, 2);
});

Deno.test("dedupeFacts: same-source lease term dates still survive as distinct facts (pre-existing behavior, unaffected)", () => {
  const sourceText = "5. Term. The lease term shall be from an initial five-year period from March 1, 2019 through December 31, 2023.";
  const result = dedupeFacts([
    makeFact({ category: "clause:lease_term", value: "March 1, 2019", sourceText }),
    makeFact({ category: "clause:lease_term", value: "December 31, 2023", sourceText }),
    makeFact({ category: "clause:lease_term", value: "March 1, 2019", sourceText }),
  ]);
  assertEquals(result.map((f) => f.value), ["March 1, 2019", "December 31, 2023"]);
});

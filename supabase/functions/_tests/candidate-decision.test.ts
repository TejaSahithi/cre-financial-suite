// @ts-nocheck
// Release 1 (document-coverage architecture audit): unit tests for the
// shared candidate-decision engine, plus its two live integration points
// (merger.ts, fact-field-mapper.ts). This is the direct fix for the
// CAM-fee/tax-responsibility misclassification bug class: no code path
// previously checked that a candidate's source-text/clause-category
// matched its target field's domain before accepting it.

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateCandidateForField } from "../_shared/extraction/candidate-decision.ts";
import { getSchema, getEvidencePolicyCoverage } from "../_shared/extraction/schemas.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { mergeResults } from "../_shared/extraction/merger.ts";

const leaseSchema = getSchema("lease");

// ── evaluateCandidateForField(): decision-order unit tests ──────────────────

Deno.test("evaluateCandidateForField: unconfigured field is always unconstrained", () => {
  const field = { type: "string", labels: [] }; // no domain, no evidencePolicy
  const result = evaluateCandidateForField({
    field,
    fieldKey: "some_field_with_no_schema_config",
    moduleType: "lease",
    sourceText: "anything at all",
  });
  assertEquals(result.decision, "unconstrained");
  assertEquals(result.valid, true);
});

Deno.test("evaluateCandidateForField: rejected clause category is a hard veto regardless of confidence", () => {
  const field = leaseSchema.admin_fee_pct;
  const result = evaluateCandidateForField({
    field,
    fieldKey: "admin_fee_pct",
    moduleType: "lease",
    sourceText: "Tenant shall pay a late charge equal to five percent (5%) of the overdue amount.",
    factCategory: "clause:late_fees",
    confidence: 0.95,
  });
  assertEquals(result.decision, "reject");
  assertEquals(result.valid, false);
  assert(result.matchedRejectedCategories.includes("late_fees"));
});

Deno.test("evaluateCandidateForField: rejected evidence pattern hard-vetoes even with no fact category (legacy path)", () => {
  const field = leaseSchema.landlord_name;
  const result = evaluateCandidateForField({
    field,
    fieldKey: "landlord_name",
    moduleType: "lease",
    sourceText: "In the event of a permitted transfer to an assignee, the closely held voting shares...",
    // no factCategory -- this is exactly the legacy rule/table/LLM path
  });
  assertEquals(result.decision, "reject");
  assert(result.matchedRejectedTerms.length > 0);
});

Deno.test("evaluateCandidateForField: allowed clause category is a strong positive, not a requirement", () => {
  const field = leaseSchema.admin_fee_pct;
  const result = evaluateCandidateForField({
    field,
    fieldKey: "admin_fee_pct",
    moduleType: "lease",
    sourceText: "Administrative expenses not exceeding 4% of recoverable operating expenses.",
    factCategory: "clause:cam_recoveries",
    confidence: 0.9,
  });
  assertEquals(result.decision, "accept");
  assertEquals(result.categoryMatch, true);
  assert(result.matchedAllowedCategories.includes("cam_recoveries"));
});

Deno.test("evaluateCandidateForField: unexpected-but-not-rejected category needs review, not an automatic reject or accept", () => {
  const field = leaseSchema.admin_fee_pct;
  const result = evaluateCandidateForField({
    field,
    fieldKey: "admin_fee_pct",
    moduleType: "lease",
    sourceText: "Tenant shall maintain commercial general liability insurance.",
    factCategory: "clause:insurance", // neither allowed nor rejected for admin_fee_pct
    confidence: 0.7,
  });
  assertEquals(result.decision, "needs_review");
  assertEquals(result.categoryMatch, false);
});

Deno.test("evaluateCandidateForField: no usable category falls back to required-term/label text match", () => {
  const field = leaseSchema.late_fee_amount;
  const result = evaluateCandidateForField({
    field,
    fieldKey: "late_fee_amount",
    moduleType: "lease",
    sourceText: "A late charge of $50 applies to overdue rent payments.",
    // no factCategory: legacy path
  });
  assertEquals(result.decision, "accept");
  assert(result.matchedRequiredTerms.length > 0);
});

Deno.test("evaluateCandidateForField: enforced field with no category and no text match needs review, not silent accept", () => {
  const field = leaseSchema.admin_fee_pct;
  const result = evaluateCandidateForField({
    field,
    fieldKey: "admin_fee_pct",
    moduleType: "lease",
    sourceText: "This paragraph is about something entirely unrelated to fees.",
  });
  assertEquals(result.decision, "needs_review");
});

Deno.test("evaluateCandidateForField: advisory policy caps a would-be reject at needs_review, never hard-rejects", () => {
  const field = {
    type: "string",
    labels: ["widget"],
    domain: "legal",
    evidencePolicy: "advisory",
    rejectedClauseCategories: ["late_fees"],
  };
  const result = evaluateCandidateForField({
    field,
    fieldKey: "some_advisory_field",
    moduleType: "lease",
    sourceText: "a late charge clause",
    factCategory: "clause:late_fees",
  });
  assertEquals(result.decision, "needs_review");
  assertEquals(result.valid, true); // advisory never hard-blocks in Release 1
});

// ── getEvidencePolicyCoverage(): honest configuration-gap reporting ────────

Deno.test("getEvidencePolicyCoverage: lease schema reports enforced + advisory + unconfigured summing to total", () => {
  const coverage = getEvidencePolicyCoverage("lease");
  assertEquals(coverage.enforced + coverage.advisory + coverage.unconfigured, coverage.total);
  assert(coverage.enforced >= 6, "the known-ambiguous fields tagged in schemas.ts must count as enforced");
  assert(coverage.total > coverage.enforced, "most of the schema must remain advisory/unconfigured in Release 1 -- this is the honest gap, not a bug");
});

// ── fact-field-mapper.ts integration: the actual CAM-fee bug, reproduced ───

function fact(overrides) {
  return { category: "clause:default", value: null, sourceText: "", sourcePage: 1, confidence: 0.8, ...overrides };
}

Deno.test("mapFactsToStandardFields: a late-payment fact never populates admin_fee_pct (the flagship bug)", () => {
  const facts = [
    fact({
      category: "clause:late_fees",
      value: 5,
      sourceText: "Tenant shall pay a 5% administrative fee on overdue rent as a late charge.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.admin_fee_pct, undefined);
});

Deno.test("mapFactsToStandardFields: a CAM-recoveries fact correctly populates admin_fee_pct (must not regress)", () => {
  const facts = [
    fact({
      category: "clause:cam_recoveries",
      value: 4,
      sourceText: "Administrative fee not exceeding 4% of recoverable operating expenses.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.admin_fee_pct?.value, 4);
});

Deno.test("mapFactsToStandardFields: a renewal-option fact never populates responsibility_taxes", () => {
  const facts = [
    fact({
      category: "clause:renewal_option",
      value: "tenant",
      sourceText: "Tenant's obligation for taxes shall survive any renewal option exercised under Section 12.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.responsibility_taxes, undefined);
});

Deno.test("mapFactsToStandardFields: a taxes-clause fact correctly populates responsibility_taxes (must not regress)", () => {
  const facts = [
    fact({
      category: "clause:taxes",
      value: "tenant",
      sourceText: "Real estate taxes shall be paid by Tenant.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.responsibility_taxes?.value, "tenant");
});

Deno.test("mapFactsToStandardFields: mixed/ambiguous clause (both late-payment and CAM language) is not silently accepted for admin_fee_pct", () => {
  const facts = [
    fact({
      category: "clause:late_fees", // classifier picked late_fees for this genuinely ambiguous clause
      value: 5,
      sourceText: "Tenant shall pay a 5% administrative fee on overdue CAM reconciliation balances.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // Hard veto fires because the classified category is explicitly rejected
  // for admin_fee_pct -- this is the adversarial case a naive labels-only
  // check would have wrongly allowed (both "administrative fee" AND "CAM"
  // appear in the text).
  assertEquals(result.records[0]?.fields?.admin_fee_pct, undefined);
});

Deno.test("mapFactsToStandardFields: false-negative guard -- CAM admin fee described without the exact label still maps", () => {
  const facts = [
    fact({
      category: "clause:operating_expense_recovery",
      value: 3.5,
      sourceText: "The cost of administration of Operating Expenses shall not exceed 3.5% thereof.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // category-based accept fires even though the exact label "administrative
  // fee"/"admin fee" isn't present -- proves the fix isn't over-strict.
  assertEquals(result.records[0]?.fields?.admin_fee_pct?.value, 3.5);
});

Deno.test("mapFactsToStandardFields: rejected candidates are recorded in the audit trail with a reason", () => {
  const facts = [
    fact({
      category: "clause:late_fees",
      value: 5,
      sourceText: "Tenant shall pay a 5% administrative fee on overdue rent.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assert(result.rejectedCandidates.length > 0);
  const rejected = result.rejectedCandidates.find((c) => c.field_key === "admin_fee_pct");
  assert(rejected, "the rejected admin_fee_pct candidate must be in the audit trail");
  assertEquals(rejected.decision, "reject");
  assertEquals(rejected.reason, "category_incompatible");
});

// ── merger.ts integration: legacy_hybrid path (previously zero test coverage) ──

function stepResult(fields) {
  return { records: [{ fields, rowIndex: 0 }], warnings: [] };
}
const empty = { records: [], warnings: [] };

Deno.test("mergeResults: baseline -- higher confidence wins across sources", () => {
  const rule = stepResult({ tenant_name: { value: "Acme Rule", source: "rule", confidence: 0.95, sourceText: "Tenant: Acme Rule" } });
  const llm = stepResult({ tenant_name: { value: "Acme LLM", source: "llm", confidence: 0.7, sourceText: "Tenant: Acme LLM" } });
  const merged = mergeResults(rule, empty, llm, "lease");
  assertEquals(merged.records[0].fields.tenant_name.value, "Acme Rule");
});

Deno.test("mergeResults: baseline -- equal confidence breaks tie by source priority (rule > table > llm)", () => {
  const rule = stepResult({ tenant_name: { value: "Acme Rule", source: "rule", confidence: 0.9, sourceText: "Tenant: Acme Rule" } });
  const llm = stepResult({ tenant_name: { value: "Acme LLM", source: "llm", confidence: 0.9, sourceText: "Tenant: Acme LLM" } });
  const merged = mergeResults(rule, empty, llm, "lease");
  assertEquals(merged.records[0].fields.tenant_name.value, "Acme Rule");
});

Deno.test("mergeResults: domain veto -- a rejected-pattern candidate never overwrites, even with higher confidence", () => {
  const llmLow = stepResult({
    landlord_name: { value: "224 Partners, LLC", source: "llm", confidence: 0.6, sourceText: "between 224 Partners, LLC (\"Landlord\") and..." },
  });
  const tableHigh = stepResult({
    landlord_name: { value: "Some Assignee Corp", source: "table", confidence: 0.99, sourceText: "the closely held voting shares held by the permitted transfer assignee" },
  });
  const merged = mergeResults(empty, tableHigh, llmLow, "lease");
  // Table would normally win on confidence (0.99 > 0.6), but its source
  // text hits landlord_name's rejectedEvidencePatterns -- the low-confidence
  // LLM candidate must survive instead of being silently overwritten.
  assertEquals(merged.records[0].fields.landlord_name.value, "224 Partners, LLC");
});

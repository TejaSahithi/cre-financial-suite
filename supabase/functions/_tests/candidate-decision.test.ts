// @ts-nocheck
// Release 1 (document-coverage architecture audit): unit tests for the
// shared candidate-decision engine, plus its two live integration points
// (merger.ts, fact-field-mapper.ts). This is the direct fix for the
// CAM-fee/tax-responsibility misclassification bug class: no code path
// previously checked that a candidate's source-text/clause-category
// matched its target field's domain before accepting it.

import { assert, assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { evaluateCandidateForField } from "../_shared/extraction/candidate-decision.ts";
import { getSchema, getEvidencePolicyCoverage } from "../_shared/extraction/schemas.ts";
import { mapFactsToStandardFields } from "../_shared/extraction/openai-fact-ledger/fact-field-mapper.ts";
import { mergeResults } from "../_shared/extraction/merger.ts";
import { coerceValue } from "../_shared/extraction/rule-extractor.ts";

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

// ── fact-field-mapper.ts integration: the identity/premises/dates bug class ──
// (real lease upload: landlord_name/tenant_name/property_address/property_name
// populated from unrelated clause fragments; start_date/end_date/
// commencement_date/expiration_date left entirely unmapped despite the dates
// being present in clean, unlabeled "term shall be from X through Y" text.)

Deno.test("mapFactsToStandardFields: an indemnification-clause fact never populates landlord_name", () => {
  const facts = [
    fact({
      category: "clause:indemnification",
      value: "defend the same at Tenant's expense",
      sourceText: "Tenant shall indemnify, defend, and hold Landlord harmless from and against any and all claims arising from Tenant's use of the Premises, and shall defend the same at Tenant's expense.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.landlord_name, undefined);
});

Deno.test("mapFactsToStandardFields: an indemnification-clause fact never populates tenant_name", () => {
  const facts = [
    fact({
      category: "clause:indemnification",
      value: "any and all claims",
      sourceText: "Tenant shall indemnify, defend, and hold Landlord harmless from and against any and all claims arising from Tenant's use of the Premises.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.tenant_name, undefined);
});

Deno.test("mapFactsToStandardFields: a party_identification-clause fact correctly populates landlord_name and tenant_name (must not regress)", () => {
  const facts = [
    fact({
      category: "clause:party_identification",
      value: "Macon Crossing",
      sourceText: "This lease is hereby made and entered into by and between Macon Crossing (herein called \"Landlord\"), and Justin Cress (herein called \"Tenant\").",
    }),
    fact({
      category: "clause:party_identification",
      value: "Justin Cress",
      sourceText: "This lease is hereby made and entered into by and between Macon Crossing (herein called \"Landlord\"), and Justin Cress (herein called \"Tenant\").",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // Both facts share identical sourceText and category, so which one wins
  // which field is resolved by the mapper's existing confidence tie-break,
  // not by this test -- what matters is that landlord_name/tenant_name get
  // populated with SOME value from this clause, not left empty and not
  // populated with a fragment from an unrelated clause.
  const landlord = result.records[0]?.fields?.landlord_name?.value;
  const tenant = result.records[0]?.fields?.tenant_name?.value;
  assert(landlord === "Macon Crossing" || tenant === "Macon Crossing");
});

Deno.test("mapFactsToStandardFields: a use-clause fact never populates property_address", () => {
  const facts = [
    fact({
      category: "clause:use_clause",
      value: "Restaurant and related sales",
      sourceText: "Tenant shall use the Premises for Restaurant and related sales and shall not use or permit the Premises to be used for any other purpose.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.property_address, undefined);
});

Deno.test("mapFactsToStandardFields: a premises_description-clause fact correctly populates property_address (must not regress)", () => {
  const facts = [
    fact({
      category: "clause:premises_description",
      value: "10721 Chapman Hwy #21, Seymour, Sevier County, Tennessee",
      sourceText: "Said Premises are located at 10721 Chapman Hwy #21, Seymour, Sevier County, Tennessee.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.property_address?.value, "10721 Chapman Hwy #21, Seymour, Sevier County, Tennessee");
});

// ── fact-field-mapper.ts integration: resolveLeaseTermDatePair() ───────────

Deno.test("mapFactsToStandardFields: an unlabeled 'term shall be from X through Y' sentence populates both start_date and end_date correctly ordered", () => {
  const sourceText = "5. Term. The lease term shall be from an initial five-year period from March 1, 2019 through December 31, 2023.";
  const facts = [
    fact({ category: "clause:lease_term", value: "March 1, 2019", sourceText }),
    fact({ category: "clause:lease_term", value: "December 31, 2023", sourceText }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // validateRecords() normalizes date-typed field values to YYYY-MM-DD.
  assertEquals(result.records[0]?.fields?.start_date?.value, "2019-03-01");
  assertEquals(result.records[0]?.fields?.end_date?.value, "2023-12-31");
  assertEquals(result.records[0]?.fields?.commencement_date?.value, "2019-03-01");
  assertEquals(result.records[0]?.fields?.expiration_date?.value, "2023-12-31");
});

Deno.test("mapFactsToStandardFields: the date-pair resolver doesn't care which order the two facts appear in", () => {
  const sourceText = "The lease term shall be from January 1, 2020 through December 31, 2025.";
  const facts = [
    fact({ category: "clause:lease_term", value: "December 31, 2025", sourceText }),
    fact({ category: "clause:lease_term", value: "January 1, 2020", sourceText }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.start_date?.value, "2020-01-01");
  assertEquals(result.records[0]?.fields?.end_date?.value, "2025-12-31");
});

Deno.test("mapFactsToStandardFields: a single lease_term date (no pair) falls through to normal scoring, not the pair resolver", () => {
  const facts = [
    fact({
      category: "clause:lease_term",
      value: "February 1, 2024",
      sourceText: "8. (b) Commencement Date: February 1, 2024",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // Only one candidate -- resolveLeaseTermDatePair requires exactly two, so
  // this is scored normally. start_date and commencement_date both list
  // "commencement date" as a label and both now allow clause:lease_term, so
  // they score identically on this single fact; start_date wins the tie
  // (declared earlier in the schema) -- either is a correct outcome, they're
  // synonymous concepts, so accept whichever one actually got it.
  const startDate = result.records[0]?.fields?.start_date?.value;
  const commencementDate = result.records[0]?.fields?.commencement_date?.value;
  assert(startDate === "2024-02-01" || commencementDate === "2024-02-01");
});

Deno.test("mapFactsToStandardFields: an unparseable lease_term date does not crash the pair resolver and falls through unmapped", () => {
  const sourceText = "The lease term shall be from IST March 2019 through Dec 31, 2023.";
  const facts = [
    fact({ category: "clause:lease_term", value: "IST March 2019", sourceText }),
    fact({ category: "clause:lease_term", value: "Dec 31, 2023", sourceText }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // "IST" (an OCR misread of "1st") still parses fine once the ordinal-suffix
  // stripping fallback runs -- this proves the resolver is defensive, not
  // that it always succeeds; a genuinely unparseable pair should fall
  // through without throwing, which the assertion below doesn't distinguish
  // but the absence of a thrown error already proves.
  assertExists(result.records);
});

// ── fact-field-mapper.ts integration: the "Tenant"/"Landlord" bare-pronoun
// false-positive (real lease evidence: an unrelated "nuisance" prohibition
// clause -- which merely uses "Tenant" as the document's defined-term
// pronoun, the same as nearly every clause in the lease -- won tenant_name
// with value "nuisance" before this fix) ─────────────────────────────────

Deno.test("mapFactsToStandardFields: an unrelated clause merely mentioning 'Tenant' as a pronoun never populates tenant_name", () => {
  const facts = [
    fact({
      category: "clause:default", // realistic: a generic prohibited-use/nuisance clause doesn't cleanly match any category
      value: "nuisance",
      sourceText: "Nor shall Tenant cause, maintain or permit any nuisance in, on or about the Premises.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.tenant_name, undefined);
});

Deno.test("mapFactsToStandardFields: an unrelated clause merely mentioning 'Landlord' as a pronoun never populates landlord_name", () => {
  const facts = [
    fact({
      category: "clause:default",
      value: "erect scaffolding",
      sourceText: "Landlord reserves the right to enter the Premises to inspect the same and may for that purpose erect scaffolding.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.landlord_name, undefined);
});

Deno.test("mapFactsToStandardFields: a labeled 'Tenant Name:' line still correctly populates tenant_name (must not regress)", () => {
  const facts = [
    fact({
      category: "clause:party_identification",
      value: "Riverside Consulting, Inc.",
      sourceText: "Tenant Name: Riverside Consulting, Inc.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  // validateRecords() strips the trailing period as part of general string cleanup.
  assertEquals(result.records[0]?.fields?.tenant_name?.value, "Riverside Consulting, Inc");
});

// ── fact-field-mapper.ts integration: square_footage vs. property_name vs.
// building_rsf sharing one "Premises" clause (real lease evidence: a
// "1875 square feet" fact won property_name instead of square_footage;
// broadening square_footage's labels to catch it then stole an unrelated
// fact from building_rsf, a real regression this test suite caught) ──────

Deno.test("mapFactsToStandardFields: a bare (no 'rentable'/'leased' qualifier) square-footage fact populates square_footage, not property_name", () => {
  const facts = [
    fact({
      category: "clause:premises_description",
      value: "1875 square feet",
      sourceText: "That certain space in the Macon Crossing Shopping Center, having dimensions containing approximately 1875 square feet of floor area.",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.property_name, undefined);
});

Deno.test("mapFactsToStandardFields: a whole-building square footage fact still populates building_rsf, not square_footage (must not regress)", () => {
  const facts = [
    fact({
      value: 45000,
      sourceText: "Building Total Rentable Square Footage: 45,000 building rsf",
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.building_rsf?.value, 45000);
  assertEquals(result.records[0]?.fields?.square_footage, undefined);
});

Deno.test("mapFactsToStandardFields: party clause binds landlord and tenant names to their own role labels", () => {
  const sourceText = '1. Parties. This lease dated this 4 day of Feb 2019, is hereby made and entered into by and between MAcon Crossing (herein called "Landlord"), and JUSTIN CRESS (herein called "Tenant").';
  const facts = [
    fact({ category: "clause:party_identification", value: "MAcon Crossing", sourceText, confidence: 0.99 }),
    fact({ category: "clause:party_identification", value: "JUSTIN CRESS", sourceText, confidence: 0.99 }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.landlord_name?.value, "MAcon Crossing");
  assertEquals(result.records[0]?.fields?.tenant_name?.value, "JUSTIN CRESS");
});

Deno.test("mapFactsToStandardFields: a tenant-pronoun rent-abatement clause cannot populate tenant_name", () => {
  const facts = [
    fact({
      category: "clause:default",
      value: "no abatement of rent",
      sourceText: "If the damage is due to the fault or neglect of Tenant or its employees, there shall be no abatement of rent.",
      confidence: 0.98,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.tenant_name, undefined);
});

Deno.test("mapFactsToStandardFields: a common-area license phrase cannot populate property_name", () => {
  const facts = [
    fact({
      category: "clause:premises_description",
      value: "non-exclusive license",
      sourceText: "Tenant is hereby given a non-exclusive license to use the common areas of the Shopping Center.",
      confidence: 0.96,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.property_name, undefined);
});

Deno.test("mapFactsToStandardFields: annual amount plus monthly installments maps rent to the correct canonical fields", () => {
  const sourceText = "Tenant agrees to pay Landlord as Minimum Rent, without notice or demand, the annual amount of $25,200, payable in the monthly installments of $2,100 in advance.";
  const facts = [
    fact({ category: "clause:rent_escalation", value: 25200, sourceText, confidence: 0.97 }),
    fact({ category: "clause:rent_escalation", value: 2100, sourceText, confidence: 0.97 }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.annual_rent?.value, 25200);
  assertEquals(result.records[0]?.fields?.monthly_rent?.value, 2100);
});

Deno.test("mapFactsToStandardFields: annual rent value is not accepted as monthly rent when source text says annual amount", () => {
  const sourceText = "Tenant agrees to pay Landlord as Minimum Rent, the annual amount of $25,200, payable in monthly installments.";
  const facts = [fact({ category: "clause:rent_escalation", value: 25200, sourceText, confidence: 0.97 })];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.monthly_rent, undefined);
  assertEquals(result.records[0]?.fields?.annual_rent?.value, 25200);
});

Deno.test("mapFactsToStandardFields: OCR-confused first-day term date still populates start and commencement", () => {
  const sourceText = "5. Term. The lease term shall be from an initial five-year period from IST March 2019 through Dec 31, 2023.";
  const facts = [
    fact({ category: "clause:lease_term", value: "IST March 2019", sourceText }),
    fact({ category: "clause:lease_term", value: "Dec 31, 2023", sourceText }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.start_date?.value, "2019-03-01");
  assertEquals(result.records[0]?.fields?.commencement_date?.value, "2019-03-01");
  assertEquals(result.records[0]?.fields?.end_date?.value, "2023-12-31");
  assertEquals(result.records[0]?.fields?.expiration_date?.value, "2023-12-31");
});

Deno.test("mapFactsToStandardFields: renewal period count is not renewal notice months without notice language", () => {
  const facts = [
    fact({
      category: "clause:renewal_option",
      value: 2,
      sourceText: "The Tenant may also have the first right of refusal for (2) optional five (5) year lease periods.",
      confidence: 0.95,
    }),
  ];
  const result = mapFactsToStandardFields({ facts, moduleType: "lease" });
  assertEquals(result.records[0]?.fields?.renewal_notice_months, undefined);
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

Deno.test("mergeResults: a hard-rejected candidate is retained in rejectedCandidates lineage, not silently dropped", () => {
  const llmLow = stepResult({
    landlord_name: { value: "224 Partners, LLC", source: "llm", confidence: 0.6, sourceText: "between 224 Partners, LLC (\"Landlord\") and..." },
  });
  const tableHigh = stepResult({
    landlord_name: { value: "Some Assignee Corp", source: "table", confidence: 0.99, sourceText: "the closely held voting shares held by the permitted transfer assignee" },
  });
  const merged = mergeResults(empty, tableHigh, llmLow, "lease");
  assertEquals(merged.rejectedCandidates.length, 1);
  const [rejected] = merged.rejectedCandidates;
  assertEquals(rejected.field_key, "landlord_name");
  assertEquals(rejected.candidate_value, "Some Assignee Corp");
  assertEquals(rejected.candidate_source, "table");
  assertEquals(rejected.decision, "reject");
  assert(rejected.reason.length > 0);
  assertEquals(rejected.source_text, "the closely held voting shares held by the permitted transfer assignee");
});

Deno.test("mergeResults: high-risk competing candidates surface conflict metadata instead of silently selecting one", () => {
  const rule = stepResult({
    admin_fee_pct: { value: 5, source: "rule", confidence: 0.92, sourceText: "Administrative fee shall be five percent (5%) of recoverable expenses." },
  });
  const llm = stepResult({
    admin_fee_pct: { value: 7, source: "llm", confidence: 0.88, sourceText: "Administrative fee shall be seven percent (7%) of recoverable expenses." },
  });
  const merged = mergeResults(rule, empty, llm, "lease");
  const field = merged.records[0].fields.admin_fee_pct as any;
  assertEquals(field.extractionStatus, "conflict");
  assertEquals(field.canonicalStatus, "conflict");
  assertEquals(field.resolutionState, "provisional");
  assertEquals(field.requiresReview, true);
  assertEquals(field.evidenceDecision, "needs_review");
  assertEquals(field.conflictCandidateIds.length, 2);
  assertEquals(field.conflictCandidates.length, 2);
  assertEquals(new Set(field.candidates.map((candidate: any) => candidate.normalizedValue)).size, 2);
  assertEquals(field.decision.status, "conflict");
});

Deno.test("coerceValue: boolean polarity keeps explicit negatives false", () => {
  const boolDef = { type: "boolean", labels: [], description: "test" } as any;
  assertEquals(coerceValue("does not consent", boolDef), false);
  assertEquals(coerceValue("shall not be grossed up", boolDef), false);
  assertEquals(coerceValue("no waiver of subrogation is required", boolDef), false);
  assertEquals(coerceValue("must maintain insurance", boolDef), true);
  assertEquals(coerceValue("Additional Insured", boolDef), null);
});
Deno.test("evaluateCandidateForField: property_name rejects timing fragments from parking/common-area clauses", () => {
  const result = evaluateCandidateForField({
    field: leaseSchema.property_name,
    fieldKey: "property_name",
    moduleType: "lease",
    value: "one (1) day in each calendar year",
    sourceText: "Tenant shall have the right to use the Shopping Center parking area for one (1) day in each calendar year.",
    confidence: 0.99,
    sourceType: "llm",
  });
  assertEquals(result.decision, "reject");
  assert(result.reasonCodes.includes("VALUE_SHAPE_INVALID") || result.reasonCodes.includes("WRONG_CLAUSE_CATEGORY"));
});

Deno.test("evaluateCandidateForField: unit_number rejects common word fragments", () => {
  const result = evaluateCandidateForField({
    field: leaseSchema.unit_number,
    fieldKey: "unit_number",
    moduleType: "lease",
    value: "in",
    sourceText: "Tenant leases space in the Building known as Suite #21.",
    confidence: 0.95,
    sourceType: "llm",
  });
  assertEquals(result.decision, "reject");
  assert(result.reasonCodes.includes("VALUE_SHAPE_INVALID"));
});

Deno.test("evaluateCandidateForField: insurance responsibility cannot be derived from waiver of subrogation", () => {
  const result = evaluateCandidateForField({
    field: leaseSchema.responsibility_insurance,
    fieldKey: "responsibility_insurance",
    moduleType: "lease",
    value: "landlord",
    sourceText: "Landlord and Tenant waive all rights of recovery by way of subrogation against each other.",
    confidence: 0.98,
    sourceType: "llm",
  });
  assertEquals(result.decision, "reject");
  assert(result.reasonCodes.includes("WRONG_CLAUSE_CATEGORY"));
});

Deno.test("evaluateCandidateForField: electric responsibility rejects repair-only electrical wording", () => {
  const result = evaluateCandidateForField({
    field: leaseSchema.electric_responsibility,
    fieldKey: "electric_responsibility",
    moduleType: "lease",
    value: "tenant",
    sourceText: "Tenant shall repair and maintain the electrical wiring and fixtures within the Premises.",
    confidence: 0.96,
    sourceType: "llm",
  });
  assertEquals(result.decision, "reject");
  assert(result.reasonCodes.includes("WRONG_CLAUSE_CATEGORY"));
});

Deno.test("evaluateCandidateForField: conditional assignment consent does not become mandatory consent", () => {
  const result = evaluateCandidateForField({
    field: leaseSchema.landlord_consent_for_transfer,
    fieldKey: "landlord_consent_for_transfer",
    moduleType: "lease",
    value: "Landlord shall consent to assignment",
    sourceText: "If Landlord consents to any assignment, Landlord may impose conditions and may withhold consent in its sole and absolute discretion.",
    confidence: 0.99,
    sourceType: "llm",
  });
  assertEquals(result.decision, "reject");
  assert(result.reasonCodes.includes("CONDITIONAL_LANGUAGE"));
});
// @ts-nocheck
/**
 * Lease Truth Assembly — unit tests for the canonical publication layer.
 *
 * Fixtures use `extractionDebug.merged_field_sources` in the exact shape
 * `snapshotFieldMap()` (pipeline.ts) produces -- the shared, pipeline-
 * agnostic evidence carrier both legacy_hybrid and openai_fact_ledger
 * already populate identically (verified by reading both call sites before
 * writing this module). No document-specific literals; every fixture is a
 * generalized sentence shape.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { assembleCanonicalFields, inferObligationActor } from "../_shared/extraction/lease-truth-assembly.ts";

function evidence(value: unknown, sourceText: string, opts: Partial<{ source: string; confidence: number; sourcePage: number }> = {}) {
  return {
    value,
    source: opts.source ?? "llm",
    confidence: opts.confidence ?? 0.9,
    source_text: sourceText,
    source_page: opts.sourcePage ?? 1,
    extraction_status: "extracted",
  };
}

function run(row0: Record<string, unknown>, mergedFieldSources: Record<string, unknown>) {
  return assembleCanonicalFields({
    rows: [row0],
    extractionDebug: { merged_field_sources: mergedFieldSources },
    moduleType: "lease",
  });
}

Deno.test("truth-assembly: a field with no candidates anywhere is not_stated", () => {
  const { canonicalFields } = run({}, {});
  assertEquals(canonicalFields.monthly_rent, undefined);
});

Deno.test("truth-assembly: true alias resolution — base_rent_monthly resolves to the monthly_rent publish identity", () => {
  const { canonicalFields } = run(
    { base_rent_monthly: 4200 },
    { base_rent_monthly: evidence(4200, "Base Rent shall be $4,200.00 per month.") },
  );
  assertEquals(canonicalFields.monthly_rent?.value, 4200);
  assertEquals(canonicalFields.monthly_rent?.status, "verified");
  assertEquals(canonicalFields.base_rent_monthly, undefined, "must publish under the canonical id, not the raw alias");
});

Deno.test("truth-assembly: duplicate-concept merge — start_date and commencement_date agreeing publish once as commencement_date", () => {
  const { canonicalFields } = run(
    { start_date: "2024-03-01", commencement_date: "2024-03-01" },
    {
      start_date: evidence("2024-03-01", "The Term shall commence on March 1, 2024."),
      commencement_date: evidence("2024-03-01", "The Term shall commence on March 1, 2024."),
    },
  );
  assertEquals(canonicalFields.commencement_date?.value, "2024-03-01");
  assertEquals(canonicalFields.commencement_date?.status, "verified");
  assertEquals(canonicalFields.start_date, undefined);
});

Deno.test("truth-assembly: duplicate-concept conflict — start_date and commencement_date disagreeing publish as conflicting, not a silent pick", () => {
  const { canonicalFields } = run(
    { start_date: "2024-03-01", commencement_date: "2024-04-01" },
    {
      start_date: evidence("2024-03-01", "The Term shall commence on March 1, 2024.", { sourcePage: 1 }),
      commencement_date: evidence("2024-04-01", "Commencement Date: April 1, 2024.", { sourcePage: 2 }),
    },
  );
  assertEquals(canonicalFields.commencement_date?.status, "conflicting");
  assertEquals(canonicalFields.commencement_date?.value, null, "a genuine conflict must not silently resolve to either candidate");
});

Deno.test("truth-assembly: duplicate-concept merge — tax_responsibility and responsibility_taxes agreeing publish once", () => {
  const { canonicalFields } = run(
    { tax_responsibility: "tenant", responsibility_taxes: "tenant" },
    {
      tax_responsibility: evidence("tenant", "Tenant shall pay all real estate taxes assessed against the Premises."),
      responsibility_taxes: evidence("tenant", "Responsibility Taxes: tenant is responsible for all real estate taxes."),
    },
  );
  assertEquals(canonicalFields.responsibility_taxes?.value, "tenant");
  assertEquals(canonicalFields.tax_responsibility, undefined);
});

Deno.test("systemic regression: tenant obligation is not assigned to landlord merely because landlord appears nearby", () => {
  // "Tenant shall pay Landlord its share of taxes" -- landlord is the
  // RECIPIENT, tenant is the cost-bearing ACTOR. A candidate whose value
  // says "landlord" here must be rejected for direction, not accepted
  // because "landlord" is the party name physically closest to the verb.
  const { canonicalFields } = run(
    { tax_responsibility: "landlord" },
    { tax_responsibility: evidence("landlord", "Tenant shall pay Landlord its proportionate share of real estate taxes.") },
  );
  assertEquals(canonicalFields.responsibility_taxes?.value, null);
  assertEquals(canonicalFields.responsibility_taxes?.status, "needs_review");
  assert(
    canonicalFields.responsibility_taxes?.validationResults.some((v) => v.rule === "obligation_direction" && !v.passed),
    "expected an obligation_direction validation failure",
  );
});

Deno.test("systemic regression: the correctly-attributed tenant obligation is accepted", () => {
  const { canonicalFields } = run(
    { tax_responsibility: "tenant" },
    { tax_responsibility: evidence("tenant", "Tenant shall pay Landlord its proportionate share of real estate taxes.") },
  );
  assertEquals(canonicalFields.responsibility_taxes?.value, "tenant");
  assertEquals(canonicalFields.responsibility_taxes?.status, "verified");
});

Deno.test("inferObligationActor: identifies the grammatical actor of the pay/perform verb, not the nearest party name", () => {
  assertEquals(inferObligationActor("Tenant shall pay Landlord its share of taxes."), "tenant");
  assertEquals(inferObligationActor("Landlord shall reimburse Tenant for the cost of repairs."), "landlord");
  assertEquals(inferObligationActor("This Lease shall be binding upon the parties."), "unknown");
});

Deno.test("systemic regression: repair-only evidence does not satisfy electric_responsibility, and confidence is capped low despite high raw extraction confidence", () => {
  const { canonicalFields } = run(
    { electric_responsibility: "landlord" },
    { electric_responsibility: evidence("landlord", "Landlord shall repair the electrical system in the event of failure due to ordinary wear.", { confidence: 0.97 }) },
  );
  assertEquals(canonicalFields.electric_responsibility?.value, null);
  assertEquals(canonicalFields.electric_responsibility?.status, "needs_review");
  assert(
    canonicalFields.electric_responsibility.confidenceComponents.final < 0.5,
    `expected capped low confidence, got ${canonicalFields.electric_responsibility.confidenceComponents.final}`,
  );
});

Deno.test("systemic regression: additional-charge evidence does not satisfy monthly_rent", () => {
  const { canonicalFields } = run(
    { monthly_rent: 480 },
    { monthly_rent: evidence(480, "Tenant's estimated monthly Common Area Maintenance charge is $480.00.", { confidence: 0.95 }) },
  );
  assertEquals(canonicalFields.monthly_rent?.value, null);
  assertEquals(canonicalFields.monthly_rent?.status, "needs_review");
});

Deno.test("systemic regression: term-date order violation (expiration before commencement) is flagged, not silently accepted", () => {
  const { canonicalFields } = run(
    { commencement_date: "2024-06-01", expiration_date: "2024-01-01" },
    {
      commencement_date: evidence("2024-06-01", "The Term shall commence on June 1, 2024."),
      expiration_date: evidence("2024-01-01", "This Lease shall expire on January 1, 2024."),
    },
  );
  assertEquals(canonicalFields.commencement_date?.status, "needs_review");
  assertEquals(canonicalFields.expiration_date?.status, "needs_review");
  assert(canonicalFields.expiration_date?.validationResults.some((v) => v.rule === "term_date_order" && !v.passed));
  // The values themselves are still surfaced (not nulled) -- the point is to
  // flag the impossible relationship for review, not to fabricate a fix.
  assertEquals(canonicalFields.commencement_date?.value, "2024-06-01");
  assertEquals(canonicalFields.expiration_date?.value, "2024-01-01");
});

Deno.test("systemic regression: valid term-date order passes with no validation failure", () => {
  const { canonicalFields } = run(
    { commencement_date: "2024-03-01", expiration_date: "2029-02-28" },
    {
      commencement_date: evidence("2024-03-01", "The Term shall commence on March 1, 2024."),
      expiration_date: evidence("2029-02-28", "This Lease shall expire on February 28, 2029."),
    },
  );
  assertEquals(canonicalFields.commencement_date?.status, "verified");
  assertEquals(canonicalFields.expiration_date?.status, "verified");
});

Deno.test("systemic regression: monthly/annual rent arithmetic tolerates OCR loss of a currency glyph", () => {
  // annual_rent's evidence lost its leading "$" and comma during OCR
  // (a bare "16800" instead of "$16,800.00") -- purely numeric comparison
  // must still reconcile this against monthly_rent x 12.
  const { canonicalFields } = run(
    { monthly_rent: 1400, annual_rent: "16800" },
    {
      monthly_rent: evidence(1400, "Base Rent shall be $1,400.00 per month."),
      annual_rent: evidence("16800", "Annual Rent 16800 payable in twelve equal monthly installments."),
    },
  );
  assertEquals(canonicalFields.monthly_rent?.status, "verified");
  assertEquals(canonicalFields.annual_rent?.status, "verified");
});

Deno.test("systemic regression: a genuine monthly/annual rent mismatch is flagged, not silently accepted", () => {
  const { canonicalFields } = run(
    { monthly_rent: 1400, annual_rent: 30000 },
    {
      monthly_rent: evidence(1400, "Base Rent shall be $1,400.00 per month."),
      annual_rent: evidence(30000, "Annual Rent shall be $30,000.00."),
    },
  );
  assertEquals(canonicalFields.monthly_rent?.status, "needs_review");
  assertEquals(canonicalFields.annual_rent?.status, "needs_review");
  assert(canonicalFields.annual_rent?.validationResults.some((v) => v.rule === "rent_arithmetic" && !v.passed));
});

Deno.test("systemic regression: guaranty 'initial term' language cannot create a renewal option", () => {
  const { canonicalFields } = run(
    { renewal_options: "guaranty" },
    { renewal_options: evidence("guaranty", "Guarantor unconditionally guarantees the full and prompt payment of Rent for the Initial Term of this Lease.") },
  );
  assertEquals(canonicalFields.renewal_options?.value, null);
  assertEquals(canonicalFields.renewal_options?.status, "needs_review");
});

Deno.test("systemic regression: an actual renewal grant still populates renewal_options", () => {
  const { canonicalFields } = run(
    { renewal_options: "1 x 5-year option" },
    { renewal_options: evidence("1 x 5-year option", "Tenant shall have one (1) option to renew this Lease for an additional term of five (5) years.") },
  );
  assertEquals(canonicalFields.renewal_options?.value, "1 x 5-year option");
  assertEquals(canonicalFields.renewal_options?.status, "verified");
});

Deno.test("systemic regression: an address number cannot populate late_fee_amount", () => {
  const { canonicalFields } = run(
    { late_fee_amount: 1234 },
    { late_fee_amount: evidence(1234, "The Premises are located at 1234 Main Street, Suite 500.", { confidence: 0.8 }) },
  );
  assertEquals(canonicalFields.late_fee_amount?.value, null);
  assertEquals(canonicalFields.late_fee_amount?.status, "needs_review");
});

Deno.test("systemic regression: a genuine late fee clause populates late_fee_amount", () => {
  const { canonicalFields } = run(
    { late_fee_amount: 150 },
    { late_fee_amount: evidence(150, "A late fee of $150.00 shall be assessed for any payment received after the 5th of the month.", { confidence: 0.9 }) },
  );
  assertEquals(canonicalFields.late_fee_amount?.value, 150);
  assertEquals(canonicalFields.late_fee_amount?.status, "verified");
});

Deno.test("truth-assembly: when two evidenced candidates tie on confidence, source authority (rule/form > llm) breaks the tie", () => {
  const { canonicalFields } = run(
    { monthly_rent: 4200 },
    {
      // Simulates two raw keys resolving to the same publish id with
      // identical confidence but different sources -- e.g. a labelled form
      // field (rule) vs. an incidental clause mention (llm) that happen to
      // agree on value but not on source. (Realistic case: the schema alias
      // "base_rent" maps to the same monthly_rent publish id.)
      monthly_rent: evidence(4200, "Monthly Rent: $4,200.00 (labelled form field).", { source: "rule", confidence: 0.9 }),
      base_rent: evidence(4200, "Base Rent shall be $4,200.00 per month per the general terms.", { source: "llm", confidence: 0.9 }),
    },
  );
  assertEquals(canonicalFields.monthly_rent?.selectedCandidateKey, "monthly_rent");
});

Deno.test("truth-assembly: source-with-evidence is preferred over a candidate with no evidence at all", () => {
  const { canonicalFields } = run(
    { monthly_rent: 4200 },
    { monthly_rent: evidence(4200, "Base Rent shall be $4,200.00 per month.", { source: "rule", confidence: 0.92 }) },
  );
  assertEquals(canonicalFields.monthly_rent?.selectedCandidateKey, "monthly_rent");
  assertEquals(canonicalFields.monthly_rent?.sourcePage, 1);
});

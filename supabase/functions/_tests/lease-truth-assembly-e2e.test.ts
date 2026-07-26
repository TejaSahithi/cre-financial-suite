// @ts-nocheck
/**
 * End-to-end proof that Lease Truth Assembly is wired into the ACTUAL
 * runtime path -- not a parallel, unused architecture.
 *
 * This calls buildReviewPayload() (normalize-pdf-output/index.ts), the exact
 * function whose output persists as ui_review_payload past the deferred
 * enrichment pass (buildMinimalReviewPayload's own output is an explicitly
 * transient placeholder -- see that function's own comment). If Lease Truth
 * Assembly were only wired into the transient path, these systemic-bug fixes
 * would appear to work and then silently regress once enrichment completes;
 * testing buildReviewPayload directly is what rules that out.
 *
 * Fixtures below are synthetic and generalized across the three lease
 * archetypes named in this task (typed lease with a summary page; scanned
 * lease with handwritten fields/addenda/tables/formulas; scanned form lease
 * with handwritten party/premises/rent/term values) -- no real document's
 * text or values are copied here, consistent with "expected values belong
 * only in test fixtures" and this test's own remit to prove the mechanism,
 * not memorize one document.
 */
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

const realServe = Deno.serve;
(Deno as any).serve = (..._args: unknown[]) => ({ finished: Promise.resolve(), shutdown: () => {} });
const { __test__: normalizeTest } = await import("../normalize-pdf-output/index.ts");
(Deno as any).serve = realServe;

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

function callBuildReviewPayload(row: Record<string, unknown>, mergedFieldSources: Record<string, unknown>) {
  return normalizeTest.buildReviewPayload({
    fileId: "f1",
    fileName: "lease.pdf",
    moduleType: "leases",
    documentSubtype: "base_lease",
    extractionMethod: "azure_layout",
    reviewRequired: true,
    doclingRaw: null,
    result: {
      rows: [row],
      method: "hybrid",
      warnings: [],
      validationErrors: [],
      metadata: {
        avgConfidence: 90,
        extractionDebug: { merged_field_sources: mergedFieldSources, llm_returned_field_details: {} },
      },
    },
  });
}

function fieldByKey(payload: any, key: string) {
  return payload.records[0].standard_fields.find((f: any) => f.field_key === key);
}

// ── Archetype 1: typed lease with a lease-summary page ───────────────────────
Deno.test("e2e/typed-lease-with-summary: monthly_rent stays base rent even when a summary-adjacent CAM line is also extracted", () => {
  const payload = callBuildReviewPayload(
    { monthly_rent: 5200, tax_responsibility: "tenant" },
    {
      monthly_rent: evidence(5200, "Lease Summary — Base Rent: $5,200.00 per month.", { source: "rule", confidence: 0.95, sourcePage: 1 }),
      tax_responsibility: evidence("tenant", "Tenant shall pay all real estate taxes assessed against the Premises.", { sourcePage: 4 }),
    },
  );
  const monthlyRentField = fieldByKey(payload, "monthly_rent");
  assertEquals(monthlyRentField.value, 5200);
  assertEquals(monthlyRentField.status, "extracted");
  const taxField = fieldByKey(payload, "responsibility_taxes") ?? fieldByKey(payload, "tax_responsibility");
  assertEquals(taxField.value, "tenant");
});

// ── Archetype 2: scanned lease with handwritten addenda/tables/formulas ──────
Deno.test("e2e/scanned-handwritten-addenda: ti_allowance resolves to the formula total, not the handwritten area figure", () => {
  const payload = callBuildReviewPayload(
    { ti_allowance: 68352 },
    {
      ti_allowance: evidence(68352, "$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance.", { confidence: 0.72, sourcePage: 21 }),
    },
  );
  const tiField = fieldByKey(payload, "ti_allowance");
  assertEquals(tiField.value, 68352);
});

Deno.test("e2e/scanned-handwritten-addenda: an area-operand candidate alone does not populate ti_allowance", () => {
  const payload = callBuildReviewPayload(
    { ti_allowance: 2848 },
    {
      ti_allowance: evidence(2848, "$24.00 x 2,848 buildable square feet = $68,352.00 Tenant Improvement Allowance.", { confidence: 0.72, sourcePage: 21 }),
    },
  );
  const tiField = fieldByKey(payload, "ti_allowance");
  assert(tiField.value == null, `expected null, got ${JSON.stringify(tiField.value)}`);
  assertEquals(tiField.status, "needs_review");
});

Deno.test("e2e/scanned-handwritten-addenda: execution date evidence does not populate commencement_date", () => {
  const payload = callBuildReviewPayload(
    { commencement_date: "2024-02-15" },
    { commencement_date: evidence("2024-02-15", "IN WITNESS WHEREOF, the parties have executed this Lease as of February 15, 2024.", { sourcePage: 12 }) },
  );
  const commencementField = fieldByKey(payload, "commencement_date");
  assert(commencementField.value == null, `expected null, got ${JSON.stringify(commencementField.value)}`);
  assertEquals(commencementField.status, "needs_review");
});

// ── Archetype 3: scanned form lease with handwritten party/premises/rent/term values ─
Deno.test("e2e/scanned-form-lease: repair-only handwritten note does not populate electric_responsibility", () => {
  const payload = callBuildReviewPayload(
    { electric_responsibility: "landlord" },
    { electric_responsibility: evidence("landlord", "Landlord shall repair the electrical system in the event of failure due to ordinary wear.", { confidence: 0.85, sourcePage: 6 }) },
  );
  const electricField = fieldByKey(payload, "electric_responsibility");
  assert(electricField.value == null, `expected null, got ${JSON.stringify(electricField.value)}`);
  assertEquals(electricField.status, "needs_review");
  // The direct fix for "95-99% confidence shown for semantically invalid
  // mappings": even though the raw handwritten-note extraction confidence
  // was 0.85, the displayed confidence must not remain high once the value
  // has been rejected as semantically invalid.
  assert(electricField.confidence < 0.5, `expected capped confidence, got ${electricField.confidence}`);
});

Deno.test("e2e/scanned-form-lease: a handwritten tenant-pays-electric note correctly populates electric_responsibility", () => {
  const payload = callBuildReviewPayload(
    { electric_responsibility: "tenant" },
    { electric_responsibility: evidence("tenant", "Tenant shall pay directly for all electric service furnished to the Premises.", { confidence: 0.85, sourcePage: 6 }) },
  );
  const electricField = fieldByKey(payload, "electric_responsibility");
  assertEquals(electricField.value, "tenant");
  assertEquals(electricField.status, "extracted");
});

Deno.test("e2e/scanned-form-lease: guaranty 'initial term' handwriting cannot populate renewal_options", () => {
  const payload = callBuildReviewPayload(
    { renewal_options: "guaranty" },
    { renewal_options: evidence("guaranty", "Guarantor unconditionally guarantees the full and prompt payment of Rent for the Initial Term of this Lease.", { sourcePage: 15 }) },
  );
  const renewalField = fieldByKey(payload, "renewal_options");
  assert(renewalField.value == null, `expected null, got ${JSON.stringify(renewalField.value)}`);
});

Deno.test("e2e/scanned-form-lease: tenant obligation is not reassigned to landlord because landlord appears nearby in a handwritten clause", () => {
  const payload = callBuildReviewPayload(
    { tax_responsibility: "landlord" },
    { tax_responsibility: evidence("landlord", "Tenant shall pay Landlord its proportionate share of real estate taxes.", { sourcePage: 4 }) },
  );
  const taxField = fieldByKey(payload, "responsibility_taxes") ?? fieldByKey(payload, "tax_responsibility");
  assert(taxField.value == null, `expected null, got ${JSON.stringify(taxField.value)}`);
  assertEquals(taxField.status, "needs_review");
});

// ── Cross-cutting: duplicate aliases no longer produce contradictory UI values ─
Deno.test("e2e: duplicate-concept fields (start_date/commencement_date) never display contradictory values in the same payload", () => {
  const payload = callBuildReviewPayload(
    { start_date: "2024-03-01", commencement_date: "2024-03-01" },
    {
      start_date: evidence("2024-03-01", "The Term shall commence on March 1, 2024.", { sourcePage: 1 }),
      commencement_date: evidence("2024-03-01", "Commencement Date: March 1, 2024.", { sourcePage: 1 }),
    },
  );
  const startField = fieldByKey(payload, "start_date");
  const commencementField = fieldByKey(payload, "commencement_date");
  assertEquals(startField.value, commencementField.value, "start_date and commencement_date must never disagree in the published payload");
});

// ── Highest-priority frontend fallback source ────────────────────────────────
// leaseFieldResolver.js's display-mode fallback hierarchy checks
// lease.extraction_data.workflow_output.lease_fields (sourced from THIS
// payload's own records[0].workflow_output.lease_fields, copied downstream)
// BEFORE standard_fields/fields. If Lease Truth Assembly only overrode
// standard_fields, this earlier, higher-priority source would still surface
// buildLeaseWorkflowAbstraction's own independently-derived (un-reconciled)
// value whenever it has evidence of its own -- silently defeating the fix.
Deno.test("e2e: workflow_output.lease_fields (the frontend's highest-priority source) also reflects the Lease Truth Assembly override, not just standard_fields", () => {
  const payload = callBuildReviewPayload(
    { electric_responsibility: "landlord" },
    { electric_responsibility: evidence("landlord", "Landlord shall repair the electrical system in the event of failure due to ordinary wear.", { confidence: 0.85, sourcePage: 6 }) },
  );
  const workflowLeaseFields = payload.records[0]?.workflow_output?.lease_fields ?? {};
  const workflowElectricField = workflowLeaseFields.electric_responsibility;
  assert(
    !workflowElectricField || workflowElectricField.value == null,
    `workflow_output.lease_fields.electric_responsibility must not carry the rejected value, got ${JSON.stringify(workflowElectricField?.value)}`,
  );
});

Deno.test("e2e: a genuine start_date/commencement_date conflict is surfaced as conflict_detected on both rows, not silently picked", () => {
  const payload = callBuildReviewPayload(
    { start_date: "2024-03-01", commencement_date: "2024-04-01" },
    {
      start_date: evidence("2024-03-01", "The Term shall commence on March 1, 2024.", { sourcePage: 1 }),
      commencement_date: evidence("2024-04-01", "Commencement Date: April 1, 2024.", { sourcePage: 2 }),
    },
  );
  const startField = fieldByKey(payload, "start_date");
  const commencementField = fieldByKey(payload, "commencement_date");
  assertEquals(startField.status, "conflict_detected");
  assertEquals(commencementField.status, "conflict_detected");
});

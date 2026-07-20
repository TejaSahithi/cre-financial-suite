import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildFinancialProjection } from "../_shared/extraction/lease-financial-schedule/projection/financial-projection-service.ts";
import { LEASE_FINANCIAL_PROJECTION_VERSION } from "../_shared/extraction/lease-financial-schedule/projection/financial-projection-version.ts";

const completedRun = {
  id: "calc-run-1",
  orgId: "org-1",
  leaseId: "lease-1",
  packageId: "pkg-1",
  calculationRunId: "calc-run-1",
  generationId: "gen-1",
  calculationVersion: "lease-financial-calculation-v1",
  status: "completed",
  inputHash: "a".repeat(64),
};

Deno.test("P4.6 integrated closure: deterministic P4 results project into compatibility fields and shadow diffs only", () => {
  const projection = buildFinancialProjection({
    context: { orgId: "org-1", leaseId: "lease-1", packageId: "pkg-1", generationId: "gen-1", activeGenerationId: "gen-1", mode: "off" },
    calculationRun: completedRun,
    currentFields: {
      commencement_date: { value: "2024-01-15", raw_value: "2024-01-15", raw: "2024-01-15", source_page: 2, page: 2, source_text: "Commencement Date: January 15, 2024", exact_source_text: "Commencement Date: January 15, 2024", snippet: "Commencement Date: January 15, 2024", source_clause: "Commencement Date: January 15, 2024", confidence: 98, confidence_score: 98, extraction_status: "extracted", field_group: "term" },
      annual_rent: { value: "72048.00", raw_value: "72048.00", raw: "72048.00", source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "extracted", field_group: "rent" },
    },
    dateResults: [
      { id: "date-start", conceptKey: "commencement_date", resolutionStatus: "extracted_fixed", resolvedDate: "2024-01-15", sourceClaimIds: ["claim-start"], evidenceSummary: { source_text: "Commencement Date: January 15, 2024", source_page: 2 } },
      { id: "date-end", conceptKey: "expiration_date", resolutionStatus: "calculated", resolvedDate: "2031-03-14", sourceClaimIds: ["claim-term"], formulaKey: "term.duration.inclusive:v1", formulaVersion: "lease-financial-calculation-v1", evidenceSummary: { input_source_text: "86 months after commencement", input_source_page: 4 } },
    ],
    termResults: [
      { id: "term-initial", termType: "initial_term", resolutionStatus: "calculated", resolvedStartDate: "2024-01-15", resolvedEndDate: "2031-03-14", resolvedDurationValue: 86, resolvedDurationUnit: "month", formulaKey: "term.duration.inclusive:v1", formulaVersion: "lease-financial-calculation-v1" },
    ],
    rentResults: [
      { id: "rent-monthly", amountRole: "stated_monthly_rent", statedAmount: "6004.00", validationStatus: "valid", evidenceSummary: { source_text: "$6,004 per month", source_page: 6 } },
      { id: "rent-annualized", amountRole: "annualized_reference", calculatedAmount: "72048.00", resultStatus: "calculated", formulaKey: "rent.annualized.monthly_x_12:v1", formulaVersion: "lease-financial-calculation-v1", validationStatus: "valid" },
      { id: "rent-billed", amountRole: "first_year_billed_rent", calculatedAmount: "60040.00", resultStatus: "calculated", formulaKey: "rent.first_year_billed.free_months:v1", formulaVersion: "lease-financial-calculation-v1", validationCodes: ["RENT_CALC_ANNUALIZED_NOT_BILLED"] },
    ],
    rentPeriods: [
      { id: "free-1", sequenceNumber: 1, startTermMonth: 1, endTermMonth: 2, billingStatus: "fully_abated", amount: "0.00", validationStatus: "valid" },
      { id: "paid-1", sequenceNumber: 2, startTermMonth: 3, endTermMonth: 12, billingStatus: "billed", amount: "6004.00", validationStatus: "valid" },
    ],
    chargeResults: [
      { id: "deposit", chargeRole: "security_deposit", resultStatus: "reconciled", statedAmount: "32500.00", calculatedAmount: "32500.00", formulaKey: "deposit.components.sum:v1", validationStatus: "valid", evidenceSummary: { source_text: "Security Deposit is $32,500", source_page: 9 } },
      { id: "pct", chargeRole: "percentage_rent", resultStatus: "unresolved", formulaKey: "percentage.basis_required:v1", validationStatus: "unresolved", validationCodes: ["PERCENTAGE_FORMULA_INPUT_MISSING"] },
    ],
  });

  assertEquals(projection.run.financialProjectionVersion, LEASE_FINANCIAL_PROJECTION_VERSION);
  assertEquals(projection.run.mode, "off");
  assertEquals(projection.run.status, "completed");
  assertEquals(projection.compatibilitySlice.fields.commencement_date.value, "2024-01-15");
  assertEquals(projection.compatibilitySlice.fields.expiration_date.value, "2031-03-14");
  assertEquals(projection.compatibilitySlice.fields.monthly_rent.value, "6004.00");
  assertEquals(projection.compatibilitySlice.fields.annual_rent.value, "72048.00");
  assertEquals(projection.compatibilitySlice.fields.security_deposit.value, "32500.00");
  assertEquals(projection.compatibilitySlice.fields.first_year_billed_rent, undefined);
  assert(projection.scheduleProjections.some((row) => row.amountRole === "first_year_billed_rent" && row.amount === "60040.00"));
  assert(projection.scheduleProjections.some((row) => row.scheduleType === "free_rent_period"));
  assert(projection.scheduleProjections.some((row) => row.scheduleStatus === "unresolved" && row.formulaKey === "percentage.basis_required:v1"));
  assertEquals(projection.compatibilitySlice.field_evidence.security_deposit.source_text, "Security Deposit is $32,500");
  assert(projection.diffSummary.date_resolved >= 1);
  assertEquals(projection.diffSummary.annualized_vs_billed_corrected, 1);
  assertEquals(projection.diffSummary.free_rent_applied, 1);
});

Deno.test("P4.6 integrated closure: stale or incomplete calculation runs do not project", () => {
  const projection = buildFinancialProjection({
    context: { orgId: "org-1", leaseId: "lease-1", packageId: "pkg-1", generationId: "gen-current", activeGenerationId: "gen-current", mode: "off" },
    calculationRun: { ...completedRun, status: "running", generationId: "gen-old" },
  });
  assert(projection.run.validationCodes.includes("FINANCIAL_PROJECTION_CALCULATION_NOT_COMPLETED"));
  assert(projection.run.validationCodes.includes("FINANCIAL_PROJECTION_CONTEXT_MISMATCH"));
  assert(projection.run.validationCodes.includes("FINANCIAL_PROJECTION_INPUT_STALE"));
  assertEquals(projection.run.status, "needs_review");
});

Deno.test("P4.6 integrated closure: feature mode off has no runtime write-back surface", async () => {
  const projectionFiles: string[] = [];
  for await (const entry of Deno.readDir("supabase/functions/_shared/extraction/lease-financial-schedule/projection")) {
    if (entry.isFile && entry.name.endsWith(".ts")) projectionFiles.push(`supabase/functions/_shared/extraction/lease-financial-schedule/projection/${entry.name}`);
  }
  const combined = (await Promise.all(projectionFiles.map((file) => Deno.readTextFile(file)))).join("\n");
  for (const forbidden of ["finalize_lease_extraction_for_review", "workflow_output", "critical_dates", "review_readiness", "provider", "fetch("]) {
    assertEquals(combined.includes(forbidden), false, forbidden);
  }
});
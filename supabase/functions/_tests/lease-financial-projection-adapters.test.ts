import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { buildCompatibilityExtractionDataSlice } from "../_shared/extraction/claims/adapters/compatibility-payload-builder.ts";
import { buildFinancialCompatibilityCandidate } from "../_shared/extraction/lease-financial-schedule/projection/financial-compatibility-builder.ts";
import { makeFinancialFieldProjection, fieldGroupMap, toCompatibilityFieldProjectionEntries } from "../_shared/extraction/lease-financial-schedule/projection/financial-field-projector.ts";

Deno.test("P4.6 adapters project date and term results into existing compatibility fields with evidence", () => {
  const candidate = buildFinancialCompatibilityCandidate({
    dateResults: [
      { id: "date-start", conceptKey: "commencement_date", resolutionStatus: "extracted_fixed", resolvedDate: "2024-01-15", sourceClaimIds: ["claim-start"], evidenceSummary: { source_text: "Commencement Date: January 15, 2024", source_page: 2 } },
      { id: "date-end", conceptKey: "expiration_date", resolutionStatus: "calculated", resolvedDate: "2031-03-14", sourceClaimIds: ["claim-term"], formulaKey: "term.duration.inclusive:v1", formulaVersion: "lease-financial-calculation-v1", evidenceSummary: { input_source_text: "86 months after commencement", input_source_page: 4 } },
      { id: "date-notice", conceptKey: "option_exercise_deadline", resolutionStatus: "requires_related_document", resolvedDate: null, relatedDocumentRequirementId: "rel-1" },
    ],
    termResults: [
      { id: "term-initial", termType: "initial_term", resolutionStatus: "calculated", resolvedStartDate: "2024-01-15", resolvedEndDate: "2031-03-14", resolvedDurationValue: 86, resolvedDurationUnit: "month", formulaKey: "term.duration.inclusive:v1", validationCodes: [] },
      { id: "term-option", termType: "option_term", instanceKey: "option-1", resolutionStatus: "unresolved", validationCodes: ["TERM_OPTION_NOT_EXERCISED"] },
      { id: "term-holdover", termType: "holdover_term", instanceKey: "holdover", resolutionStatus: "unresolved", validationCodes: ["TERM_HOLDOVER_NOT_CONTRACTUAL_EXTENSION"] },
    ],
  });

  assertEquals(candidate.compatibilitySlice.fields.commencement_date.value, "2024-01-15");
  assertEquals(candidate.compatibilitySlice.fields.expiration_date.value, "2031-03-14");
  assertEquals(candidate.compatibilitySlice.fields.lease_term_months.value, "86");
  assertEquals(candidate.compatibilitySlice.fields.option_exercise_deadline.extraction_status, "requires_related_document");
  assertEquals(candidate.compatibilitySlice.field_evidence.commencement_date.source_text, "Commencement Date: January 15, 2024");
  assert(candidate.fieldProjections.some((row) => row.fieldKey === "option_term.option-1" && row.internalOnly === true));
  assert(candidate.fieldProjections.some((row) => row.fieldKey === "holdover_term.holdover" && row.internalOnly === true));
  assertEquals(Object.keys(candidate.compatibilitySlice.fields).filter((key) => key === "lease_term_months").length, 1);
});

Deno.test("P4.6 adapters keep annualized rent separate from first-year billed rent and preserve free-rent schedules", () => {
  const candidate = buildFinancialCompatibilityCandidate({
    rentResults: [
      { id: "rent-monthly", amountRole: "stated_monthly_rent", statedAmount: "6004.00", validationStatus: "valid", evidenceSummary: { source_text: "$6,004 per month", source_page: 6 } },
      { id: "rent-annualized", amountRole: "annualized_reference", calculatedAmount: "72048.00", resultStatus: "calculated", formulaKey: "rent.annualized.monthly_x_12:v1", formulaVersion: "lease-financial-calculation-v1", validationStatus: "valid" },
      { id: "rent-billed", amountRole: "first_year_billed_rent", calculatedAmount: "60040.00", resultStatus: "calculated", formulaKey: "rent.first_year_billed.free_months:v1", formulaVersion: "lease-financial-calculation-v1", validationCodes: ["RENT_CALC_ANNUALIZED_NOT_BILLED"] },
      { id: "rent-psf", amountRole: "stated_psf_rate", statedAmount: "24.00", validationStatus: "valid" },
    ],
    rentPeriods: [
      { id: "free-1", sequenceNumber: 1, startTermMonth: 1, endTermMonth: 2, billingStatus: "fully_abated", amount: "0.00", validationStatus: "valid" },
      { id: "paid-1", sequenceNumber: 2, startTermMonth: 3, endTermMonth: 12, billingStatus: "billed", amount: "6004.00", validationStatus: "valid" },
    ],
  });

  assertEquals(candidate.compatibilitySlice.fields.monthly_rent.value, "6004.00");
  assertEquals(candidate.compatibilitySlice.fields.annual_rent.value, "72048.00");
  assertEquals(candidate.compatibilitySlice.fields.rent_per_sf.value, "24.00");
  assertEquals(candidate.compatibilitySlice.fields.first_year_billed_rent, undefined);
  assert(candidate.scheduleProjections.some((row) => row.amountRole === "first_year_billed_rent" && row.amount === "60040.00"));
  assert(candidate.scheduleProjections.some((row) => row.scheduleType === "free_rent_period" && row.startTermMonth === 1 && row.endTermMonth === 2));
});

Deno.test("P4.6 adapters project financial charges as distinct fields and schedule records", () => {
  const candidate = buildFinancialCompatibilityCandidate({
    chargeResults: [
      { id: "deposit-total", chargeRole: "security_deposit", resultStatus: "reconciled", statedAmount: "32500.00", calculatedAmount: "32500.00", formulaKey: "deposit.components.sum:v1", validationStatus: "valid", evidenceSummary: { source_text: "Security Deposit is $32,500", source_page: 9 } },
      { id: "ti", chargeRole: "ti_allowance", statedAmount: "150000.00", validationStatus: "valid" },
      { id: "late", chargeRole: "late_fee", statedAmount: "250.00", validationStatus: "valid" },
      { id: "cam-estimate", chargeRole: "cam_estimate", statedAmount: "9800.00", validationStatus: "valid", estimate: true },
      { id: "amort", chargeRole: "amortized_ti_repayment", calculatedAmount: "247.00", formulaKey: "amortization.straight_line:v1", validationStatus: "valid" },
      { id: "pct", chargeRole: "percentage_rent", resultStatus: "unresolved", formulaKey: "percentage.basis_required:v1", validationStatus: "unresolved", validationCodes: ["PERCENTAGE_FORMULA_INPUT_MISSING"] },
    ],
  });

  assertEquals(candidate.compatibilitySlice.fields.security_deposit.value, "32500.00");
  assertEquals(candidate.compatibilitySlice.fields.ti_allowance.value, "150000.00");
  assertEquals(candidate.compatibilitySlice.fields.late_fee_amount.value, "250.00");
  assert(candidate.scheduleProjections.some((row) => row.scheduleType === "deposit_component"));
  assert(candidate.scheduleProjections.some((row) => row.scheduleType === "additional_charge_period" && row.billingStatus === "estimate"));
  assert(candidate.scheduleProjections.some((row) => row.scheduleType === "amortized_charge"));
  assert(candidate.scheduleProjections.some((row) => row.scheduleStatus === "unresolved" && row.formulaKey === "percentage.basis_required:v1"));
});

Deno.test("P4.6 reuses the P2 compatibility payload primitive exactly for field entries", () => {
  const projected = makeFinancialFieldProjection({
    fieldKey: "security_deposit",
    conceptKey: "security_deposit",
    projectionStatus: "available",
    valueOrigin: "extracted",
    normalizedValue: "32500.00",
    displayValue: "$32,500.00",
    sourceClaimId: "claim-deposit",
    confidence: 97,
    evidenceSummary: { source_text: "Security Deposit is $32,500", source_page: 9 },
  });
  const entries = toCompatibilityFieldProjectionEntries([projected]);
  const p2Slice = buildCompatibilityExtractionDataSlice(entries, fieldGroupMap());
  const p4Slice = buildFinancialCompatibilityCandidate({ extraFieldProjections: [projected] }).compatibilitySlice;
  assertEquals(p4Slice, p2Slice);
});
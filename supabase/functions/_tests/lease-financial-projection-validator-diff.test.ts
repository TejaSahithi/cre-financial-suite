import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { makeFinancialFieldProjection } from "../_shared/extraction/lease-financial-schedule/projection/financial-field-projector.ts";
import { buildFinancialProjectionInputHash, buildFinancialProjectionRunIdentity } from "../_shared/extraction/lease-financial-schedule/projection/financial-projection-key.ts";
import { diffFinancialCompatibility, shouldStoreDetailedDiffArtifact, summarizeFinancialDiff } from "../_shared/extraction/lease-financial-schedule/projection/financial-projection-diff.ts";
import { FINANCIAL_PROJECTION_ERRORS, validateFinancialProjectionRows, validateProjectionRunInput } from "../_shared/extraction/lease-financial-schedule/projection/financial-projection-validator.ts";

Deno.test("P4.6 validator rejects incomplete, stale, cross-context and cross-package calculation inputs", () => {
  const context = { orgId: "org-a", leaseId: "lease-a", packageId: "pkg-a", generationId: "gen-a", activeGenerationId: "gen-a" };
  assertEquals(validateProjectionRunInput(context, { orgId: "org-a", leaseId: "lease-a", packageId: "pkg-a", calculationRunId: "calc-a", generationId: "gen-a", calculationVersion: "lease-financial-calculation-v1", status: "running", inputHash: "h" }), [FINANCIAL_PROJECTION_ERRORS.CALCULATION_NOT_COMPLETED]);
  assert(validateProjectionRunInput(context, { orgId: "org-b", leaseId: "lease-a", packageId: "pkg-a", calculationRunId: "calc-a", generationId: "gen-a", calculationVersion: "lease-financial-calculation-v1", status: "completed", inputHash: "h" }).includes(FINANCIAL_PROJECTION_ERRORS.CONTEXT_MISMATCH));
  assert(validateProjectionRunInput(context, { orgId: "org-a", leaseId: "lease-a", packageId: "pkg-b", calculationRunId: "calc-a", generationId: "gen-a", calculationVersion: "lease-financial-calculation-v1", status: "completed", inputHash: "h" }).includes(FINANCIAL_PROJECTION_ERRORS.CONTEXT_MISMATCH));
  assert(validateProjectionRunInput(context, { orgId: "org-a", leaseId: "lease-a", packageId: "pkg-a", calculationRunId: "calc-a", generationId: "gen-old", calculationVersion: "lease-financial-calculation-v1", status: "completed", inputHash: "h" }).includes(FINANCIAL_PROJECTION_ERRORS.INPUT_STALE));
});

Deno.test("P4.6 validator blocks conflicts, unresolved values, missing formula provenance, duplicates and rent role conflation", () => {
  const duplicate = makeFinancialFieldProjection({ fieldKey: "monthly_rent", conceptKey: "monthly_rent", projectionStatus: "available", valueOrigin: "extracted", normalizedValue: "6004.00" });
  const errors = validateFinancialProjectionRows([
    duplicate,
    { ...duplicate, sourceCalculationResultId: "other" },
    makeFinancialFieldProjection({ fieldKey: "security_deposit", conceptKey: "security_deposit", projectionStatus: "available", valueOrigin: "stated_calculated_mismatch", normalizedValue: "32500.00", conflictId: "conflict-1" }),
    makeFinancialFieldProjection({ fieldKey: "rent_per_sf", conceptKey: "rent_per_sf", projectionStatus: "unresolved", valueOrigin: "unresolved", normalizedValue: "24.00" }),
    makeFinancialFieldProjection({ fieldKey: "expiration_date", conceptKey: "expiration_date", projectionStatus: "available", valueOrigin: "calculated", normalizedValue: "2031-03-14" }),
    makeFinancialFieldProjection({ fieldKey: "annual_rent", conceptKey: "annual_rent", projectionStatus: "available", valueOrigin: "calculated", normalizedValue: "60040.00", amountRole: "first_year_billed_rent", formulaKey: "rent.first_year_billed.free_months:v1" }),
    makeFinancialFieldProjection({ fieldKey: "option_exercise_deadline", conceptKey: "option_exercise_deadline", projectionStatus: "requires_related_document", valueOrigin: "requires_related_document" }),
  ], [
    { scheduleType: "base_rent_period", scheduleKey: "a", scheduleStatus: "available", startDate: "2024-01-01", endDate: "2024-03-31", amountRole: "monthly", amount: "6004.00", valueOrigin: "extracted", validationCodes: [] },
    { scheduleType: "base_rent_period", scheduleKey: "b", scheduleStatus: "available", startDate: "2024-03-01", endDate: "2024-04-30", amountRole: "monthly", amount: "6004.00", valueOrigin: "extracted", validationCodes: [] },
    { scheduleType: "annualized_reference", scheduleKey: "c", scheduleStatus: "available", amountRole: "first_year_billed_rent", amount: "60040.00", valueOrigin: "calculated", validationCodes: [] },
    { scheduleType: "base_rent_period", scheduleKey: "d", scheduleStatus: "available", amountRole: "monthly", amount: "1.00", valueOrigin: "calculated", conflictId: "schedule-conflict", validationCodes: [] },
  ]);

  for (const expected of [
    FINANCIAL_PROJECTION_ERRORS.DUPLICATE_FIELD,
    FINANCIAL_PROJECTION_ERRORS.CONFLICT_STATUS_MISMATCH,
    FINANCIAL_PROJECTION_ERRORS.UNRESOLVED_VALUE_PRESENT,
    FINANCIAL_PROJECTION_ERRORS.FORMULA_PROVENANCE_MISSING,
    FINANCIAL_PROJECTION_ERRORS.STATED_CALCULATED_MISMATCH,
    FINANCIAL_PROJECTION_ERRORS.RENT_ROLE_CONFLATION,
    FINANCIAL_PROJECTION_ERRORS.RELATED_DOCUMENT_LINK_MISSING,
  ]) assert(errors.includes(expected));
});

Deno.test("P4.6 diff classifies resolved dates, added calculations, billed-vs-annualized, free rent and unresolved formulas", () => {
  const fields = [
    makeFinancialFieldProjection({ fieldKey: "expiration_date", conceptKey: "expiration_date", projectionStatus: "available", valueOrigin: "calculated", normalizedValue: "2031-03-14", formulaKey: "term.duration.inclusive:v1" }),
    makeFinancialFieldProjection({ fieldKey: "security_deposit", conceptKey: "security_deposit", projectionStatus: "needs_review", valueOrigin: "stated_calculated_mismatch", normalizedValue: null, conflictId: "deposit-conflict" }),
    makeFinancialFieldProjection({ fieldKey: "option_exercise_deadline", conceptKey: "option_exercise_deadline", projectionStatus: "requires_related_document", valueOrigin: "requires_related_document", relatedDocumentRequirementId: "rel-1" }),
    makeFinancialFieldProjection({ fieldKey: "late_fee_amount", conceptKey: "late_fee_amount", projectionStatus: "unresolved", valueOrigin: "unresolved", formulaKey: "percentage.basis_required:v1" }),
  ];
  const diffs = diffFinancialCompatibility({
    currentFields: { annual_rent: { value: "72048.00", raw_value: "72048.00", raw: "72048.00", source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "extracted", field_group: "rent" } },
    p4Fields: {
      expiration_date: { value: "2031-03-14", raw_value: "2031-03-14", raw: "2031-03-14", source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "calculated", field_group: "term" },
      security_deposit: { value: null, raw_value: null, raw: null, source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "conflict_detected", field_group: "rent" },
      option_exercise_deadline: { value: null, raw_value: null, raw: null, source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: "requires_related_document", field_group: "options" },
      late_fee_amount: { value: null, raw_value: null, raw: null, source_page: null, page: null, source_text: null, exact_source_text: null, snippet: null, source_clause: null, confidence: null, confidence_score: null, extraction_status: null, field_group: "rent" },
    },
    fieldProjections: fields,
    scheduleProjections: [
      { scheduleType: "base_rent_period", scheduleKey: "billed", scheduleStatus: "available", amountRole: "first_year_billed_rent", amount: "60040.00", valueOrigin: "calculated", validationCodes: [] },
      { scheduleType: "free_rent_period", scheduleKey: "free-1", scheduleStatus: "available", startTermMonth: 1, endTermMonth: 2, amount: "0.00", valueOrigin: "calculated", validationCodes: [] },
      { scheduleType: "additional_charge_period", scheduleKey: "pct", scheduleStatus: "unresolved", formulaKey: "percentage.basis_required:v1", valueOrigin: "unresolved", validationCodes: [] },
    ],
  });
  const classes = new Set(diffs.map((row) => row.classification));
  for (const expected of ["date_resolved", "stated_calculated_mismatch", "related_document_required", "formula_unresolved", "annualized_vs_billed_corrected", "free_rent_applied"] as const) assert(classes.has(expected), expected);
  assertEquals(summarizeFinancialDiff(diffs).free_rent_applied, 1);

  const ordered = diffFinancialCompatibility({
    currentFields: { b: { value: "2" } as any, a: { value: "1" } as any },
    p4Fields: { a: { value: "1" } as any, b: { value: "2" } as any },
  });
  assert(ordered.some((row) => row.classification === "ordering_mismatch"));
});

Deno.test("P4.6 projection run hashes are reproducible regardless of object key and array order", () => {
  const a = buildFinancialProjectionInputHash({ rows: [{ b: 2, a: 1 }, { id: "z" }], inputIds: ["b", "a"] });
  const b = buildFinancialProjectionInputHash({ inputIds: ["a", "b"], rows: [{ id: "z" }, { a: 1, b: 2 }] });
  assertEquals(a, b);
  assertEquals(buildFinancialProjectionRunIdentity({ orgId: "org", calculationRunId: "calc", generationId: "gen", inputHash: a }), buildFinancialProjectionRunIdentity({ generationId: "gen", calculationRunId: "calc", orgId: "org", inputHash: a }));
  assertEquals(shouldStoreDetailedDiffArtifact(Array.from({ length: 101 }, (_, index) => ({ fieldKey: `f-${index}`, classification: "extra_in_p4_projection" as const })) as any), true);
});
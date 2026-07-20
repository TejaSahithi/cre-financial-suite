// @ts-nocheck
import type { FinancialFieldProjection, FinancialProjectionContext, FinancialProjectionRunInput, FinancialScheduleProjection } from "./financial-projection-types.ts";

const SINGLE_CARDINALITY_COMPAT_FIELDS = new Set(["lease_date", "start_date", "end_date", "commencement_date", "expiration_date", "rent_commencement_date", "monthly_rent", "annual_rent", "rent_per_sf", "security_deposit", "ti_allowance", "lease_term_months"]);

export const FINANCIAL_PROJECTION_ERRORS = {
  CALCULATION_NOT_COMPLETED: "FINANCIAL_PROJECTION_CALCULATION_NOT_COMPLETED",
  INPUT_STALE: "FINANCIAL_PROJECTION_INPUT_STALE",
  CONTEXT_MISMATCH: "FINANCIAL_PROJECTION_CONTEXT_MISMATCH",
  CONFLICT_STATUS_MISMATCH: "FINANCIAL_PROJECTION_CONFLICT_STATUS_MISMATCH",
  UNRESOLVED_VALUE_PRESENT: "FINANCIAL_PROJECTION_UNRESOLVED_VALUE_PRESENT",
  FORMULA_PROVENANCE_MISSING: "FINANCIAL_PROJECTION_FORMULA_PROVENANCE_MISSING",
  STATED_CALCULATED_MISMATCH: "FINANCIAL_PROJECTION_STATED_CALCULATED_MISMATCH",
  DUPLICATE_FIELD: "FINANCIAL_PROJECTION_DUPLICATE_FIELD",
  RENT_ROLE_CONFLATION: "FINANCIAL_PROJECTION_RENT_ROLE_CONFLATION",
  RELATED_DOCUMENT_LINK_MISSING: "FINANCIAL_PROJECTION_RELATED_DOCUMENT_LINK_MISSING",
  COMPATIBILITY_BUILD_FAILED: "FINANCIAL_PROJECTION_COMPATIBILITY_BUILD_FAILED",
} as const;

export function validateProjectionRunInput(context: FinancialProjectionContext, run: FinancialProjectionRunInput): string[] {
  const errors: string[] = [];
  if (!["completed", "completed_with_warnings"].includes(run.status)) errors.push(FINANCIAL_PROJECTION_ERRORS.CALCULATION_NOT_COMPLETED);
  if (run.orgId !== context.orgId || run.generationId !== context.generationId) errors.push(FINANCIAL_PROJECTION_ERRORS.CONTEXT_MISMATCH);
  if (context.packageId && run.packageId && context.packageId !== run.packageId) errors.push(FINANCIAL_PROJECTION_ERRORS.CONTEXT_MISMATCH);
  if (context.leaseId && run.leaseId && context.leaseId !== run.leaseId) errors.push(FINANCIAL_PROJECTION_ERRORS.CONTEXT_MISMATCH);
  if (context.activeGenerationId && run.generationId !== context.activeGenerationId) errors.push(FINANCIAL_PROJECTION_ERRORS.INPUT_STALE);
  return [...new Set(errors)];
}

function hasValue(value: unknown) {
  return value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");
}

export function validateFinancialProjectionRows(fields: FinancialFieldProjection[] = [], schedules: FinancialScheduleProjection[] = []): string[] {
  const errors: string[] = [];
  const seenSingle = new Set<string>();
  for (const field of fields) {
    const key = field.compatibilityFieldKey ?? field.fieldKey;
    if (SINGLE_CARDINALITY_COMPAT_FIELDS.has(key) && field.projectionStatus === "available") {
      if (seenSingle.has(key)) errors.push(FINANCIAL_PROJECTION_ERRORS.DUPLICATE_FIELD);
      seenSingle.add(key);
    }
    if (field.conflictId && field.projectionStatus === "available" && hasValue(field.normalizedValue)) errors.push(FINANCIAL_PROJECTION_ERRORS.CONFLICT_STATUS_MISMATCH);
    if ((field.projectionStatus === "unresolved" || field.valueOrigin === "unresolved") && hasValue(field.normalizedValue)) errors.push(FINANCIAL_PROJECTION_ERRORS.UNRESOLVED_VALUE_PRESENT);
    if ((field.valueOrigin === "calculated" || field.valueOrigin === "derived" || field.valueOrigin === "stated_and_validated") && hasValue(field.normalizedValue) && !field.formulaKey) errors.push(FINANCIAL_PROJECTION_ERRORS.FORMULA_PROVENANCE_MISSING);
    if (field.valueOrigin === "stated_calculated_mismatch" && field.projectionStatus === "available") errors.push(FINANCIAL_PROJECTION_ERRORS.STATED_CALCULATED_MISMATCH);
    if ((field.fieldKey === "annual_rent" || field.compatibilityFieldKey === "annual_rent") && field.amountRole === "first_year_billed_rent") errors.push(FINANCIAL_PROJECTION_ERRORS.RENT_ROLE_CONFLATION);
    if (field.projectionStatus === "requires_related_document" && !field.relatedDocumentRequirementId) errors.push(FINANCIAL_PROJECTION_ERRORS.RELATED_DOCUMENT_LINK_MISSING);
  }

  const datedPeriods = schedules.filter((row) => row.startDate && row.endDate && row.scheduleStatus === "available").sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  for (let i = 1; i < datedPeriods.length; i++) {
    if (String(datedPeriods[i].startDate) <= String(datedPeriods[i - 1].endDate)) errors.push(FINANCIAL_PROJECTION_ERRORS.CONFLICT_STATUS_MISMATCH);
  }
  for (const row of schedules) {
    if (row.amountRole === "first_year_billed_rent" && row.scheduleType === "annualized_reference") errors.push(FINANCIAL_PROJECTION_ERRORS.RENT_ROLE_CONFLATION);
    if (row.conflictId && row.scheduleStatus === "available") errors.push(FINANCIAL_PROJECTION_ERRORS.CONFLICT_STATUS_MISMATCH);
  }
  return [...new Set(errors)];
}

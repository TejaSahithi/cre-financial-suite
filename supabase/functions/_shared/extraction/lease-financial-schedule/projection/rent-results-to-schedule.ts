// @ts-nocheck
import { makeFinancialFieldProjection } from "./financial-field-projector.ts";
import { buildProjectedScheduleKey } from "./financial-projection-key.ts";

function statusFor(result: any) {
  if (result.validationStatus === "needs_review" || result.resultStatus === "needs_review") return "needs_review";
  if (result.resultStatus === "unresolved" || result.validationStatus === "unresolved") return "unresolved";
  if (result.validationCodes?.includes("RENT_CALC_PERIOD_OVERLAP")) return "needs_review";
  return "available";
}

function originFor(result: any) {
  if (result.validationCodes?.includes("RENT_CALC_STATED_RESULT_MISMATCH")) return "stated_calculated_mismatch";
  if (result.statedAmount && result.calculatedAmount && result.validationStatus === "valid") return "stated_and_validated";
  if (result.statedAmount && !result.calculatedAmount) return "extracted";
  if (result.resultStatus === "calculated" || result.calculatedAmount) return "calculated";
  return "unresolved";
}

export function rentResultsToFieldProjections(results: any[] = []) {
  const out: any[] = [];
  for (const result of results) {
    const status = statusFor(result);
    const origin = originFor(result);
    const amount = result.calculatedAmount ?? result.statedAmount ?? null;
    const amountRole = result.amountRole ?? result.role ?? null;
    let fieldKey: string | null = null;
    if (amountRole === "stated_monthly_rent" || amountRole === "billed_base_rent" || amountRole === "calculated_monthly_representation") fieldKey = "monthly_rent";
    if (amountRole === "stated_annual_rent" || amountRole === "annualized_reference") fieldKey = "annual_rent";
    if (amountRole === "stated_psf_rate") fieldKey = "rent_per_sf";
    if (!fieldKey) continue;
    out.push(makeFinancialFieldProjection({
      fieldKey,
      conceptKey: fieldKey,
      projectionStatus: status,
      valueOrigin: origin,
      normalizedValue: status === "available" ? amount : null,
      displayValue: status === "available" && amount !== null ? String(amount) : null,
      sourceCalculationResultId: result.id ?? result.rentCalculationResultId ?? null,
      statedSourceResultId: result.statedSourceResultId ?? null,
      calculatedSourceResultId: result.calculatedSourceResultId ?? null,
      validationCodes: result.validationCodes ?? [],
      formulaKey: result.formulaKey ?? null,
      formulaVersion: result.formulaVersion ?? null,
      assumptions: result.assumptions ?? result.provenance?.assumptions ?? {},
      roundingPolicy: result.roundingPolicy ?? result.provenance?.roundingPolicy ?? null,
      amountRole,
      evidenceSummary: result.evidenceSummary ?? { source_input_ids: result.provenance?.sourceInputIds ?? [] },
    }));
  }
  return out;
}

export function rentResultsToScheduleProjections(results: any[] = [], periods: any[] = []) {
  const out: any[] = [];
  for (const period of periods) {
    const scheduleType = period.billingStatus === "fully_abated" || period.abatementStatus === "full" ? "free_rent_period" : "base_rent_period";
    const status = period.validationStatus === "needs_review" ? "needs_review" : period.resolvedStartDate || period.startTermMonth ? "available" : "unresolved";
    out.push({
      scheduleType,
      scheduleKey: period.scheduleKey ?? buildProjectedScheduleKey({ scheduleType, sourceId: period.id ?? period.sourcePeriodCandidateId, sequenceNumber: period.sequenceNumber ?? null, startDate: period.resolvedStartDate ?? null, endDate: period.resolvedEndDate ?? null }),
      scheduleStatus: status,
      sourceScheduleCandidateId: period.sourceScheduleCandidateId ?? null,
      sourceCalculationResultId: period.id ?? period.calculatedPeriodId ?? null,
      sequenceNumber: period.sequenceNumber ?? null,
      startDate: period.resolvedStartDate ?? period.startDate ?? null,
      endDate: period.resolvedEndDate ?? period.endDate ?? null,
      startTermMonth: period.startTermMonth ?? null,
      endTermMonth: period.endTermMonth ?? null,
      amountRole: period.amountRole ?? null,
      amount: period.amount ?? period.calculatedAmount ?? null,
      currencyCode: period.currencyCode ?? "USD",
      frequency: period.frequency ?? "monthly",
      billingStatus: period.billingStatus ?? period.abatementStatus ?? null,
      valueOrigin: period.valueOrigin ?? (scheduleType === "free_rent_period" ? "calculated" : "extracted"),
      formulaKey: period.formulaKey ?? null,
      validationCodes: period.validationCodes ?? [],
      conflictId: period.conflictId ?? null,
    });
  }
  for (const result of results) {
    const amountRole = result.amountRole ?? result.role ?? null;
    if (!amountRole || ["stated_monthly_rent", "stated_annual_rent", "stated_psf_rate"].includes(amountRole)) continue;
    const scheduleType = amountRole === "first_year_billed_rent" ? "base_rent_period" : "base_rent_period";
    out.push({
      scheduleType,
      scheduleKey: buildProjectedScheduleKey({ scheduleType, sourceId: result.id ?? result.rentCalculationResultId, amountRole }),
      scheduleStatus: statusFor(result),
      sourceCalculationResultId: result.id ?? result.rentCalculationResultId ?? null,
      amountRole,
      amount: result.calculatedAmount ?? result.statedAmount ?? null,
      currencyCode: result.currencyCode ?? "USD",
      frequency: result.frequency ?? null,
      billingStatus: amountRole === "first_year_billed_rent" ? "billed" : null,
      valueOrigin: originFor(result),
      formulaKey: result.formulaKey ?? null,
      validationCodes: result.validationCodes ?? [],
      conflictId: result.conflictId ?? null,
    });
  }
  return out.sort((a, b) => (a.sequenceNumber ?? 999999) - (b.sequenceNumber ?? 999999) || a.scheduleKey.localeCompare(b.scheduleKey));
}

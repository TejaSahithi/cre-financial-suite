// @ts-nocheck
import { addDecimal, compareDecimal, divideDecimal, multiplyDecimal, percentToRate, roundMoney, subtractDecimal } from "./decimal-math.ts";
import { inclusiveDays } from "./date-only-math.ts";
import { defaultCalculationProvenance } from "./calculation-types.ts";
import { LEASE_RENT_CALCULATION_ENGINE_VERSION } from "./calculation-version.ts";

const provenance = (inputs: string[], assumptions: Record<string, unknown> = {}) =>
  defaultCalculationProvenance(LEASE_RENT_CALCULATION_ENGINE_VERSION, inputs, [], assumptions);

export function calculateAnnualizedFromMonthly(monthlyAmount: string | number, sourceInputIds: string[] = []) {
  return {
    resultStatus: "calculated",
    amountRole: "annualized_reference",
    calculatedAmount: roundMoney(multiplyDecimal(monthlyAmount, 12)),
    formulaKey: "rent.monthly_to_annualized:v1",
    validationStatus: "valid",
    validationCodes: ["RENT_CALC_ANNUALIZED_NOT_BILLED"],
    provenance: provenance(sourceInputIds),
  };
}

export function calculateMonthlyFromAnnual(annualAmount: string | number, sourceInputIds: string[] = []) {
  return {
    resultStatus: "calculated",
    amountRole: "calculated_monthly_representation",
    calculatedAmount: roundMoney(divideDecimal(annualAmount, 12)),
    formulaKey: "rent.annual_to_monthly_representation:v1",
    validationStatus: "valid",
    validationCodes: [],
    provenance: provenance(sourceInputIds),
  };
}

export function calculatePsfAnnualAmount(rate: string | number, area: string | number | null, rateBasis: string, areaBasis: string, sourceInputIds: string[] = []) {
  if (area === null || area === undefined) {
    return unresolvedRent("RENT_CALC_PSF_AREA_MISSING", sourceInputIds);
  }
  if (rateBasis !== areaBasis) {
    return needsReviewRent("RENT_CALC_PSF_AREA_BASIS_MISMATCH", sourceInputIds);
  }
  return {
    resultStatus: "calculated",
    amountRole: "annualized_reference",
    calculatedAmount: roundMoney(multiplyDecimal(rate, area)),
    formulaKey: "rent.psf_annual_rate_times_area:v1",
    validationStatus: "valid",
    validationCodes: [],
    provenance: provenance(sourceInputIds, { areaBasis }),
  };
}

export function calculateFirstYearBilledRent(monthlyAmount: string | number, freeMonths: number, billedMonths = 12, sourceInputIds: string[] = []) {
  const payableMonths = Math.max(0, billedMonths - freeMonths);
  return {
    resultStatus: "calculated",
    amountRole: "first_year_billed_rent",
    calculatedAmount: roundMoney(multiplyDecimal(monthlyAmount, payableMonths)),
    formulaKey: "rent.first_year_billed_from_billed_months:v1",
    validationStatus: "valid",
    validationCodes: freeMonths > 0 ? ["RENT_CALC_ANNUALIZED_NOT_BILLED"] : [],
    provenance: provenance(sourceInputIds, { freeMonths, billedMonths }),
  };
}

export function calculateFixedAmountEscalation(priorAmount: string | number, increaseAmount: string | number, sourceInputIds: string[] = []) {
  return {
    resultStatus: "calculated",
    calculatedAmount: roundMoney(addDecimal(priorAmount, increaseAmount)),
    formulaKey: "rent.fixed_amount_escalation:v1",
    validationStatus: "valid",
    validationCodes: [],
    provenance: provenance(sourceInputIds),
  };
}

export function calculateFixedPercentageEscalation(priorAmount: string | number, percentage: string | number, sourceInputIds: string[] = []) {
  return {
    resultStatus: "calculated",
    calculatedAmount: roundMoney(multiplyDecimal(priorAmount, addDecimal(1, percentToRate(percentage)))),
    formulaKey: "rent.fixed_percentage_escalation:v1",
    validationStatus: "valid",
    validationCodes: [],
    provenance: provenance(sourceInputIds),
  };
}

export function calculatePartialPeriodRent(monthlyAmount: string | number, periodStart: string, periodEnd: string, fullPeriodStart: string, fullPeriodEnd: string, prorationRule?: string, sourceInputIds: string[] = []) {
  if (!prorationRule) return unresolvedRent("RENT_CALC_PRORATION_RULE_MISSING", sourceInputIds);
  const partialDays = inclusiveDays(periodStart, periodEnd);
  const fullDays = inclusiveDays(fullPeriodStart, fullPeriodEnd);
  return {
    resultStatus: "calculated",
    calculatedAmount: roundMoney(multiplyDecimal(monthlyAmount, divideDecimal(partialDays, fullDays))),
    formulaKey: `rent.partial_period.${prorationRule}:v1`,
    validationStatus: "valid",
    validationCodes: [],
    provenance: provenance(sourceInputIds, { prorationRule, partialDays, fullDays }),
  };
}

export function validateStatedVariance(stated: string | number, calculated: string | number, tolerance = "0.01") {
  const variance = subtractDecimal(calculated, stated);
  const absVariance = variance.scaled < 0n ? { scaled: -variance.scaled } : variance;
  const mismatch = compareDecimal(absVariance, tolerance) > 0;
  return {
    validationStatus: mismatch ? "needs_review" : "valid",
    validationCodes: mismatch ? ["RENT_CALC_STATED_RESULT_MISMATCH"] : [],
    varianceAmount: roundMoney(variance),
    statedAmount: roundMoney(stated),
    calculatedAmount: roundMoney(calculated),
  };
}

export function validatePeriods(periods: Array<{ id: string; startDate?: string | null; endDate?: string | null }>) {
  const sorted = [...periods].filter((period) => period.startDate && period.endDate).sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)));
  const codes: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (String(sorted[i].startDate) <= String(sorted[i - 1].endDate)) codes.push("RENT_CALC_PERIOD_OVERLAP");
  }
  return { validationStatus: codes.includes("RENT_CALC_PERIOD_OVERLAP") ? "needs_review" : "valid", validationCodes: [...new Set(codes)] };
}

export function unresolvedRent(code: string, sourceInputIds: string[] = []) {
  return { resultStatus: "unresolved", calculatedAmount: null, formulaKey: null, validationStatus: "unresolved", validationCodes: [code], provenance: provenance(sourceInputIds) };
}

export function needsReviewRent(code: string, sourceInputIds: string[] = []) {
  return { resultStatus: "needs_review", calculatedAmount: null, formulaKey: null, validationStatus: "needs_review", validationCodes: [code], provenance: provenance(sourceInputIds) };
}

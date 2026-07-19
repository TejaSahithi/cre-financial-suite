// @ts-nocheck
import { compareDecimal, decimal, DECIMAL_FACTOR, divideDecimal, percentToRate, roundMoney, roundScaled, subtractDecimal, toDecimalString } from "./decimal-math.ts";
import { defaultCalculationProvenance } from "./calculation-types.ts";
import { LEASE_CHARGE_CALCULATION_ENGINE_VERSION } from "./calculation-version.ts";

const provenance = (inputs: string[], assumptions: Record<string, unknown> = {}) =>
  defaultCalculationProvenance(LEASE_CHARGE_CALCULATION_ENGINE_VERSION, inputs, [], assumptions);

export function calculateStraightLineAmortization(input: { principal?: string | number | null; numberOfPeriods?: number | null; statedPayment?: string | number | null; sourceInputIds?: string[] }) {
  const sourceInputIds = input.sourceInputIds ?? [];
  if (input.principal === null || input.principal === undefined || !input.numberOfPeriods) {
    return unresolved("AMORTIZATION_INPUT_MISSING", sourceInputIds);
  }
  const payment = divideDecimal(input.principal, input.numberOfPeriods);
  const variance = input.statedPayment === null || input.statedPayment === undefined ? null : subtractDecimal(payment, input.statedPayment);
  return {
    resultStatus: "calculated",
    calculatedPayment: roundMoney(payment),
    statedPayment: input.statedPayment === null || input.statedPayment === undefined ? null : roundMoney(input.statedPayment),
    varianceAmount: variance ? roundMoney(variance) : null,
    formulaKey: "amortization.straight_line_principal_over_periods:v1",
    validationStatus: variance && compareDecimal(variance.scaled < 0n ? { scaled: -variance.scaled } : variance, "0.01") > 0 ? "needs_review" : "valid",
    validationCodes: variance && compareDecimal(variance.scaled < 0n ? { scaled: -variance.scaled } : variance, "0.01") > 0 ? ["AMORTIZATION_STATED_RESULT_MISMATCH"] : [],
    provenance: provenance(sourceInputIds),
  };
}

export function calculateInterestBearingPayment(input: { principal?: string | number | null; annualRatePercent?: string | number | null; periods?: number | null; paymentsPerYear?: number | null; compounding?: "monthly" | "annually" | null; statedPayment?: string | number | null; sourceInputIds?: string[] }) {
  const sourceInputIds = input.sourceInputIds ?? [];
  if (input.principal === null || input.principal === undefined || input.annualRatePercent === null || input.annualRatePercent === undefined || !input.periods || !input.paymentsPerYear || !input.compounding) {
    return unresolved("AMORTIZATION_ASSUMPTION_MISSING", sourceInputIds);
  }
  const periodicRate = divideDecimal(percentToRate(input.annualRatePercent), input.paymentsPerYear);
  if (compareDecimal(periodicRate, 0) === 0) {
    return unresolved("AMORTIZATION_ZERO_RATE_REQUIRES_EXPLICIT_STRAIGHT_LINE", sourceInputIds);
  }
  const pow = powScaled(addScaled(DECIMAL_FACTOR, periodicRate.scaled), input.periods);
  const principal = decimal(input.principal).scaled;
  const first = roundScaled(principal * periodicRate.scaled, DECIMAL_FACTOR);
  const numerator = roundScaled(first * pow, DECIMAL_FACTOR);
  const denominator = pow - DECIMAL_FACTOR;
  if (denominator <= 0n) return unresolved("AMORTIZATION_ASSUMPTION_MISSING", sourceInputIds);
  const paymentScaled = roundScaled(numerator * DECIMAL_FACTOR, denominator);
  const calculatedPayment = toDecimalString({ scaled: paymentScaled }, 2);
  const variance = input.statedPayment === null || input.statedPayment === undefined ? null : subtractDecimal({ scaled: paymentScaled }, input.statedPayment);
  return {
    resultStatus: "calculated",
    calculatedPayment,
    statedPayment: input.statedPayment === null || input.statedPayment === undefined ? null : roundMoney(input.statedPayment),
    varianceAmount: variance ? roundMoney(variance) : null,
    formulaKey: "amortization.interest_bearing_level_payment:v1",
    validationStatus: variance && compareDecimal(variance.scaled < 0n ? { scaled: -variance.scaled } : variance, "0.01") > 0 ? "needs_review" : "valid",
    validationCodes: variance && compareDecimal(variance.scaled < 0n ? { scaled: -variance.scaled } : variance, "0.01") > 0 ? ["AMORTIZATION_STATED_RESULT_MISMATCH"] : [],
    provenance: provenance(sourceInputIds, { paymentsPerYear: input.paymentsPerYear, compounding: input.compounding, boundedScheduleExpansion: false }),
  };
}

function addScaled(a: bigint, b: bigint): bigint {
  return a + b;
}

function powScaled(baseScaled: bigint, exponent: number): bigint {
  let out = DECIMAL_FACTOR;
  for (let i = 0; i < exponent; i++) {
    out = roundScaled(out * baseScaled, DECIMAL_FACTOR);
  }
  return out;
}

function unresolved(code: string, sourceInputIds: string[]) {
  return { resultStatus: "unresolved", calculatedPayment: null, statedPayment: null, varianceAmount: null, validationStatus: "unresolved", validationCodes: [code], provenance: provenance(sourceInputIds) };
}
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { calculateAnnualizedFromMonthly, calculateFirstYearBilledRent, calculateFixedAmountEscalation, calculateFixedPercentageEscalation, calculatePartialPeriodRent, calculatePsfAnnualAmount, validatePeriods, validateStatedVariance } from "../_shared/extraction/lease-financial-schedule/calculation/rent-calculator.ts";
import { calculateInterestBearingPayment, calculateStraightLineAmortization } from "../_shared/extraction/lease-financial-schedule/calculation/amortization-calculator.ts";
import { evaluateFormula, evaluatePercentageFormula } from "../_shared/extraction/lease-financial-schedule/calculation/charge-formula-evaluator.ts";
import { reconcileDepositComponents } from "../_shared/extraction/lease-financial-schedule/calculation/deposit-reconciler.ts";
import { DECIMAL_CURRENCY_OUTPUT_SCALE, DECIMAL_INPUT_SCALE, DECIMAL_INTERMEDIATE_SCALE, DECIMAL_MAX_ABS_SCALED, DECIMAL_PERCENTAGE_RATE_SCALE, DECIMAL_ROUNDING_MODE, roundMoney } from "../_shared/extraction/lease-financial-schedule/calculation/decimal-math.ts";

Deno.test("P4.5 rent 24-40: annualized stays separate from billed, PSF, escalations, proration and period validation", () => {
  const annualized = calculateAnnualizedFromMonthly("6004", ["amount-monthly"]);
  const billed = calculateFirstYearBilledRent("6004", 2, 12, ["amount-monthly", "free-months"]);
  assertEquals(annualized.calculatedAmount, "72048.00");
  assertEquals(annualized.amountRole, "annualized_reference");
  assertEquals(billed.calculatedAmount, "60040.00");
  assertEquals(billed.amountRole, "first_year_billed_rent");
  assertEquals(billed.validationCodes.includes("RENT_CALC_ANNUALIZED_NOT_BILLED"), true);

  assertEquals(calculatePsfAnnualAmount("24", "3000", "rsf", "rsf").calculatedAmount, "72000.00");
  assertEquals(calculatePsfAnnualAmount("24", null, "rsf", "rsf").validationCodes, ["RENT_CALC_PSF_AREA_MISSING"]);
  assertEquals(calculatePsfAnnualAmount("24", "3000", "rsf", "usable_sf").validationCodes, ["RENT_CALC_PSF_AREA_BASIS_MISMATCH"]);
  assertEquals(calculateFixedAmountEscalation("6004", "100").calculatedAmount, "6104.00");
  assertEquals(calculateFixedPercentageEscalation("6004", "3").calculatedAmount, "6184.12");
  assertEquals(calculatePartialPeriodRent("3000", "2024-02-01", "2024-02-14", "2024-02-01", "2024-02-29").validationCodes, ["RENT_CALC_PRORATION_RULE_MISSING"]);
  assertEquals(calculatePartialPeriodRent("3000", "2024-02-01", "2024-02-14", "2024-02-01", "2024-02-29", "actual_days").calculatedAmount, "1448.28");
  assertEquals(roundMoney("0.1"), "0.10");
  assertEquals(validatePeriods([{ id: "a", startDate: "2024-01-01", endDate: "2024-02-29" }, { id: "b", startDate: "2024-02-15", endDate: "2024-03-31" }]).validationCodes, ["RENT_CALC_PERIOD_OVERLAP"]);
  assertEquals(validateStatedVariance("100.00", "101.50").validationCodes, ["RENT_CALC_STATED_RESULT_MISMATCH"]);
});

Deno.test("P4.5 decimal guardrails: scale, rounding, negative values and overflow are explicit", () => {
  assertEquals(DECIMAL_INPUT_SCALE, 6);
  assertEquals(DECIMAL_INTERMEDIATE_SCALE, 6);
  assertEquals(DECIMAL_CURRENCY_OUTPUT_SCALE, 2);
  assertEquals(DECIMAL_PERCENTAGE_RATE_SCALE, 6);
  assertEquals(DECIMAL_ROUNDING_MODE, "half_up");
  assertEquals(roundMoney("-1.235"), "-1.24");
  assert(DECIMAL_MAX_ABS_SCALED > 0n);
});

Deno.test("P4.5 deposits 41-45: component reconciliation preserves stated total and rejects missing/cross-package components", () => {
  const reconciled = reconcileDepositComponents({ orgId: "org", packageId: "pkg", statedTotal: "15535.36", components: [{ id: "cash", amount: "12908.60", orgId: "org", packageId: "pkg" }, { id: "loc", amount: "2626.76", orgId: "org", packageId: "pkg" }] });
  assertEquals(reconciled.resultStatus, "reconciled");
  assertEquals(reconciled.statedTotal, "15535.36");
  assertEquals(reconciled.calculatedComponentSum, "15535.36");
  const mismatch = reconcileDepositComponents({ statedTotal: "15535.36", components: [{ id: "cash", amount: "100.00" }, { id: "loc", amount: "200.00" }] });
  assertEquals(mismatch.validationCodes, ["DEPOSIT_RECONCILIATION_CONFLICT"]);
  assertEquals(reconcileDepositComponents({ statedTotal: "15535.36", components: [{ id: "cash", amount: null }] }).validationCodes, ["DEPOSIT_COMPONENT_MISSING"]);
  assertEquals(reconcileDepositComponents({ orgId: "org", packageId: "pkg-a", statedTotal: "1", components: [{ id: "x", amount: "1", orgId: "org", packageId: "pkg-b" }] }).validationCodes, ["DEPOSIT_COMPONENT_CROSS_PACKAGE"]);
});

Deno.test("P4.5 amortization 46-53: straight-line works, interest needs complete assumptions, variance preserved and no schedule expansion", () => {
  const straight = calculateStraightLineAmortization({ principal: "12350", numberOfPeriods: 50, statedPayment: "247.00", sourceInputIds: ["principal", "periods"] });
  assertEquals(straight.calculatedPayment, "247.00");
  assertEquals(straight.validationStatus, "valid");
  assertEquals(calculateInterestBearingPayment({ principal: "12350", periods: 60, paymentsPerYear: 12, compounding: "monthly" }).validationCodes, ["AMORTIZATION_ASSUMPTION_MISSING"]);
  assertEquals(calculateInterestBearingPayment({ principal: "12350", annualRatePercent: "5", periods: 60, paymentsPerYear: 12 }).validationCodes, ["AMORTIZATION_ASSUMPTION_MISSING"]);
  const interest = calculateInterestBearingPayment({ principal: "12350", annualRatePercent: "5", periods: 60, paymentsPerYear: 12, compounding: "monthly", statedPayment: "174.55", sourceInputIds: ["principal", "rate", "term", "payment"] });
  assertEquals(interest.resultStatus, "calculated");
  assertEquals(interest.statedPayment, "174.55");
  assertEquals(interest.validationCodes, ["AMORTIZATION_STATED_RESULT_MISMATCH"]);
  assertEquals(interest.provenance.assumptions.boundedScheduleExpansion, false);
});

Deno.test("P4.5 percentage/formulas 54-59,80-89: supplied basis calculates, missing basis and unsupported/CPI/sales stay unresolved without fetch", () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = ((..._args: unknown[]) => { fetchCount++; throw new Error("fetch forbidden"); }) as typeof fetch;
  try {
    assertEquals(evaluatePercentageFormula({ rate: "5", basisAmount: "100000", breakpointAmount: "40000" }).calculatedAmount, "3000.00");
    assertEquals(evaluatePercentageFormula({ rate: "5", basisAmount: null }).validationCodes, ["PERCENTAGE_FORMULA_INPUT_MISSING"]);
    assertEquals(evaluateFormula({ formulaType: "ambiguous_formula", inputs: {} }).validationCodes, ["UNSUPPORTED_CALCULATION_RULE"]);
    assertEquals(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
// @ts-nocheck
import { multiplyDecimal, percentToRate, roundMoney, subtractDecimal } from "./decimal-math.ts";
import { defaultCalculationProvenance } from "./calculation-types.ts";
import { LEASE_CHARGE_CALCULATION_ENGINE_VERSION } from "./calculation-version.ts";

const provenance = (inputs: string[], assumptions: Record<string, unknown> = {}) =>
  defaultCalculationProvenance(LEASE_CHARGE_CALCULATION_ENGINE_VERSION, inputs, [], assumptions);

export function evaluatePercentageFormula(input: { rate?: string | number | null; basisAmount?: string | number | null; breakpointAmount?: string | number | null; sourceInputIds?: string[] }) {
  const sourceInputIds = input.sourceInputIds ?? [];
  if (input.rate === null || input.rate === undefined || input.basisAmount === null || input.basisAmount === undefined) {
    return { resultStatus: "unresolved", calculatedAmount: null, validationStatus: "unresolved", validationCodes: ["PERCENTAGE_FORMULA_INPUT_MISSING"], provenance: provenance(sourceInputIds) };
  }
  const basis = input.breakpointAmount === null || input.breakpointAmount === undefined ? input.basisAmount : subtractDecimal(input.basisAmount, input.breakpointAmount);
  return {
    resultStatus: "calculated",
    calculatedAmount: roundMoney(multiplyDecimal(basis, percentToRate(input.rate))),
    formulaKey: "charge.percentage_rate_times_supplied_basis:v1",
    validationStatus: "valid",
    validationCodes: [],
    provenance: provenance(sourceInputIds, { suppliedBasisOnly: true }),
  };
}

export function evaluateFormula(input: { formulaType: string; inputs: Record<string, string | number | null | undefined>; sourceInputIds?: string[] }) {
  if (input.formulaType === "percentage_rate_times_basis") {
    return evaluatePercentageFormula({ rate: input.inputs.rate, basisAmount: input.inputs.basisAmount, breakpointAmount: input.inputs.breakpointAmount, sourceInputIds: input.sourceInputIds });
  }
  return {
    resultStatus: "needs_review",
    calculatedAmount: null,
    validationStatus: "needs_review",
    validationCodes: ["UNSUPPORTED_CALCULATION_RULE"],
    provenance: provenance(input.sourceInputIds ?? [], { unsupportedFormulaType: input.formulaType }),
  };
}

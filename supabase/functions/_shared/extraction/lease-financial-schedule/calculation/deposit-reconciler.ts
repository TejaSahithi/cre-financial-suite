// @ts-nocheck
import { compareDecimal, roundMoney, subtractDecimal, sumDecimals } from "./decimal-math.ts";
import { defaultCalculationProvenance } from "./calculation-types.ts";
import { LEASE_CHARGE_CALCULATION_ENGINE_VERSION } from "./calculation-version.ts";

export function reconcileDepositComponents(input: { statedTotal?: string | number | null; components: Array<{ id: string; amount?: string | number | null; orgId?: string; packageId?: string | null }>; orgId?: string; packageId?: string | null; sourceInputIds?: string[] }) {
  const sourceInputIds = input.sourceInputIds ?? input.components.map((component) => component.id);
  if (input.components.some((component) => input.orgId && component.orgId && component.orgId !== input.orgId)) {
    return issue("cross_package_component", "DEPOSIT_COMPONENT_CROSS_ORG", sourceInputIds);
  }
  if (input.components.some((component) => input.packageId && component.packageId && component.packageId !== input.packageId)) {
    return issue("cross_package_component", "DEPOSIT_COMPONENT_CROSS_PACKAGE", sourceInputIds);
  }
  if (input.statedTotal === null || input.statedTotal === undefined || input.components.some((component) => component.amount === null || component.amount === undefined)) {
    return issue("incomplete_components", "DEPOSIT_COMPONENT_MISSING", sourceInputIds);
  }
  const calculatedSum = sumDecimals(input.components.map((component) => component.amount));
  const variance = subtractDecimal(calculatedSum, input.statedTotal);
  const reconciled = compareDecimal(variance.scaled < 0n ? { scaled: -variance.scaled } : variance, "0.01") <= 0;
  return {
    resultStatus: reconciled ? "reconciled" : "mismatch",
    statedTotal: roundMoney(input.statedTotal),
    calculatedComponentSum: roundMoney(calculatedSum),
    varianceAmount: roundMoney(variance),
    validationStatus: reconciled ? "valid" : "needs_review",
    validationCodes: reconciled ? [] : ["DEPOSIT_RECONCILIATION_CONFLICT"],
    provenance: defaultCalculationProvenance(LEASE_CHARGE_CALCULATION_ENGINE_VERSION, sourceInputIds),
  };
}

function issue(status: string, code: string, sourceInputIds: string[]) {
  return {
    resultStatus: status,
    statedTotal: null,
    calculatedComponentSum: null,
    varianceAmount: null,
    validationStatus: "needs_review",
    validationCodes: [code],
    provenance: defaultCalculationProvenance(LEASE_CHARGE_CALCULATION_ENGINE_VERSION, sourceInputIds),
  };
}

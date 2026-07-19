// @ts-nocheck
import { assertSameCalculationContext, type CalculationContext, type SourceInputRef } from "./calculation-types.ts";

export function validateAuthoritativeInputs(context: CalculationContext, refs: SourceInputRef[], blockingConflicts: Array<{ status: string }> = []) {
  const codes = assertSameCalculationContext(context, refs);
  if (blockingConflicts.some((conflict) => conflict.status === "open" || conflict.status === "blocking")) {
    codes.push("CALC_BLOCKING_CONFLICT_OPEN");
  }
  return {
    valid: codes.length === 0,
    validationStatus: codes.length === 0 ? "valid" : "needs_review",
    validationCodes: [...new Set(codes)],
  };
}

export function rejectExternalCalculationInput(input: Record<string, unknown>) {
  const forbidden = ["cpiFetchUrl", "salesFetchUrl", "providerUrl", "externalIndexFetch", "camAllocation", "recoverabilityResult", "expenseRules", "criticalDates", "workflow_output", "extraction_data"];
  return forbidden.filter((key) => key in input).map((key) => `CALC_EXTERNAL_OR_RUNTIME_INPUT_FORBIDDEN:${key}`);
}

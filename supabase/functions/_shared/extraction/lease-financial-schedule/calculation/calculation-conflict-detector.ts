// @ts-nocheck
import { validatePeriods } from "./rent-calculator.ts";

export function detectCalculationConflicts(input: { dateResults?: any[]; termResults?: any[]; rentPeriods?: any[]; validationResults?: any[] }) {
  const conflicts: Array<{ conflictType: string; validationCodes: string[]; blocking: boolean }> = [];
  for (const result of [...(input.dateResults ?? []), ...(input.termResults ?? []), ...(input.validationResults ?? [])]) {
    if (result.validationStatus === "needs_review" || result.validationCodes?.some((code: string) => /CONFLICT|AMBIGUOUS|STALE|WRONG_PACKAGE|CROSS_ORG/.test(code))) {
      conflicts.push({ conflictType: classify(result.validationCodes ?? []), validationCodes: result.validationCodes ?? [], blocking: true });
    }
  }
  const periodCheck = validatePeriods(input.rentPeriods ?? []);
  if (periodCheck.validationCodes.includes("RENT_CALC_PERIOD_OVERLAP")) {
    conflicts.push({ conflictType: "rent_period_overlap", validationCodes: periodCheck.validationCodes, blocking: true });
  }
  return conflicts;
}

function classify(codes: string[]): string {
  if (codes.some((code) => code.includes("DATE"))) return "date_resolution_conflict";
  if (codes.some((code) => code.includes("TERM"))) return "term_duration_conflict";
  if (codes.some((code) => code.includes("DEPOSIT"))) return "deposit_reconciliation_conflict";
  if (codes.some((code) => code.includes("AMORTIZATION"))) return "amortization_result_conflict";
  if (codes.some((code) => code.includes("PERCENTAGE"))) return "percentage_formula_conflict";
  if (codes.some((code) => code.includes("STALE"))) return "stale_generation_input";
  return "unsupported_calculation_rule";
}

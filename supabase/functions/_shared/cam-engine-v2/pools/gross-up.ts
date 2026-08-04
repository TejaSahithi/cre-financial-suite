// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3, step 6:
// apply gross-up only to explicitly variable expenses (ADR-CAM-007). Fixed
// and semi_variable/unknown amounts are never grossed up; 'unknown' blocks
// gross-up entirely and produces a review exception rather than being
// silently treated as fixed (which would under-recover) or variable
// (which would over-recover) — blueprint section 19 default decision.
import type { CalcException } from "../contracts/cam-output.ts";
import type { PoolSegmentAmount } from "./pool-builder.ts";

export interface GrossUpResult {
  fixedAmount: number;
  variableAmount: number;
  grossedVariableAmount: number;
  grossUpAdjustment: number;
  adjustedPool: number;
}

const MINIMUM_SAFE_OCCUPANCY_PCT = 0.05; // guards div-by-near-zero without silently fabricating a recovery figure

export function applyGrossUp(
  poolId: string,
  amounts: PoolSegmentAmount[],
  actualOccupancyPct: number,
  targetOccupancyPct: number | null,
): { result: GrossUpResult; exceptions: CalcException[] } {
  const exceptions: CalcException[] = [];
  const unknownVariability = amounts.filter((a) => a.variability === "unknown");
  for (const a of unknownVariability) {
    exceptions.push({
      severity: "blocking",
      code: "VARIABILITY_UNKNOWN",
      entity_type: "cam_expense_inputs",
      entity_id: a.source_expense_input_id,
      message: `Expense input ${a.source_expense_input_id} in pool ${poolId} has unknown variability — gross-up cannot proceed until it is classified fixed, variable, or semi_variable`,
    });
  }

  const fixedAmount = round6(amounts.filter((a) => a.variability === "fixed" || a.variability === "semi_variable").reduce((s, a) => s + a.amount, 0));
  const variableAmount = round6(amounts.filter((a) => a.variability === "variable").reduce((s, a) => s + a.amount, 0));

  if (targetOccupancyPct === null || targetOccupancyPct <= actualOccupancyPct) {
    const adjustedPool = round6(fixedAmount + variableAmount);
    return {
      result: { fixedAmount, variableAmount, grossedVariableAmount: variableAmount, grossUpAdjustment: 0, adjustedPool },
      exceptions,
    };
  }

  const safeActual = Math.max(actualOccupancyPct, MINIMUM_SAFE_OCCUPANCY_PCT);
  const grossedVariableAmount = round6(variableAmount * (targetOccupancyPct / safeActual));
  const grossUpAdjustment = round6(grossedVariableAmount - variableAmount);
  const adjustedPool = round6(fixedAmount + variableAmount + grossUpAdjustment);

  return {
    result: { fixedAmount, variableAmount, grossedVariableAmount, grossUpAdjustment, adjustedPool },
    exceptions,
  };
}

function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

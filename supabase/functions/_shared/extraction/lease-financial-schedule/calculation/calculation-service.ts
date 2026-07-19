// @ts-nocheck
import { createHash } from "node:crypto";
import { resolveDateExpressions } from "./date-expression-resolver.ts";
import { resolveLeaseTerm } from "./term-resolver.ts";
import { detectCalculationConflicts } from "./calculation-conflict-detector.ts";
import { defaultEngineVersions } from "./calculation-types.ts";

export function buildCalculationInputHash(input: unknown): string {
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

export function planFinancialCalculationRun(input: { context: Record<string, unknown>; dateExpressions?: any[]; terms?: any[]; charges?: any[]; rentSchedules?: any[]; conflicts?: any[] }) {
  const hash = buildCalculationInputHash({
    context: input.context,
    dateExpressions: input.dateExpressions ?? [],
    terms: input.terms ?? [],
    charges: input.charges ?? [],
    rentSchedules: input.rentSchedules ?? [],
    conflicts: input.conflicts ?? [],
  });
  return {
    ...defaultEngineVersions(),
    mode: input.context.mode ?? "off",
    status: "running",
    inputHash: hash,
    inputDateExpressionCount: input.dateExpressions?.length ?? 0,
    inputTermCount: input.terms?.length ?? 0,
    inputRentScheduleCount: input.rentSchedules?.length ?? 0,
    inputChargeCount: input.charges?.length ?? 0,
  };
}

export function runPureFinancialCalculation(input: { context: Record<string, unknown>; dateExpressions?: any[]; terms?: any[]; eventDates?: Record<string, string> }) {
  const run = planFinancialCalculationRun(input);
  const dateResults = resolveDateExpressions(input.dateExpressions ?? [], input.eventDates ?? {});
  const termResults = (input.terms ?? []).map((term) => resolveLeaseTerm(term, dateResults));
  const conflicts = detectCalculationConflicts({ dateResults: [...dateResults.values()], termResults });
  return {
    run: {
      ...run,
      status: conflicts.some((conflict) => conflict.blocking) ? "needs_review" : "completed",
      resolvedDateCount: [...dateResults.values()].filter((result) => result.resolvedDate).length,
      resolvedTermCount: termResults.filter((result) => result.resolvedStartDate && result.resolvedEndDate).length,
      validationIssueCount: conflicts.length,
      blockingIssueCount: conflicts.filter((conflict) => conflict.blocking).length,
    },
    dateResults: [...dateResults.values()],
    termResults,
    conflicts,
  };
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).sort().join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

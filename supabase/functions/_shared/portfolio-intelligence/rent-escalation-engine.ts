// @ts-nocheck

import { numericValue } from "./types.ts";

export function applyRentEscalation(period: any, rule: any) {
  const amount = numericValue(period.amount);
  if (amount === null) return { ...period, status: "missing_amount" };
  if (rule.type === "fixed") return { ...period, amount: numericValue(rule.amount), escalationType: "fixed", status: numericValue(rule.amount) === null ? "missing_amount" : "resolved" };
  if (rule.type === "percentage") return { ...period, amount: amount * (1 + Number(rule.percent ?? 0) / 100), escalationType: "percentage", status: "resolved" };
  if (["cpi", "fmv"].includes(rule.type) && !rule.externalIndexValue && !rule.approvedAssumption) return { ...period, amount: null, escalationType: rule.type, status: "requires_assumption", reasonCodes: [`${rule.type}_external_value_required`] };
  return { ...period, escalationType: rule.type ?? "unknown", status: "resolved" };
}

// @ts-nocheck

import { isoDate, numericValue } from "./types.ts";

export function normalizeRentSchedule(args: { periods?: any[]; baseRent?: any; leasedArea?: number | null; amendmentEffects?: any[] }) {
  const periods = args.periods?.length ? args.periods : args.baseRent ? [{ ...args.baseRent, escalationType: args.baseRent.escalationType ?? "fixed" }] : [];
  return periods.map((period, index) => {
    const amount = numericValue(period.amount ?? period.normalizedAmount);
    const area = numericValue(period.leasedArea ?? args.leasedArea);
    const escalationType = period.escalationType ?? (period.percentIncrease ? "percentage" : "unknown");
    const unresolvedExternal = ["cpi", "fmv"].includes(escalationType) && !period.approvedAssumption && !period.externalIndexValue;
    return {
      startDate: isoDate(period.startDate),
      endDate: isoDate(period.endDate),
      amount: unresolvedExternal ? null : amount,
      currency: period.currency ?? null,
      frequency: ["monthly", "annual", "weekly", "daily"].includes(period.frequency) ? period.frequency : "other",
      amountPerArea: amount !== null && area ? amount / area : null,
      areaUnit: period.areaUnit ?? (area ? "sf" : null),
      escalationType,
      status: unresolvedExternal ? "requires_assumption" : amount === null ? "missing_amount" : "resolved",
      sourceFieldKeys: period.sourceFieldKeys ?? ["base_rent_current"],
      evidenceIds: period.evidenceIds ?? [],
      reasonCodes: unresolvedExternal ? [`${escalationType}_external_value_required`] : [],
      sequence: index + 1,
    };
  }).sort((a, b) => `${a.startDate ?? "9999"}:${a.sequence}`.localeCompare(`${b.startDate ?? "9999"}:${b.sequence}`));
}

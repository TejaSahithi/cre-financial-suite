// @ts-nocheck

export function validateRentSchedule(periods: any[]) {
  const warnings: string[] = [];
  const sorted = [...periods].sort((a, b) => String(a.startDate ?? "").localeCompare(String(b.startDate ?? "")));
  for (let i = 1; i < sorted.length; i += 1) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.endDate && current.startDate && current.startDate <= previous.endDate) warnings.push("overlapping_periods");
    if (previous.endDate && current.startDate) {
      const next = new Date(`${previous.endDate}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      if (current.startDate > next.toISOString().slice(0, 10)) warnings.push("gap_between_periods");
    }
  }
  return { valid: warnings.length === 0, warnings: [...new Set(warnings)].sort() };
}

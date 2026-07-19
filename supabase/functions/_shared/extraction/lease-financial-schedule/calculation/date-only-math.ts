// @ts-nocheck
export interface DateOffset {
  value: number;
  unit: "day" | "week" | "month" | "year";
  direction?: "after" | "before";
}

export function parseDateOnly(value: string): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (!match) throw new Error("DATE_ONLY_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) throw new Error("DATE_ONLY_INVALID");
  return { year, month, day };
}

export function formatDateOnly(parts: { year: number; month: number; day: number }): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

export function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function ordinal(value: string): number {
  const { year, month, day } = parseDateOnly(value);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function fromOrdinal(value: number): string {
  const date = new Date(value * 86_400_000);
  return formatDateOnly({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() });
}

export function addDays(date: string, days: number): string {
  return fromOrdinal(ordinal(date) + days);
}

export function addMonths(date: string, months: number): string {
  const start = parseDateOnly(date);
  const originalWasMonthEnd = start.day === daysInMonth(start.year, start.month);
  const total = start.year * 12 + (start.month - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12 + 12) % 12 + 1;
  const day = originalWasMonthEnd ? daysInMonth(year, month) : Math.min(start.day, daysInMonth(year, month));
  return formatDateOnly({ year, month, day });
}

export function addYears(date: string, years: number): string {
  return addMonths(date, years * 12);
}

export function addOffset(date: string, offset: DateOffset): string {
  const sign = offset.direction === "before" ? -1 : 1;
  const value = sign * Number(offset.value);
  if (offset.unit === "day") return addDays(date, value);
  if (offset.unit === "week") return addDays(date, value * 7);
  if (offset.unit === "month") return addMonths(date, value);
  if (offset.unit === "year") return addYears(date, value);
  throw new Error("DATE_OFFSET_UNSUPPORTED");
}

export function compareDateOnly(left: string, right: string): number {
  const a = ordinal(left);
  const b = ordinal(right);
  return a === b ? 0 : a > b ? 1 : -1;
}

export function inclusiveDays(startDate: string, endDate: string): number {
  return ordinal(endDate) - ordinal(startDate) + 1;
}

export function applyBusinessDayPolicy(date: string, policy?: "none" | "next_business_day" | "previous_business_day"): string | null {
  if (!policy || policy === "none") return date;
  let current = date;
  for (let i = 0; i < 7; i++) {
    const dow = new Date(ordinal(current) * 86_400_000).getUTCDay();
    if (dow !== 0 && dow !== 6) return current;
    current = addDays(current, policy === "next_business_day" ? 1 : -1);
  }
  return null;
}

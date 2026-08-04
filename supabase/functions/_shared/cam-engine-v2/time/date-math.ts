// Enterprise CAM & Budget Implementation Blueprint v1.0 — Phase 3.
// Pure date arithmetic. No Date-object DST/timezone ambiguity: every date
// is a plain "YYYY-MM-DD" string, parsed into a UTC-midnight epoch-day
// integer for arithmetic, per blueprint requirement 11 ("use actual
// calendar days by default, including leap years").

export type ISODate = string; // "YYYY-MM-DD"

function toEpochDay(date: ISODate): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86400000;
}

function fromEpochDay(epochDay: number): ISODate {
  const d = new Date(epochDay * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month1to12: number): number {
  return new Date(Date.UTC(year, month1to12, 0)).getUTCDate();
}

/** Inclusive day count between two ISO dates (a==b -> 1 day). */
export function inclusiveDayCount(start: ISODate, end: ISODate): number {
  return toEpochDay(end) - toEpochDay(start) + 1;
}

export function compareDates(a: ISODate, b: ISODate): number {
  return toEpochDay(a) - toEpochDay(b);
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return compareDates(a, b) >= 0 ? a : b;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return compareDates(a, b) <= 0 ? a : b;
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromEpochDay(toEpochDay(date) + days);
}

/**
 * Inclusive-day overlap between [aStart, aEnd] and [bStart, bEnd]. Either
 * range may be open-ended (null = unbounded in that direction). Returns
 * null when there is no overlap, or {start, end, days} — days always uses
 * the true calendar length of the overlap (leap years handled correctly
 * because both endpoints are real dates, not a hard-coded 365/366).
 */
export function overlapRange(
  aStart: ISODate,
  aEnd: ISODate | null,
  bStart: ISODate,
  bEnd: ISODate | null,
): { start: ISODate; end: ISODate; days: number } | null {
  const start = maxDate(aStart, bStart);
  const end = aEnd === null && bEnd === null
    ? null
    : aEnd === null
    ? bEnd!
    : bEnd === null
    ? aEnd
    : minDate(aEnd, bEnd);
  if (end !== null && compareDates(start, end) > 0) return null;
  if (end === null) return null; // an unbounded overlap has no finite day count; callers must clip to a finite window first
  return { start, end, days: inclusiveDayCount(start, end) };
}

/** First and last calendar day of a given month, as ISO strings. */
export function monthBounds(year: number, month1to12: number): { start: ISODate; end: ISODate } {
  const start = `${year}-${String(month1to12).padStart(2, "0")}-01`;
  const end = `${year}-${String(month1to12).padStart(2, "0")}-${String(daysInMonth(year, month1to12)).padStart(2, "0")}`;
  return { start, end };
}

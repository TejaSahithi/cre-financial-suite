import { parseISO } from "date-fns";

export const RENT_SCHEDULE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function safeDate(value) {
  if (!value) return null;
  try {
    const text = typeof value === "string" ? value.trim() : "";
    const d = /^\d{4}-\d{2}-\d{2}$/.test(text)
      ? new Date(`${text}T00:00:00Z`)
      : (text ? parseISO(text) : new Date(value));
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export function utcMonthStart(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex, 1));
}

export function utcMonthEnd(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0));
}

function utcDayNumber(value) {
  return Math.floor(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()) / 86400000);
}

export function daysBetweenInclusive(start, end) {
  return Math.max(0, utcDayNumber(end) - utcDayNumber(start) + 1);
}

function daysInUtcMonth(value) {
  return utcMonthEnd(value.getUTCFullYear(), value.getUTCMonth()).getUTCDate();
}

export function scheduleRowsForLease(scheduleRows, leaseId) {
  return (scheduleRows || []).filter((row) => row?.lease_id === leaseId);
}

export function scheduleRowMonthlyAmount(row) {
  const monthly = Number(row?.monthly_amount);
  if (Number.isFinite(monthly)) return monthly;
  const annual = Number(row?.annual_amount);
  if (Number.isFinite(annual)) return annual / 12;
  const rentPerSf = Number(row?.rent_per_sf);
  const rsf = Number(row?.rsf);
  if (Number.isFinite(rentPerSf) && Number.isFinite(rsf)) return (rentPerSf * rsf) / 12;
  return 0;
}

export function scheduleRowAmountForMonth(row, monthStart, monthEnd) {
  const rowStart = safeDate(row?.period_start);
  const rowEnd = safeDate(row?.period_end);
  if (!rowStart || !rowEnd || rowStart > monthEnd || rowEnd < monthStart) return 0;

  const activeStart = rowStart > monthStart ? rowStart : monthStart;
  const activeEnd = rowEnd < monthEnd ? rowEnd : monthEnd;
  const overlapDays = daysBetweenInclusive(activeStart, activeEnd);
  return Math.round(scheduleRowMonthlyAmount(row) * (overlapDays / daysInUtcMonth(monthStart)) * 100) / 100;
}

export function previewAmountForMonth(row, monthStart, monthEnd) {
  const rentStart = safeDate(row.rent_commencement_date || row.lease_start);
  const leaseEnd = safeDate(row.lease_end);
  const monthly = Number(row.monthly_rent || 0) || (Number(row.annualized_rent || 0) / 12);
  if (!rentStart || !leaseEnd || monthly <= 0 || rentStart > monthEnd || leaseEnd < monthStart) return 0;

  const activeStart = rentStart > monthStart ? rentStart : monthStart;
  const activeEnd = leaseEnd < monthEnd ? leaseEnd : monthEnd;
  const overlapDays = daysBetweenInclusive(activeStart, activeEnd);
  return Math.round(monthly * (overlapDays / daysInUtcMonth(monthStart)) * 100) / 100;
}

export function buildLeaseYearSchedule(row, persistedRows = [], year) {
  const hasPersistedRows = persistedRows.length > 0;
  const months = RENT_SCHEDULE_MONTHS.map((month, index) => {
    const start = utcMonthStart(year, index);
    const end = utcMonthEnd(year, index);
    const amount = hasPersistedRows
      ? persistedRows.reduce((sum, scheduleRow) => sum + scheduleRowAmountForMonth(scheduleRow, start, end), 0)
      : previewAmountForMonth(row, start, end);
    return {
      month,
      amount: Math.round(amount * 100) / 100,
    };
  });

  return {
    year,
    source: hasPersistedRows ? "rent_schedules" : "approved abstract preview",
    months,
    total: Math.round(months.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
  };
}

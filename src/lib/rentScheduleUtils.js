import { parseISO } from "date-fns";

export const RENT_SCHEDULE_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CONTRACTED_PHASES = new Set(["contracted", "base", "base_rent", "initial", "initial_term"]);
const APPROVED_RENEWAL_PHASES = new Set(["approved_renewal", "renewal", "approved_extension", "extension", "renewal_base_rent"]);
const ASSUMED_RENEWAL_PHASES = new Set(["assumed_renewal", "assumed_extension", "modeled_renewal", "holdover"]);
const ACTIVE_SCHEDULE_STATUSES = new Set(["", "approved", "active", "effective"]);

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

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

export function isActiveRentScheduleRow(row = {}) {
  return ACTIVE_SCHEDULE_STATUSES.has(normalizeToken(row.status));
}

export function isRentScheduleRowIncludedForMode(row = {}, projectionMode = "include_approved_renewals") {
  const phase = normalizeToken(row.phase || row.row_type || "contracted");
  if (CONTRACTED_PHASES.has(phase)) return true;
  if (projectionMode === "contracted_only") return false;
  if (APPROVED_RENEWAL_PHASES.has(phase)) return true;
  if (projectionMode === "include_assumed_renewals" && ASSUMED_RENEWAL_PHASES.has(phase)) return true;
  return false;
}

export function filterRentScheduleRowsForProjection(scheduleRows = [], options = {}) {
  const projectionMode = options.projectionMode || "include_approved_renewals";
  return (scheduleRows || [])
    .filter(isActiveRentScheduleRow)
    .filter((row) => isRentScheduleRowIncludedForMode(row, projectionMode));
}

export function scheduleRowsForLease(scheduleRows, leaseId, options = {}) {
  return filterRentScheduleRowsForProjection(scheduleRows || [], options)
    .filter((row) => row?.lease_id === leaseId);
}

export function scheduleRowMonthlyAmount(row = {}) {
  const monthly = Number(row.monthly_amount);
  const annual = Number(row.annual_amount);
  const rentPerSf = Number(row.rent_per_sf);
  const rsf = Number(row.rsf);

  let amount = 0;
  if (Number.isFinite(monthly)) amount = monthly;
  else if (Number.isFinite(annual)) amount = annual / 12;
  else if (Number.isFinite(rentPerSf) && Number.isFinite(rsf)) amount = (rentPerSf * rsf) / 12;

  if (row.is_abatement && amount > 0) return -amount;
  return amount;
}

export function scheduleRowAmountForMonth(row, monthStart, monthEnd) {
  const rowStart = safeDate(row?.period_start);
  const rowEnd = safeDate(row?.period_end);
  if (!rowStart || !rowEnd || rowStart > monthEnd || rowEnd < monthStart) {
    return { amount: 0, overlapDays: 0, daysInMonth: daysInUtcMonth(monthStart), isPartial: false };
  }

  const activeStart = rowStart > monthStart ? rowStart : monthStart;
  const activeEnd = rowEnd < monthEnd ? rowEnd : monthEnd;
  const overlapDays = daysBetweenInclusive(activeStart, activeEnd);
  const monthDays = daysInUtcMonth(monthStart);
  const amount = Math.round(scheduleRowMonthlyAmount(row) * (overlapDays / monthDays) * 100) / 100;
  return {
    amount,
    overlapDays,
    daysInMonth: monthDays,
    isPartial: overlapDays > 0 && overlapDays < monthDays,
    activeStart: activeStart.toISOString().slice(0, 10),
    activeEnd: activeEnd.toISOString().slice(0, 10),
    rowId: row.id || null,
    phase: row.phase || "contracted",
    rowType: row.row_type || "base_rent",
    source: row.source || row.provenance || "rent_schedules",
  };
}

export function previewAmountForMonth(row, monthStart, monthEnd) {
  const rentStart = safeDate(row.rent_commencement_date || row.lease_start || row.commencement_date || row.start_date || row.lease_start_date || row.term_start_date);
  const leaseEnd = safeDate(row.lease_end || row.expiration_date || row.end_date || row.lease_end_date || row.term_end_date);
  const monthly = Number(row.monthly_rent || 0) || (Number(row.annualized_rent || 0) / 12);
  const monthDays = daysInUtcMonth(monthStart);
  if (!rentStart || !leaseEnd || monthly <= 0 || rentStart > monthEnd || leaseEnd < monthStart) {
    return { amount: 0, overlapDays: 0, daysInMonth: monthDays, isPartial: false };
  }

  const activeStart = rentStart > monthStart ? rentStart : monthStart;
  const activeEnd = leaseEnd < monthEnd ? leaseEnd : monthEnd;
  const overlapDays = daysBetweenInclusive(activeStart, activeEnd);
  return {
    amount: Math.round(monthly * (overlapDays / monthDays) * 100) / 100,
    overlapDays,
    daysInMonth: monthDays,
    isPartial: overlapDays > 0 && overlapDays < monthDays,
    activeStart: activeStart.toISOString().slice(0, 10),
    activeEnd: activeEnd.toISOString().slice(0, 10),
    source: "approved abstract preview",
  };
}

export function buildLeaseYearSchedule(row, persistedRows = [], year, options = {}) {
  const scheduleRows = filterRentScheduleRowsForProjection(persistedRows, options);
  const hasPersistedRows = scheduleRows.length > 0;
  const months = RENT_SCHEDULE_MONTHS.map((month, index) => {
    const start = utcMonthStart(year, index);
    const end = utcMonthEnd(year, index);
    const segments = hasPersistedRows
      ? scheduleRows
        .map((scheduleRow) => scheduleRowAmountForMonth(scheduleRow, start, end))
        .filter((segment) => segment.overlapDays > 0 || segment.amount !== 0)
      : [previewAmountForMonth(row, start, end)].filter((segment) => segment.overlapDays > 0 || segment.amount !== 0);
    const amount = segments.reduce((sum, segment) => sum + segment.amount, 0);
    const overlapDays = segments.reduce((sum, segment) => sum + segment.overlapDays, 0);
    const monthDays = daysInUtcMonth(start);
    return {
      month,
      monthIndex: index,
      amount: Math.round(amount * 100) / 100,
      overlapDays: Math.min(overlapDays, monthDays),
      daysInMonth: monthDays,
      isPartial: segments.some((segment) => segment.isPartial),
      hasChange: segments.length > 1,
      segments,
    };
  });

  return {
    year,
    source: hasPersistedRows ? "rent_schedules" : "approved abstract preview",
    projectionMode: options.projectionMode || "include_approved_renewals",
    storedRowCount: scheduleRows.length,
    months,
    total: Math.round(months.reduce((sum, item) => sum + item.amount, 0) * 100) / 100,
  };
}

export function annualizedRunRateFromYearSchedule(yearSchedule = {}) {
  const fullMonth = [...(yearSchedule.months || [])].reverse().find((month) => month.amount > 0 && !month.isPartial);
  const fallbackMonth = [...(yearSchedule.months || [])].reverse().find((month) => month.amount > 0);
  const basis = fullMonth || fallbackMonth || null;
  return basis ? Math.round(Number(basis.amount || 0) * 12 * 100) / 100 : 0;
}

export function scheduleHasMonthlyVariability(yearSchedule = {}) {
  const amounts = (yearSchedule.months || []).map((month) => Number(month.amount || 0));
  const positiveAmounts = amounts.filter((amount) => amount > 0);
  if (positiveAmounts.length <= 1) return false;
  return positiveAmounts.some((amount) => Math.abs(amount - positiveAmounts[0]) > 0.01) ||
    (yearSchedule.months || []).some((month) => month.isPartial || month.hasChange);
}

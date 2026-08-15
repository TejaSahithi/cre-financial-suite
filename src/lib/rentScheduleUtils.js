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
function dateYear(value) {
  const date = safeDate(value);
  return date ? date.getUTCFullYear() : null;
}

function addYearRange(years, startYear, endYear) {
  if (!Number.isFinite(startYear) && !Number.isFinite(endYear)) return;
  const start = Number.isFinite(startYear) ? startYear : endYear;
  const end = Number.isFinite(endYear) ? endYear : startYear;
  const lower = Math.min(start, end);
  const upper = Math.max(start, end);
  for (let year = lower; year <= upper; year += 1) years.add(year);
  years.add(lower - 1);
  years.add(upper + 1);
}

export function buildRentFiscalYearOptions({ selectedYear, currentYear = new Date().getFullYear(), leaseRows = [], scheduleRows = [] } = {}) {
  const years = new Set();
  [selectedYear, currentYear - 1, currentYear, currentYear + 1, currentYear + 2]
    .filter(Number.isFinite)
    .forEach((year) => years.add(Number(year)));

  for (const row of leaseRows || []) {
    const startYear = dateYear(row.rent_commencement_date || row.lease_start || row.commencement_date || row.start_date || row.lease_start_date || row.term_start_date);
    const endYear = dateYear(row.lease_end || row.expiration_date || row.end_date || row.lease_end_date || row.term_end_date);
    addYearRange(years, startYear, endYear);
  }

  for (const row of scheduleRows || []) {
    addYearRange(years, dateYear(row.period_start), dateYear(row.period_end));
  }

  return [...years]
    .filter((year) => Number.isInteger(year) && year >= 1900 && year <= 2200)
    .sort((left, right) => left - right);
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

function parseNumberLike(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function readFirstNumber(row = {}, keys = []) {
  for (const key of keys) {
    const value = parseNumberLike(row?.[key]);
    if (value != null) return value;
  }
  return null;
}

function percentageRate(value) {
  const parsed = parseNumberLike(value);
  if (parsed == null || parsed <= 0) return 0;
  const rate = parsed > 1 ? parsed / 100 : parsed;
  return rate > 0 && rate <= 0.5 ? rate : 0;
}

function approvedPreviewEscalationRate(row = {}) {
  const type = normalizeToken(row.escalation_type || row.rent_escalation_type);
  if (["none", "flat", "fixed", "no_escalation"].includes(type)) return 0;
  return percentageRate(
    row.escalation_rate ??
    row.rent_escalation_rate ??
    row.annual_increase_percent ??
    row.renewal_escalation_percent ??
    row.renewal_escalation_pct,
  );
}

function addUtcYearsClamped(date, years) {
  const year = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = Math.min(date.getUTCDate(), utcMonthEnd(year, month).getUTCDate());
  return new Date(Date.UTC(year, month, day));
}

function completedEscalationSteps(row, rentStart, date) {
  if (!rentStart || !date || date < rentStart) return 0;
  const timing = normalizeToken(row.escalation_timing || row.rent_escalation_timing);
  if (timing.includes("calendar")) {
    return Math.max(0, date.getUTCFullYear() - rentStart.getUTCFullYear());
  }

  let years = date.getUTCFullYear() - rentStart.getUTCFullYear();
  if (addUtcYearsClamped(rentStart, years) > date) years -= 1;
  return Math.max(0, years);
}

function nextEscalationDateAfter(row, rentStart, afterDate) {
  const timing = normalizeToken(row.escalation_timing || row.rent_escalation_timing);
  if (timing.includes("calendar")) {
    let year = Math.max(rentStart.getUTCFullYear() + 1, afterDate.getUTCFullYear());
    let candidate = new Date(Date.UTC(year, 0, 1));
    if (candidate <= afterDate) candidate = new Date(Date.UTC(year + 1, 0, 1));
    return candidate;
  }

  let steps = completedEscalationSteps(row, rentStart, afterDate) + 1;
  let candidate = addUtcYearsClamped(rentStart, steps);
  while (candidate <= afterDate) {
    steps += 1;
    candidate = addUtcYearsClamped(rentStart, steps);
  }
  return candidate;
}

function previewBaseMonthlyAmount(row = {}) {
  const monthly = readFirstNumber(row, ["monthly_rent", "base_rent_monthly", "base_rent", "monthly_base_rent"]);
  if (monthly != null && monthly > 0) return monthly;
  const annual = readFirstNumber(row, ["annualized_rent", "annual_rent", "base_rent_annual", "annual_base_rent"]);
  if (annual != null && annual > 0) return annual / 12;
  const rentPerSf = readFirstNumber(row, ["rent_per_sf", "tenant_rent_per_rsf", "base_rent_psf"]);
  const rsf = readFirstNumber(row, ["rsf", "tenant_rsf", "rentable_area_sqft", "square_footage", "total_sf"]);
  return rentPerSf != null && rsf != null && rentPerSf > 0 && rsf > 0 ? (rentPerSf * rsf) / 12 : 0;
}

function previewSegmentsForMonth(row, monthStart, monthEnd) {
  const rentStart = safeDate(row.rent_commencement_date || row.lease_start || row.commencement_date || row.start_date || row.lease_start_date || row.term_start_date);
  const leaseEnd = safeDate(row.lease_end || row.expiration_date || row.end_date || row.lease_end_date || row.term_end_date);
  const baseMonthly = previewBaseMonthlyAmount(row);
  const monthDays = daysInUtcMonth(monthStart);
  if (!rentStart || !leaseEnd || baseMonthly <= 0 || rentStart > monthEnd || leaseEnd < monthStart) return [];

  const rate = approvedPreviewEscalationRate(row);
  const activeEnd = leaseEnd < monthEnd ? leaseEnd : monthEnd;
  let cursor = rentStart > monthStart ? rentStart : monthStart;
  const segments = [];

  while (cursor <= activeEnd) {
    const nextEscalation = rate > 0 ? nextEscalationDateAfter(row, rentStart, cursor) : null;
    const segmentEnd = nextEscalation && nextEscalation <= activeEnd
      ? new Date(nextEscalation.getTime() - 86400000)
      : activeEnd;
    const steps = rate > 0 ? completedEscalationSteps(row, rentStart, cursor) : 0;
    const monthly = Math.round(baseMonthly * Math.pow(1 + rate, steps) * 100) / 100;
    const overlapDays = daysBetweenInclusive(cursor, segmentEnd);
    segments.push({
      amount: Math.round(monthly * (overlapDays / monthDays) * 100) / 100,
      overlapDays,
      daysInMonth: monthDays,
      isPartial: overlapDays > 0 && overlapDays < monthDays,
      activeStart: cursor.toISOString().slice(0, 10),
      activeEnd: segmentEnd.toISOString().slice(0, 10),
      source: rate > 0 ? "approved abstract preview (escalated)" : "approved abstract preview",
      escalationRate: rate,
      escalationStep: steps,
    });

    if (!nextEscalation || nextEscalation > activeEnd) break;
    cursor = nextEscalation;
  }

  return segments;
}

export function previewAmountForMonth(row, monthStart, monthEnd) {
  const segments = previewSegmentsForMonth(row, monthStart, monthEnd);
  const monthDays = daysInUtcMonth(monthStart);
  if (!segments.length) {
    return { amount: 0, overlapDays: 0, daysInMonth: monthDays, isPartial: false };
  }
  const amount = segments.reduce((sum, segment) => sum + segment.amount, 0);
  const overlapDays = segments.reduce((sum, segment) => sum + segment.overlapDays, 0);
  return {
    amount: Math.round(amount * 100) / 100,
    overlapDays,
    daysInMonth: monthDays,
    isPartial: segments.some((segment) => segment.isPartial),
    activeStart: segments[0]?.activeStart,
    activeEnd: segments[segments.length - 1]?.activeEnd,
    source: segments.some((segment) => segment.escalationRate > 0)
      ? "approved abstract preview (escalated)"
      : "approved abstract preview",
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
      : previewSegmentsForMonth(row, start, end).filter((segment) => segment.overlapDays > 0 || segment.amount !== 0);
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
    source: hasPersistedRows
      ? "rent_schedules"
      : (months.some((month) => month.segments?.some((segment) => segment.escalationRate > 0))
        ? "approved abstract preview (escalated)"
        : "approved abstract preview"),
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

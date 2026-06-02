export const toIsoDate = (value) => {
  if (!value) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const raw = String(value).trim();
  if (!raw) return null;
  // Already YYYY-MM-DD (with or without trailing time) — keep as-is.
  const isoMatch = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  // MM/DD/YYYY or M/D/YYYY → reorder.
  const usMatch = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
  if (usMatch) {
    const [, m, d, y] = usMatch;
    const yyyy = y.length === 2 ? (Number(y) > 50 ? `19${y}` : `20${y}`) : y;
    return `${yyyy}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  // Use UTC slice so timezone offset doesn't shift the date.
  return new Date(Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()))
    .toISOString()
    .slice(0, 10);
};

export const toNoticeDays = (lease) => {
  // Numeric days first.
  for (const key of ["renewal_notice_days"]) {
    const v = Number(lease?.[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  // Numeric months → days.
  for (const key of ["renewal_notice_months"]) {
    const v = Number(lease?.[key]);
    if (Number.isFinite(v) && v > 0) return Math.round(v * 30);
  }
  // Free-text fallback: "90 days", "3 months", "6-month notice".
  for (const key of ["renewal_notice_period", "renewal_notice", "notice_period"]) {
    const raw = String(lease?.[key] || "").toLowerCase();
    if (!raw) continue;
    const m = raw.match(/(\d+(?:\.\d+)?)\s*(day|month|year)/);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (m[2].startsWith("day")) return Math.round(n);
    if (m[2].startsWith("month")) return Math.round(n * 30);
    if (m[2].startsWith("year")) return Math.round(n * 365);
  }
  return null;
};

export function buildCriticalDateRows(approvedLease, today = new Date().toISOString().slice(0, 10)) {
  const commencement = toIsoDate(
    approvedLease.commencement_date
    ?? approvedLease.start_date
    ?? approvedLease.lease_start_date
    ?? approvedLease.term_start_date,
  );
  const expiration = toIsoDate(
    approvedLease.expiration_date
    ?? approvedLease.end_date
    ?? approvedLease.lease_end_date
    ?? approvedLease.term_end_date,
  );
  const optionDeadline = toIsoDate(
    approvedLease.option_exercise_deadline
    ?? approvedLease.renewal_exercise_deadline
    ?? approvedLease.option_deadline,
  );
  const rentCommencement = toIsoDate(approvedLease.rent_commencement_date);
  const renewalNoticeDays = toNoticeDays(approvedLease);

  const baseRow = {
    org_id: approvedLease.org_id,
    lease_id: approvedLease.id,
    property_id: approvedLease.property_id ?? null,
    source: "derived",
  };
  const rows = [];
  if (commencement) {
    rows.push({
      ...baseRow,
      date_type: "commencement",
      due_date: commencement,
      status: commencement <= today ? "completed" : "open",
    });
  }
  if (rentCommencement && rentCommencement !== commencement) {
    rows.push({
      ...baseRow,
      date_type: "rent_commencement",
      due_date: rentCommencement,
      status: rentCommencement <= today ? "completed" : "open",
    });
  }
  if (expiration) {
    rows.push({
      ...baseRow,
      date_type: "expiration",
      due_date: expiration,
      status: expiration < today ? "completed" : "open",
    });
    if (renewalNoticeDays && renewalNoticeDays > 0) {
      const expirationDate = new Date(`${expiration}T00:00:00Z`);
      expirationDate.setUTCDate(expirationDate.getUTCDate() - renewalNoticeDays);
      const noticeIso = expirationDate.toISOString().slice(0, 10);
      rows.push({
        ...baseRow,
        date_type: "renewal_notice",
        due_date: noticeIso,
        status: noticeIso < today ? "completed" : "open",
        reminder_days_before: 30,
      });
    }
  }
  if (optionDeadline) {
    rows.push({
      ...baseRow,
      date_type: "option_exercise",
      due_date: optionDeadline,
      status: optionDeadline < today ? "completed" : "open",
      reminder_days_before: 60,
    });
  }
  return rows;
}

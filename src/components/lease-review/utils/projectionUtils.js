export function calculateSnapshotFiscalYears(approvedLease, currentYear = new Date().getFullYear()) {
  const safeYear = (raw) => {
    if (!raw) return null;
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.getFullYear();
    const s = String(raw).trim();
    const isoMatch = s.match(/^(\d{4})-\d{2}-\d{2}/);
    if (isoMatch) return Number(isoMatch[1]);
    const parsed = new Date(s);
    return Number.isNaN(parsed.getTime()) ? null : parsed.getFullYear();
  };

  const commencementYear = safeYear(
    approvedLease?.commencement_date
    ?? approvedLease?.start_date
    ?? approvedLease?.lease_start_date
    ?? approvedLease?.term_start_date,
  );

  const expirationYear = safeYear(
    approvedLease?.expiration_date
    ?? approvedLease?.end_date
    ?? approvedLease?.lease_end_date
    ?? approvedLease?.term_end_date,
  );

  return Array.from(new Set([
    currentYear - 1,
    currentYear,
    currentYear + 1,
    ...(commencementYear ? [commencementYear, commencementYear + 1] : []),
    ...(expirationYear ? [expirationYear] : []),
  ])).filter((y) => Number.isFinite(y) && y > 1900 && y < 2100);
}

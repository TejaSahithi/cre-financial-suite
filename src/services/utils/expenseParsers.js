export function toNumber(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

export function asNumberOrNull(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

export function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

export function isUuidLike(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

export function cleanUuid(value) {
  return isUuidLike(value) ? value : null;
}

export function normalizeDateCandidate(value) {
  if (!value) return null;
  const raw = String(value);
  const parsed = raw.length === 10
    ? new Date(`${raw}T00:00:00`)
    : new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function normalizeLeaseStatus(status) {
  return normalizeText(status);
}

export function normalizeRuleStatus(rule) {
  return normalizeText(rule?.row_status);
}

export function normalizeSourceType(expense) {
  return expense?.source_type || expense?.source || "manual";
}

export function leaseOverlapsFiscalYear(lease, fiscalYear) {
  if (!fiscalYear) return true;

  const start = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`) : null;
  const end = lease?.end_date ? new Date(`${lease.end_date}T23:59:59`) : null;
  const yearStart = new Date(fiscalYear, 0, 1);
  const yearEnd = new Date(fiscalYear, 11, 31, 23, 59, 59);

  if (start && Number.isNaN(start.getTime())) return true;
  if (end && Number.isNaN(end.getTime())) return true;
  if (start && start > yearEnd) return false;
  if (end && end < yearStart) return false;
  return true;
}

export function deriveLeaseExpenseFiscalYear(lease) {
  const currentYear = new Date().getFullYear();
  if (leaseOverlapsFiscalYear(lease, currentYear)) return currentYear;

  const startYear = lease?.start_date ? new Date(`${lease.start_date}T00:00:00`).getFullYear() : null;
  if (Number.isFinite(startYear)) return startYear;

  const endYear = lease?.end_date ? new Date(`${lease.end_date}T00:00:00`).getFullYear() : null;
  if (Number.isFinite(endYear)) return endYear;

  return currentYear;
}

export function deriveLeaseExpenseDate(lease, fiscalYear) {
  const startDate = typeof lease?.start_date === "string" ? lease.start_date : "";
  if (startDate && startDate.startsWith(`${fiscalYear}-`)) {
    return startDate;
  }
  return `${fiscalYear}-01-01`;
}

export function expenseServiceDate(expense) {
  return (
    expense?.expense_date ||
    expense?.date ||
    expense?.service_period_start ||
    expense?.billing_period_start ||
    expense?.period ||
    null
  );
}

export function compactDefined(row = {}) {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined)
  );
}

export function expenseSyncKey({ lease_id, category, fiscal_year, source_type }) {
  return [lease_id || "", category || "", fiscal_year || "", source_type || ""].join("::");
}

export function buildPropertyLookup(properties = []) {
  if (properties instanceof Map) return properties;
  return new Map((properties || []).map((property) => [property.id, property]));
}

export function buildLeaseLookup(leases = []) {
  return new Map((leases || []).map((lease) => [lease.id, lease]));
}

export function isMissingExpenseRuleTable(error) {
  if (!error) return false;

  const code = String(error.code || "").toUpperCase();
  if (code === "PGRST205" || code === "42P01" || code === "404") return true;

  const text = [error.message, error.details, error.hint]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (
    /relation .* does not exist/.test(text) ||
    /table .* does not exist/.test(text) ||
    text.includes("could not find the table")
  );
}

export function extractMissingColumn(error) {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ");
  if (!text) return null;

  let match = text.match(/Could not find the '([^']+)' column/i);
  if (match?.[1]) return match[1];

  match = text.match(/column\s+["']?([a-zA-Z0-9_.]+)["']?/i);
  if (match?.[1]) {
    return String(match[1]).split(".").pop();
  }

  match = text.match(/column ["']?([a-zA-Z0-9_]+)["']?/i);
  if (match?.[1]) return match[1];

  return null;
}

export function isMissingColumnError(error) {
  return (
    error?.code === "PGRST204" ||
    error?.code === "42703" ||
    Boolean(extractMissingColumn(error))
  );
}

export function isSchemaCompatibilityError(error) {
  const text = [error?.message, error?.details, error?.hint].filter(Boolean).join(" ").toLowerCase();
  return isMissingColumnError(error) || text.includes("schema mismatch");
}


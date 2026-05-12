const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXCEL_MAX_SERIAL = 2958465;

export const DATE_FIELD_KEYS = new Set([
  "acquired_date",
  "lease_start",
  "lease_end",
  "start_date",
  "end_date",
  "issued_date",
  "due_date",
  "date",
]);

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatUtcDate(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function excelSerialToIsoDate(serial) {
  if (!Number.isFinite(serial)) return null;
  const wholeDays = Math.floor(serial);
  if (wholeDays <= 0 || wholeDays > EXCEL_MAX_SERIAL) return null;
  return formatUtcDate(new Date(EXCEL_EPOCH_UTC_MS + wholeDays * MS_PER_DAY));
}

export function normalizeImportedDateValue(value) {
  if (value == null || value === "") return value;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? value : formatUtcDate(value);
  }

  if (typeof value === "number") {
    return excelSerialToIsoDate(value) ?? value;
  }

  const raw = String(value).trim();
  if (!raw) return value;

  if (/^\d{4}-\d{2}-\d{2}(?:[T\s].*)?$/.test(raw)) {
    return raw.slice(0, 10);
  }

  if (/^\d+(\.\d+)?$/.test(raw)) {
    return excelSerialToIsoDate(Number(raw)) ?? value;
  }

  const monthDayYear = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (monthDayYear) {
    const [, month, day, year] = monthDayYear;
    return `${year}-${pad2(month)}-${pad2(day)}`;
  }

  const dayMonthYear = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/);
  if (dayMonthYear) {
    const months = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };
    const [, day, monthName, year] = dayMonthYear;
    const month = months[monthName.toLowerCase()];
    if (month) {
      return `${year}-${pad2(month)}-${pad2(day)}`;
    }
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? value : formatUtcDate(parsed);
}

export function normalizeImportedDateFields(record, dateFieldKeys = DATE_FIELD_KEYS) {
  if (!record || typeof record !== "object") return record;

  const normalized = { ...record };
  dateFieldKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      normalized[key] = normalizeImportedDateValue(normalized[key]);
    }
  });
  return normalized;
}

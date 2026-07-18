// @ts-nocheck
/**
 * claim-normalization.ts — P2.4.
 *
 * Implements the normalization strategies the concept registry already
 * names per concept (concept-registry.ts's comparisonStrategyFor/
 * normalizationStrategyFor) -- the registry declares WHICH strategy applies
 * to a value_type, this file is what actually DOES the normalization.
 */

export type NormalizationStrategy =
  | "money_to_decimal"
  | "decimal_parse"
  | "percentage_to_decimal"
  | "integer_parse"
  | "date_to_iso"
  | "boolean_parse"
  | "address_normalize"
  | "string_trim";

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
}

export function normalizeMoney(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const cleaned = String(raw).replace(/[$,\s]/g, "");
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? num.toFixed(2) : null;
}

export function normalizeDecimal(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const cleaned = String(raw).replace(/[,\s]/g, "");
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? String(num) : null;
}

export function normalizePercentage(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const cleaned = String(raw).replace(/[%\s]/g, "");
  const num = Number.parseFloat(cleaned);
  return Number.isFinite(num) ? String(num) : null;
}

export function normalizeInteger(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const cleaned = String(raw).replace(/[,\s]/g, "");
  const num = Number.parseInt(cleaned, 10);
  return Number.isFinite(num) ? String(num) : null;
}

const MONTH_NAMES: Record<string, string> = {
  jan: "01", january: "01", feb: "02", february: "02", mar: "03", march: "03",
  apr: "04", april: "04", may: "05", jun: "06", june: "06", jul: "07", july: "07",
  aug: "08", august: "08", sep: "09", sept: "09", september: "09", oct: "10", october: "10",
  nov: "11", november: "11", dec: "12", december: "12",
};

export function normalizeDate(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  const text = String(raw).trim();

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  const slash = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (slash) {
    let [, m, d, y] = slash;
    if (y.length === 2) y = `20${y}`;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const named = text.match(/^([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (named) {
    const month = MONTH_NAMES[named[1].toLowerCase()];
    if (month) return `${named[3]}-${month}-${named[2].padStart(2, "0")}`;
  }

  return null;
}

const TRUTHY_TEXT = new Set(["true", "yes", "y", "1", "required", "applicable"]);
const FALSY_TEXT = new Set(["false", "no", "n", "0", "not required", "not applicable"]);

export function normalizeBoolean(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  const text = String(raw).trim().toLowerCase();
  if (TRUTHY_TEXT.has(text)) return "true";
  if (FALSY_TEXT.has(text)) return "false";
  return null;
}

export function normalizeAddress(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  return String(raw).replace(/\s+/g, " ").trim();
}

export function normalizeString(raw: unknown): string | null {
  if (isBlank(raw)) return null;
  return String(raw).trim();
}

export function normalizeByStrategy(strategy: NormalizationStrategy | string, raw: unknown): string | null {
  switch (strategy) {
    case "money_to_decimal": return normalizeMoney(raw);
    case "decimal_parse": return normalizeDecimal(raw);
    case "percentage_to_decimal": return normalizePercentage(raw);
    case "integer_parse": return normalizeInteger(raw);
    case "date_to_iso": return normalizeDate(raw);
    case "boolean_parse": return normalizeBoolean(raw);
    case "address_normalize": return normalizeAddress(raw);
    case "string_trim":
    default:
      return normalizeString(raw);
  }
}

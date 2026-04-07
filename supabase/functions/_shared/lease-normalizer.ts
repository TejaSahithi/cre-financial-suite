// @ts-nocheck
/**
 * Lease field normalizer
 *
 * Converts raw AI output (strings with $, commas, "per month" etc.)
 * into clean typed values the frontend and DB can use directly.
 */

// ── Currency / number ────────────────────────────────────────────────────

/**
 * Parse a value that may be:
 *   "$12,000/month"  →  12000
 *   "12,000.00"      →  12000
 *   "3%"             →  3
 *   12000            →  12000
 *   null / ""        →  null
 */
export function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return isNaN(value) ? null : value;

  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;

  // Strip currency symbols, commas, spaces, and trailing text like "/month", "per month", "psf", "sf"
  const cleaned = str
    .replace(/[$€£,\s]/g, "")
    .replace(/\/?(per\s*)?(month|year|sf|sqft|annually|annual)/gi, "")
    .replace(/\s+/g, "")
    .trim();

  // Handle parentheses for negatives: (1000) → -1000
  const negMatch = cleaned.match(/^\((.+)\)$/);
  const numStr = negMatch ? `-${negMatch[1]}` : cleaned;

  // Strip trailing % sign
  const num = parseFloat(numStr.replace(/%$/, ""));
  return isNaN(num) ? null : Math.round(num * 100) / 100;
}

// ── Date ─────────────────────────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const US_RE  = /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/;
const LONG_RE = /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/; // "January 1, 2024"

const MONTH_MAP: Record<string, string> = {
  january:"01", february:"02", march:"03", april:"04",
  may:"05", june:"06", july:"07", august:"08",
  september:"09", october:"10", november:"11", december:"12",
  jan:"01", feb:"02", mar:"03", apr:"04", jun:"06",
  jul:"07", aug:"08", sep:"09", oct:"10", nov:"11", dec:"12",
};

/**
 * Normalize a date value to ISO 8601 (YYYY-MM-DD).
 * Returns null if the value cannot be parsed.
 */
export function parseDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  if (str === "" || str.toLowerCase() === "null") return null;

  // Already ISO
  if (ISO_RE.test(str)) {
    const d = new Date(str + "T00:00:00Z");
    return isNaN(d.getTime()) ? null : str;
  }

  // MM/DD/YYYY or MM-DD-YYYY
  const usMatch = str.match(US_RE);
  if (usMatch) {
    const month = usMatch[1].padStart(2, "0");
    const day   = usMatch[2].padStart(2, "0");
    const year  = usMatch[3];
    const iso = `${year}-${month}-${day}`;
    const d = new Date(iso + "T00:00:00Z");
    return isNaN(d.getTime()) ? null : iso;
  }

  // "January 1, 2024"
  const longMatch = str.match(LONG_RE);
  if (longMatch) {
    const monthNum = MONTH_MAP[longMatch[1].toLowerCase()];
    if (monthNum) {
      const day  = longMatch[2].padStart(2, "0");
      const year = longMatch[3];
      const iso  = `${year}-${monthNum}-${day}`;
      const d = new Date(iso + "T00:00:00Z");
      return isNaN(d.getTime()) ? null : iso;
    }
  }

  return null;
}

// ── Boolean ──────────────────────────────────────────────────────────────

export function parseBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const str = String(value).trim().toLowerCase();
  if (["true", "yes", "1", "y"].includes(str)) return true;
  if (["false", "no", "0", "n"].includes(str)) return false;
  return null;
}

// ── Enum coercion ─────────────────────────────────────────────────────────

export function coerceEnum<T extends string>(
  value: unknown,
  allowed: T[],
  fallback: T | null = null,
): T | null {
  if (value === null || value === undefined) return fallback;
  const str = String(value).trim().toLowerCase().replace(/[\s-]/g, "_");
  const match = allowed.find((a) => a.toLowerCase() === str);
  return match ?? fallback;
}

// ── Main normalizer ───────────────────────────────────────────────────────

export interface NormalizedLease {
  tenant_name:                   string | null;
  lease_start:                   string | null;
  lease_end:                     string | null;
  lease_term_months:             number | null;
  base_rent:                     number | null;
  rent_per_sf:                   number | null;
  total_sf:                      number | null;
  annual_rent:                   number | null;
  escalation_type:               "fixed" | "cpi" | "none" | null;
  escalation_value:              number | null;
  cam_applicable:                boolean | null;
  cam_cap:                       number | null;
  confidence:                    number;
  // extended fields
  lease_type:                    string | null;
  escalation_timing:             string | null;
  free_rent_months:              number | null;
  ti_allowance:                  number | null;
  renewal_options:               string | null;
  renewal_notice_months:         number | null;
  cam_cap_type:                  string | null;
  cam_cap_rate:                  number | null;
  admin_fee_pct:                 number | null;
  gross_up_clause:               boolean | null;
  hvac_responsibility:           string | null;
  percentage_rent:               boolean | null;
  percentage_rent_rate:          number | null;
  property_address:              string | null;
  suite_number:                  string | null;
  confidence_scores:             Record<string, number>;
}

/**
 * Normalize raw AI output into a clean, typed lease object.
 * Handles string numbers, currency strings, date variants, and boolean strings.
 */
export function normalizeLease(raw: Record<string, unknown>): NormalizedLease {
  // Dates — try both old field names (start_date/end_date) and new (lease_start/lease_end)
  const leaseStart = parseDate(raw.lease_start ?? raw.start_date);
  const leaseEnd   = parseDate(raw.lease_end   ?? raw.end_date);

  // Derive lease_term_months if not provided
  let leaseTermMonths = parseNumber(raw.lease_term_months) ?? null;
  if (!leaseTermMonths && leaseStart && leaseEnd) {
    const start = new Date(leaseStart + "T00:00:00Z");
    const end   = new Date(leaseEnd   + "T00:00:00Z");
    const diffMs = end.getTime() - start.getTime();
    if (diffMs > 0) {
      leaseTermMonths = Math.round(diffMs / (1000 * 60 * 60 * 24 * 30.44));
    }
  }

  const baseRent   = parseNumber(raw.base_rent);
  const annualRent = parseNumber(raw.annual_rent);

  // Derive missing rent values
  const derivedAnnual = annualRent ?? (baseRent ? Math.round(baseRent * 12) : null);
  const derivedBase   = baseRent   ?? (annualRent ? Math.round(annualRent / 12) : null);

  const escalationType = coerceEnum(
    raw.escalation_type,
    ["fixed", "cpi", "none"] as const,
    null,
  );

  // escalation_value: prefer escalation_rate, fall back to escalation_value
  const escalationValue = parseNumber(raw.escalation_value ?? raw.escalation_rate);

  // cam_applicable: true if cam_cap_type is not "none" or cam_cap > 0
  let camApplicable = parseBoolean(raw.cam_applicable);
  if (camApplicable === null) {
    const camCapType = String(raw.cam_cap_type ?? "").toLowerCase();
    const camCap     = parseNumber(raw.cam_cap ?? raw.cam_cap_rate);
    if (camCapType && camCapType !== "none") camApplicable = true;
    else if (camCap && camCap > 0) camApplicable = true;
  }

  const camCap = parseNumber(raw.cam_cap ?? raw.cam_cap_rate);

  // Aggregate confidence: average of all confidence_scores, or use top-level confidence
  const rawScores = raw.confidence_scores as Record<string, unknown> | undefined;
  const scores: Record<string, number> = {};
  if (rawScores && typeof rawScores === "object") {
    for (const [k, v] of Object.entries(rawScores)) {
      const n = parseNumber(v);
      if (n !== null) scores[k] = Math.min(100, Math.max(0, Math.round(n)));
    }
  }

  let confidence = parseNumber(raw.confidence) ?? 0;
  if (confidence === 0 && Object.keys(scores).length > 0) {
    const vals = Object.values(scores);
    confidence = Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
  }

  return {
    tenant_name:           typeof raw.tenant_name === "string" ? raw.tenant_name.trim() || null : null,
    lease_start:           leaseStart,
    lease_end:             leaseEnd,
    lease_term_months:     leaseTermMonths,
    base_rent:             derivedBase,
    rent_per_sf:           parseNumber(raw.rent_per_sf),
    total_sf:              parseNumber(raw.total_sf),
    annual_rent:           derivedAnnual,
    escalation_type:       escalationType,
    escalation_value:      escalationValue,
    cam_applicable:        camApplicable,
    cam_cap:               camCap,
    confidence,
    // extended
    lease_type:            typeof raw.lease_type === "string" ? raw.lease_type : null,
    escalation_timing:     typeof raw.escalation_timing === "string" ? raw.escalation_timing : null,
    free_rent_months:      parseNumber(raw.free_rent_months),
    ti_allowance:          parseNumber(raw.ti_allowance),
    renewal_options:       typeof raw.renewal_options === "string" ? raw.renewal_options : null,
    renewal_notice_months: parseNumber(raw.renewal_notice_months),
    cam_cap_type:          typeof raw.cam_cap_type === "string" ? raw.cam_cap_type : null,
    cam_cap_rate:          parseNumber(raw.cam_cap_rate),
    admin_fee_pct:         parseNumber(raw.admin_fee_pct),
    gross_up_clause:       parseBoolean(raw.gross_up_clause),
    hvac_responsibility:   typeof raw.hvac_responsibility === "string" ? raw.hvac_responsibility : null,
    percentage_rent:       parseBoolean(raw.percentage_rent),
    percentage_rent_rate:  parseNumber(raw.percentage_rent_rate),
    property_address:      typeof raw.property_address === "string" ? raw.property_address.trim() || null : null,
    suite_number:          typeof raw.suite_number === "string" ? raw.suite_number.trim() || null : null,
    confidence_scores:     scores,
  };
}

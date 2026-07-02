/**
 * Cross-field validation warnings for Lease Review.
 *
 * All checks are WARNING-ONLY. Nothing here blocks approval, writes to the
 * database, or changes any required-field logic. The returned Map is a pure
 * read of already-extracted row values — it never triggers re-extraction.
 *
 * Each check is guarded: if either input value is missing, null, or
 * unparseable the check is silently skipped (no warning emitted).
 */

import { toIsoDate } from "./criticalDates";
import { isMeaningfulValue, readFieldValue } from "@/lib/leaseReviewSchema";

// ── Private helpers ───────────────────────────────────────────────────────────

function parseMoney(v) {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseIsoDate(v) {
  const iso = toIsoDate(v);
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysBetween(startDate, endDate) {
  return Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000);
}

// Parses a human-readable lease-term string into an integer month count.
// Returns null when the text is absent or doesn't match a recognizable pattern.
// Intentionally conservative — only warns on confirmed parses, never on
// ambiguous text.
function parseLeaseTermText(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const years = s.match(/(\d+(?:\.\d+)?)\s*(?:year|yr)/);
  if (years) return Math.round(Number(years[1]) * 12);
  const months = s.match(/(\d+(?:\.\d+)?)\s*(?:month|mo)/);
  if (months) return Math.round(Number(months[1]));
  // Bare integer treated as months only within a plausible lease-term range.
  const n = Number(s);
  if (Number.isFinite(n) && n > 0 && n <= 720) return Math.round(n);
  return null;
}

function fmtMoney(n) {
  return `$${Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  })}`;
}

function fmtMonths(n) {
  const r = Math.round(n);
  return `${r} month${r === 1 ? "" : "s"}`;
}

function fmtNumber(n) {
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

// Read a field value from the built row first; fall back to readFieldValue
// which probes multiple lease-data paths (extraction_data, workflow_output, etc.).
function getRowValue(rowByKey, lease, key) {
  const row = rowByKey?.get(key);
  const rv = row?.normalized_value ?? row?.value;
  if (isMeaningfulValue(rv)) return rv;
  return readFieldValue(lease, key);
}

// Some responsibility fields are keyed differently between the canonical
// review schema (responsibility_taxes) and backend/extraction output
// (tax_responsibility). Try the canonical key first, then fall back to the
// alias key directly in rowByKey before reading from the raw lease object.
function getAliasedRowValue(rowByKey, lease, canonicalKey, aliasKey) {
  const canonicalVal = getRowValue(rowByKey, lease, canonicalKey);
  if (isMeaningfulValue(canonicalVal)) return canonicalVal;
  const row = rowByKey?.get(aliasKey);
  const rv = row?.normalized_value ?? row?.value;
  if (isMeaningfulValue(rv)) return rv;
  return readFieldValue(lease, aliasKey);
}

function normalizeForMatch(raw) {
  return String(raw ?? "").toLowerCase().replace(/_/g, " ").trim();
}

// Classifies a lease_type value for CAM/responsibility consistency checks.
// Conservative: only recognizes the two lease types the checks care about;
// modified gross, double/single net, absolute net, etc. return null (skip).
function classifyLeaseTypeForCam(raw) {
  const s = normalizeForMatch(raw);
  if (!s) return null;
  if (/triple net|\bnnn\b/.test(s)) return "triple_net";
  if (/full service/.test(s)) return "full_service_gross";
  if (/\bgross\b/.test(s) && !/modified/.test(s)) return "full_service_gross";
  return null;
}

// Classifies a responsibility field value as Landlord/Tenant. Shared,
// pro-rata, or unrecognized text returns null (ambiguous — skip K1/K2).
function classifyResponsibility(raw) {
  const s = normalizeForMatch(raw);
  if (!s) return null;
  if (/landlord|lessor/.test(s)) return "Landlord";
  if (/tenant|lessee/.test(s)) return "Tenant";
  return null;
}

// Parses an escalation rate stored in any of several formats:
//   3  |  "3"  |  "3%"  |  3.5  |  0.03  →  returns a percentage (3.0, 3.5, 3.0)
// Values ≥ 1 are assumed to already be a percentage.
// Values < 1 are assumed to be a decimal fraction (0.03 → 3%).
// Returns null for absent, non-numeric, or negative values.
function parseEscalationRate(v) {
  if (v == null || v === "") return null;
  const s = String(v).replace(/[%$,\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  return n < 1 ? n * 100 : n;
}

// Returns true if the escalation_timing value represents an annual cadence.
// Matches all three canonical leaseFieldOptions slugs (lease_anniversary,
// calendar_year, fiscal_year) since all are once-per-year, plus free-form
// text containing "annual".
function isAnnualEscalationTiming(raw) {
  const s = normalizeForMatch(raw);
  if (!s) return false;
  if (s === "lease anniversary" || s === "calendar year" || s === "fiscal year") return true;
  return /annual/.test(s);
}

function addWarning(map, fieldKey, check, reason) {
  if (!map.has(fieldKey)) map.set(fieldKey, []);
  map.get(fieldKey).push({ check, reason });
}

// ── Exported validator ────────────────────────────────────────────────────────

/**
 * Run all Phase-3A cross-field validation checks.
 *
 * @param {Map<string, object>} rowByKey - Canonical row map from LeaseReview
 *   (keys are schema field keys, e.g. "monthly_rent", "commencement_date").
 * @param {object} lease - Raw leaseFull object for readFieldValue fallback.
 * @returns {Map<string, Array<{check: string, reason: string}>>}
 *   One entry per implicated field key; each entry is an array of warnings.
 */
export function validateCrossFieldWarnings(rowByKey, lease) {
  const warnings = new Map();

  // ── G1: Monthly rent × 12 should approximately equal annual rent ────────────
  const monthlyRent = parseMoney(getRowValue(rowByKey, lease, "monthly_rent"));
  const annualRent  = parseMoney(getRowValue(rowByKey, lease, "annual_rent"));
  if (monthlyRent != null && annualRent != null && annualRent > 0) {
    const computed = monthlyRent * 12;
    const relDiff  = Math.abs(computed - annualRent) / annualRent;
    if (relDiff > 0.02) {
      const reason =
        `Monthly rent × 12 (${fmtMoney(computed)}) does not match annual rent ` +
        `(${fmtMoney(annualRent)}). Verify both values.`;
      addWarning(warnings, "monthly_rent", "G1", reason);
      addWarning(warnings, "annual_rent",  "G1", reason);
    }
  }

  // ── H1 / H2 / H3: Date order, short-term, and term-text alignment ──────────
  const commencementRaw = getRowValue(rowByKey, lease, "commencement_date");
  const expirationRaw   = getRowValue(rowByKey, lease, "expiration_date");
  const commencementDate = parseIsoDate(commencementRaw);
  const expirationDate   = parseIsoDate(expirationRaw);

  if (commencementDate && expirationDate) {
    const days    = daysBetween(commencementDate, expirationDate);
    const commIso = toIsoDate(commencementRaw);
    const exprIso = toIsoDate(expirationRaw);

    if (days <= 0) {
      // H1: commencement on or after expiration
      const reason =
        `Commencement date (${commIso}) is on or after expiration date (${exprIso}). ` +
        `Lease term cannot be zero or negative.`;
      addWarning(warnings, "commencement_date", "H1", reason);
      addWarning(warnings, "expiration_date",   "H1", reason);
    } else {
      if (days < 30) {
        // H2: positive but suspiciously short
        const reason =
          `Computed lease term is only ${days} day${days === 1 ? "" : "s"} ` +
          `(${commIso} → ${exprIso}). Verify the expiration year is correct.`;
        addWarning(warnings, "commencement_date", "H2", reason);
        addWarning(warnings, "expiration_date",   "H2", reason);
      }

      // H3: stated lease_term text vs. computed date span
      const leaseTermRaw  = getRowValue(rowByKey, lease, "lease_term");
      const statedMonths  = parseLeaseTermText(leaseTermRaw);
      if (statedMonths != null) {
        const actualMonths = days / 30.44;
        if (Math.abs(actualMonths - statedMonths) > 2) {
          const reason =
            `Stated lease term (${fmtMonths(statedMonths)}) differs from the ` +
            `commencement → expiration span (${fmtMonths(actualMonths)}). ` +
            `Verify dates or the lease term field.`;
          addWarning(warnings, "lease_term",        "H3", reason);
          addWarning(warnings, "commencement_date", "H3", reason);
          addWarning(warnings, "expiration_date",   "H3", reason);
        }
      }
    }
  }

  // ── I1: Tenant square footage should not exceed building/property RSF ──────
  const tenantSf   = parseMoney(getRowValue(rowByKey, lease, "square_footage"));
  const buildingSf = parseMoney(getRowValue(rowByKey, lease, "building_rsf"));
  if (tenantSf != null && tenantSf > 0 && buildingSf != null && buildingSf > 0) {
    if (tenantSf > buildingSf) {
      const reason =
        `Tenant square footage (${fmtNumber(tenantSf)} SF) exceeds building/property ` +
        `square footage (${fmtNumber(buildingSf)} SF). Verify both values.`;
      addWarning(warnings, "square_footage", "I1", reason);
      addWarning(warnings, "building_rsf",   "I1", reason);
    }
  }

  // ── K1 / K2: Lease type vs. expense responsibility consistency ───────────────
  const RESP_FIELDS = [
    { canonical: "responsibility_taxes",     alias: "tax_responsibility",     label: "Taxes Responsibility" },
    { canonical: "responsibility_insurance", alias: "insurance_responsibility", label: "Insurance Responsibility" },
    { canonical: "responsibility_repairs",   alias: "maintenance_responsibility", label: "Repairs & Maintenance Responsibility" },
  ];

  const leaseTypeRaw  = getRowValue(rowByKey, lease, "lease_type");
  const leaseTypeKind = classifyLeaseTypeForCam(leaseTypeRaw);

  if (leaseTypeKind) {
    for (const { canonical, alias, label } of RESP_FIELDS) {
      const respRaw = getAliasedRowValue(rowByKey, lease, canonical, alias);
      const party   = classifyResponsibility(respRaw);
      if (!party) continue;

      if (leaseTypeKind === "full_service_gross" && party === "Tenant") {
        const reason =
          `This lease appears to be Full Service/Gross, but ${label} is marked Tenant. ` +
          `Verify whether this expense is separately recoverable or included in base rent.`;
        addWarning(warnings, canonical,    "K1", reason);
        addWarning(warnings, "lease_type", "K1", reason);
      } else if (leaseTypeKind === "triple_net" && party === "Landlord") {
        const reason =
          `This lease appears to be Triple Net/NNN, but ${label} is marked Landlord. ` +
          `Verify the expense responsibility clause.`;
        addWarning(warnings, canonical,    "K2", reason);
        addWarning(warnings, "lease_type", "K2", reason);
      }
    }
  }

  // ── J1: Security deposit evidence mismatch ──────────────────────────────────
  // Reads consistency_warning set by Phase 2F on the already-built canonical row.
  // Does not rerun source-matching logic; just surfaces a field-specific message
  // alongside the generic "Evidence mismatch" badge that Phase 2F already shows.
  const sdRow = rowByKey?.get("security_deposit");
  if (sdRow?.consistency_warning === true) {
    addWarning(
      warnings,
      "security_deposit",
      "J1",
      "Security deposit value is not confirmed by the cited source text. Verify the security deposit clause.",
    );
  }

  // ── L1: Escalation rate unusually high (> 25%) ──────────────────────────────
  const escalationRatePct = parseEscalationRate(getRowValue(rowByKey, lease, "escalation_rate"));
  if (escalationRatePct != null && escalationRatePct > 25) {
    addWarning(
      warnings,
      "escalation_rate",
      "L1",
      `Escalation rate of ${escalationRatePct % 1 === 0 ? escalationRatePct : escalationRatePct.toFixed(2)}% is unusually high. Verify the escalation clause.`,
    );
  }

  // ── L2: Annual escalation timing with lease term under 12 months ────────────
  const escalationTimingRaw = getRowValue(rowByKey, lease, "escalation_timing");
  if (isAnnualEscalationTiming(escalationTimingRaw) && commencementDate && expirationDate) {
    const termDays = daysBetween(commencementDate, expirationDate);
    if (termDays > 0 && termDays < 365) {
      addWarning(
        warnings,
        "escalation_timing",
        "L2",
        "Escalation timing is annual, but lease term appears to be under 12 months. Verify timing or term.",
      );
    }
  }

  // ── L3: Escalation date outside lease term ───────────────────────────────────
  const escalationDateRaw  = getRowValue(rowByKey, lease, "escalation_date");
  const escalationDateDate = parseIsoDate(escalationDateRaw);
  if (escalationDateDate && commencementDate && expirationDate) {
    const termDays = daysBetween(commencementDate, expirationDate);
    if (termDays > 0) {
      const escalIso = toIsoDate(escalationDateRaw);
      const commIso  = toIsoDate(commencementRaw);
      const exprIso  = toIsoDate(expirationRaw);
      if (escalationDateDate < commencementDate || escalationDateDate > expirationDate) {
        addWarning(
          warnings,
          "escalation_date",
          "L3",
          `Escalation date (${escalIso}) falls outside the lease term (${commIso} → ${exprIso}). Verify escalation schedule.`,
        );
      }
    }
  }

  return warnings;
}

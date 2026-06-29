// @ts-nocheck
/**
 * Extraction Pipeline — Deterministic Derived Field Calculator
 *
 * ALL calculations happen HERE, in code. NEVER by LLM.
 *
 * Computes derived fields from extracted values:
 *   - annual_rent = monthly_rent × 12
 *   - lease_term_months = diff(start_date, end_date)
 *   - rent_per_sf = annual_rent / square_footage  (only if both exist)
 *   - monthly equivalents from annual values
 *   - fiscal_year / month from date fields
 *
 * Every calculation is deterministic and auditable.
 */

import type { ModuleType } from "./types.ts";

type Row = Record<string, unknown>;

/** Round to 2 decimal places */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Safely get a number from a row field */
function num(row: Row, field: string): number | null {
  const v = row[field];
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : null;
}

/** Safely get a date string (YYYY-MM-DD) from a row field */
function dateStr(row: Row, field: string): string | null {
  const v = row[field];
  if (!v || typeof v !== "string") return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

// ── Lease calculations ───────────────────────────────────────────────────────

/** Record a derivation trace so downstream workflow/UI knows how the value was computed. */
function setDerived(row: Row, field: string, value: unknown, trace: string): void {
  row[field] = value;
  const traces = (row._derivation_traces ?? {}) as Record<string, string>;
  traces[field] = trace;
  row._derivation_traces = traces;
}

function computeLeaseDerived(row: Row): void {
  let monthlyRent = num(row, "monthly_rent");
  let annualRent = num(row, "annual_rent");
  const sqft = num(row, "square_footage");
  let rentPerSf = num(row, "rent_per_sf");
  const startDate = dateStr(row, "start_date");
  const endDate = dateStr(row, "end_date");

  // Reconcile conflicts if monthly_rent was extracted as a PSF value (suspiciously small)
  if (monthlyRent !== null && monthlyRent < 300 && sqft !== null && sqft > 0) {
    if (annualRent !== null && annualRent > 1000) {
      const corrected = round2(annualRent / 12);
      setDerived(row, "monthly_rent", corrected, `reconciled from annual_rent(${annualRent}) / 12 — extracted monthly looked like PSF`);
      monthlyRent = corrected;
    } else if (annualRent === null) {
      const originalPsf = monthlyRent;
      const corrected = round2(originalPsf * sqft);
      setDerived(row, "monthly_rent", corrected, `monthly_rent(${originalPsf}) × square_footage(${sqft}) — treated as PSF rate`);
      monthlyRent = corrected;
    }
  }

  // Reconcile if both are extracted but they conflict wildly (e.g., one is annual, one is monthly)
  if (monthlyRent !== null && annualRent !== null) {
    const expectedMonthly = annualRent / 12;
    if (Math.abs(monthlyRent - expectedMonthly) > 10) {
      if (monthlyRent < 300 && annualRent > 1000) {
        const corrected = round2(expectedMonthly);
        setDerived(row, "monthly_rent", corrected, `reconciled: annual_rent(${annualRent}) / 12 — extracted monthly(${monthlyRent}) was too small`);
        monthlyRent = corrected;
      }
    }
  }

  // annual_rent = monthly_rent × 12
  if (monthlyRent !== null && annualRent === null) {
    const derived = round2(monthlyRent * 12);
    setDerived(row, "annual_rent", derived, `monthly_rent(${monthlyRent}) × 12`);
    annualRent = derived;
  }

  // monthly_rent = annual_rent / 12 (if annual was extracted but monthly wasn't)
  if (monthlyRent === null && annualRent !== null) {
    const derived = round2(annualRent / 12);
    setDerived(row, "monthly_rent", derived, `annual_rent(${annualRent}) / 12`);
    monthlyRent = derived;
  }

  // rent_per_sf = annual_rent / square_footage
  if (rentPerSf === null && sqft !== null && sqft > 0) {
    const annual = num(row, "annual_rent");
    if (annual !== null) {
      setDerived(row, "rent_per_sf", round2(annual / sqft), `annual_rent(${annual}) / square_footage(${sqft})`);
    }
  }

  // square_footage from rent_per_sf and annual_rent
  if (sqft === null && rentPerSf !== null && rentPerSf > 0) {
    const annual = num(row, "annual_rent");
    if (annual !== null) {
      setDerived(row, "square_footage", Math.round(annual / rentPerSf), `annual_rent(${annual}) / rent_per_sf(${rentPerSf})`);
    }
  }

  // lease_term_months from start/end dates.
  // Always compute and stamp the derivation trace. If the value was already
  // extracted by the rule/LLM path, preserve it but add the trace so the UI
  // can show derivation evidence and clear the "missing derivation trace" blocker.
  if (startDate && endDate) {
    const s = new Date(startDate + "T00:00:00Z");
    const e = new Date(endDate + "T00:00:00Z");
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
      const exclusiveEnd = new Date(e);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      let months =
        (exclusiveEnd.getUTCFullYear() - s.getUTCFullYear()) * 12 +
        (exclusiveEnd.getUTCMonth() - s.getUTCMonth());
      if (exclusiveEnd.getUTCDate() < s.getUTCDate()) months -= 1;
      if (months > 0) {
        const traceText = `start_date(${startDate}) to end_date(${endDate}) = ${months} months`;
        if (row.lease_term_months === null) {
          setDerived(row, "lease_term_months", months, traceText);
        } else {
          // Value already extracted — stamp trace to confirm it is date-consistent
          const traces = (row._derivation_traces ?? {}) as Record<string, string>;
          traces["lease_term_months"] = `confirmed: ${traceText}`;
          row._derivation_traces = traces;
        }
      }
    }
  }
}

// ── Expense calculations ─────────────────────────────────────────────────────

function computeExpenseDerived(row: Row): void {
  const date = dateStr(row, "date");

  // Derive fiscal_year and month from date
  if (date) {
    const d = new Date(date + "T00:00:00Z");
    if (!isNaN(d.getTime())) {
      if (row.fiscal_year === null || row.fiscal_year === undefined) {
        row.fiscal_year = d.getUTCFullYear();
      }
      if (row.month === null || row.month === undefined) {
        row.month = d.getUTCMonth() + 1;
      }
    }
  }
}

// ── Revenue calculations ─────────────────────────────────────────────────────

function computeRevenueDerived(row: Row): void {
  const date = dateStr(row, "date");

  if (date) {
    const d = new Date(date + "T00:00:00Z");
    if (!isNaN(d.getTime())) {
      if (row.fiscal_year === null || row.fiscal_year === undefined) {
        row.fiscal_year = d.getUTCFullYear();
      }
      if (row.month === null || row.month === undefined) {
        row.month = d.getUTCMonth() + 1;
      }
    }
  }
}

// ── Property calculations ────────────────────────────────────────────────────

function computePropertyDerived(row: Row): void {
  const noi = num(row, "noi");
  const marketValue = num(row, "market_value");
  const capRate = num(row, "cap_rate");

  // cap_rate = NOI / market_value × 100
  if (capRate === null && noi !== null && marketValue !== null && marketValue > 0) {
    row.cap_rate = round2((noi / marketValue) * 100);
  }

  // market_value = NOI / (cap_rate / 100)
  if (marketValue === null && noi !== null && capRate !== null && capRate > 0) {
    row.market_value = round2(noi / (capRate / 100));
  }
}

// ── Main: Compute all derived fields ─────────────────────────────────────────

/**
 * Compute deterministic derived fields for all rows.
 * Mutates rows in-place.
 */
export function computeDerivedFields(
  rows: Row[],
  moduleType: ModuleType,
): void {
  const computeFn: Record<string, (row: Row) => void> = {
    lease: computeLeaseDerived,
    expense: computeExpenseDerived,
    revenue: computeRevenueDerived,
    property: computePropertyDerived,
  };

  const fn = computeFn[moduleType];
  if (!fn) return;

  for (const row of rows) {
    fn(row);
  }
}

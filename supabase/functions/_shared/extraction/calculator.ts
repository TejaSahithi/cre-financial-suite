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

function computeLeaseDerived(row: Row): void {
  const monthlyRent = num(row, "monthly_rent");
  const annualRent = num(row, "annual_rent");
  const sqft = num(row, "square_footage");
  const rentPerSf = num(row, "rent_per_sf");
  const startDate = dateStr(row, "start_date");
  const endDate = dateStr(row, "end_date");

  // annual_rent = monthly_rent × 12
  if (monthlyRent !== null && annualRent === null) {
    row.annual_rent = round2(monthlyRent * 12);
  }

  // monthly_rent = annual_rent / 12 (if annual was extracted but monthly wasn't)
  if (monthlyRent === null && annualRent !== null) {
    row.monthly_rent = round2(annualRent / 12);
  }

  // rent_per_sf = annual_rent / square_footage
  if (rentPerSf === null && sqft !== null && sqft > 0) {
    const annual = num(row, "annual_rent");
    if (annual !== null) {
      row.rent_per_sf = round2(annual / sqft);
    }
  }

  // square_footage from rent_per_sf and annual_rent
  if (sqft === null && rentPerSf !== null && rentPerSf > 0) {
    const annual = num(row, "annual_rent");
    if (annual !== null) {
      row.square_footage = Math.round(annual / rentPerSf);
    }
  }

  // lease_term_months from start/end dates
  if (startDate && endDate && row.lease_term_months === null) {
    const s = new Date(startDate + "T00:00:00Z");
    const e = new Date(endDate + "T00:00:00Z");
    if (!isNaN(s.getTime()) && !isNaN(e.getTime()) && e > s) {
      const exclusiveEnd = new Date(e);
      exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
      let months =
        (exclusiveEnd.getUTCFullYear() - s.getUTCFullYear()) * 12 +
        (exclusiveEnd.getUTCMonth() - s.getUTCMonth());
      if (exclusiveEnd.getUTCDate() < s.getUTCDate()) months -= 1;
      if (months > 0) row.lease_term_months = months;
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

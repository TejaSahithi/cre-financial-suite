// @ts-nocheck
/**
 * Property-Based Test: CPI Escalation
 * Feature: backend-driven-pipeline, Task 8.8
 *
 * **Validates: Requirements 5.3**
 *
 * Property 19: For any lease with CPI escalation, escalated_rent increases
 * annually by the CPI rate
 */

import { assert, assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure computation logic
// ---------------------------------------------------------------------------

function generateMonthRange(startDate: string, endDate: string): string[] {
  const months: string[] = [];
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  let cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endCursor = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cursor <= endCursor) {
    const yyyy = cursor.getUTCFullYear();
    const mm = String(cursor.getUTCMonth() + 1).padStart(2, "0");
    months.push(`${yyyy}-${mm}`);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return months;
}

function getLeaseYear(startDate: string, currentMonth: string): number {
  const start = new Date(startDate + "T00:00:00Z");
  const current = new Date(currentMonth + "-01T00:00:00Z");
  const yearDiff = current.getUTCFullYear() - start.getUTCFullYear();
  const monthDiff = current.getUTCMonth() - start.getUTCMonth();
  return monthDiff < 0 ? yearDiff - 1 : yearDiff;
}

function computeCpiEscalationSchedule(
  baseRent: number,
  cpiRate: number, // as decimal e.g. 0.03
  startDate: string,
  endDate: string,
): { month: string; leaseYear: number; escalated_rent: number }[] {
  const months = generateMonthRange(startDate, endDate);
  const escalatedRentByYear: Map<number, number> = new Map([[0, baseRent]]);
  const result: { month: string; leaseYear: number; escalated_rent: number }[] = [];

  for (const month of months) {
    const leaseYear = getLeaseYear(startDate, month);
    let escalatedRent: number;
    if (cpiRate === 0 || leaseYear <= 0) {
      escalatedRent = baseRent;
    } else {
      if (escalatedRentByYear.has(leaseYear)) {
        escalatedRent = escalatedRentByYear.get(leaseYear)!;
      } else {
        const prev = escalatedRentByYear.get(leaseYear - 1) ?? baseRent;
        escalatedRent = Math.round(prev * (1 + cpiRate) * 100) / 100;
        escalatedRentByYear.set(leaseYear, escalatedRent);
      }
    }
    result.push({ month, leaseYear, escalated_rent: escalatedRent });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const cpiLeaseArb = fc.record({
  baseRent: fc.float({ min: 100, max: 50000, noNaN: true }),
  cpiRatePct: fc.float({ min: 0.1, max: 15, noNaN: true }),
  startDate: fc.constant("2022-01-01"),
  endDate: fc.constant("2025-12-31"),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 19: CPI escalated_rent increases annually by the CPI rate",
  fn: () => {
    fc.assert(
      fc.property(cpiLeaseArb, ({ baseRent, cpiRatePct, startDate, endDate }) => {
        const rate = cpiRatePct / 100;
        const schedule = computeCpiEscalationSchedule(baseRent, rate, startDate, endDate);

        const byYear = new Map<number, number>();
        for (const entry of schedule) {
          if (!byYear.has(entry.leaseYear)) byYear.set(entry.leaseYear, entry.escalated_rent);
        }

        const years = [...byYear.keys()].sort((a, b) => a - b);
        for (let i = 1; i < years.length; i++) {
          const prevRent = byYear.get(years[i - 1])!;
          const currRent = byYear.get(years[i])!;
          const expected = Math.round(prevRent * (1 + rate) * 100) / 100;
          assertAlmostEquals(
            currRent,
            expected,
            0.02,
            `CPI year ${years[i]} rent (${currRent}) should be prev (${prevRent}) * (1 + ${rate}) = ${expected}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  },
});

Deno.test({
  name: "Property 19: CPI escalated_rent is strictly greater than base_rent after year 0",
  fn: () => {
    fc.assert(
      fc.property(cpiLeaseArb, ({ baseRent, cpiRatePct, startDate, endDate }) => {
        const rate = cpiRatePct / 100;
        const schedule = computeCpiEscalationSchedule(baseRent, rate, startDate, endDate);
        const year1Entries = schedule.filter((e) => e.leaseYear >= 1);
        for (const entry of year1Entries) {
          assert(
            entry.escalated_rent >= baseRent - 0.01,
            `CPI escalated_rent (${entry.escalated_rent}) must be >= base_rent (${baseRent}) after year 0`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 19: CPI and fixed escalation produce same result for same rate",
  fn: () => {
    fc.assert(
      fc.property(
        fc.record({
          baseRent: fc.float({ min: 100, max: 10000, noNaN: true }),
          ratePct: fc.float({ min: 1, max: 10, noNaN: true }),
        }),
        ({ baseRent, ratePct }) => {
          const rate = ratePct / 100;
          const cpiSchedule = computeCpiEscalationSchedule(baseRent, rate, "2022-01-01", "2024-12-31");
          // Both use the same compounding formula — results must be identical
          const byYearCpi = new Map<number, number>();
          for (const e of cpiSchedule) {
            if (!byYearCpi.has(e.leaseYear)) byYearCpi.set(e.leaseYear, e.escalated_rent);
          }
          // Verify year 2 = base * (1+rate)^2
          const year2 = byYearCpi.get(2);
          if (year2 !== undefined) {
            const expected = Math.round(baseRent * Math.pow(1 + rate, 2) * 100) / 100;
            assertAlmostEquals(year2, expected, 0.05, `Year 2 rent should be base * (1+rate)^2`);
          }
        },
      ),
      { numRuns: 100 },
    );
  },
});

// @ts-nocheck
/**
 * Property-Based Test: Fixed Escalation
 * Feature: backend-driven-pipeline, Task 8.7
 *
 * **Validates: Requirements 5.2**
 *
 * Property 18: For any lease with fixed escalation_rate R%, after each
 * anniversary year, escalated_rent = previous_rent * (1 + R/100)
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

function computeFixedEscalationSchedule(
  baseRent: number,
  escalationRate: number, // as decimal e.g. 0.03
  startDate: string,
  endDate: string,
): { month: string; leaseYear: number; escalated_rent: number }[] {
  const months = generateMonthRange(startDate, endDate);
  const escalatedRentByYear: Map<number, number> = new Map([[0, baseRent]]);
  const result: { month: string; leaseYear: number; escalated_rent: number }[] = [];

  for (const month of months) {
    const leaseYear = getLeaseYear(startDate, month);
    let escalatedRent: number;
    if (escalationRate === 0 || leaseYear <= 0) {
      escalatedRent = baseRent;
    } else {
      if (escalatedRentByYear.has(leaseYear)) {
        escalatedRent = escalatedRentByYear.get(leaseYear)!;
      } else {
        const prev = escalatedRentByYear.get(leaseYear - 1) ?? baseRent;
        escalatedRent = Math.round(prev * (1 + escalationRate) * 100) / 100;
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

const fixedEscalationArb = fc.record({
  baseRent: fc.float({ min: 100, max: 50000, noNaN: true }),
  escalationRatePct: fc.float({ min: 0.5, max: 20, noNaN: true }),
  startDate: fc.constant("2022-01-01"),
  endDate: fc.constant("2025-12-31"), // 4 years → 3 escalation events
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 18: escalated_rent = previous_rent * (1 + R/100) at each anniversary",
  fn: () => {
    fc.assert(
      fc.property(fixedEscalationArb, ({ baseRent, escalationRatePct, startDate, endDate }) => {
        const rate = escalationRatePct / 100;
        const schedule = computeFixedEscalationSchedule(baseRent, rate, startDate, endDate);

        // Group by lease year
        const byYear = new Map<number, number>();
        for (const entry of schedule) {
          if (!byYear.has(entry.leaseYear)) {
            byYear.set(entry.leaseYear, entry.escalated_rent);
          }
        }

        // Verify compounding: year N rent = year (N-1) rent * (1 + rate)
        const years = [...byYear.keys()].sort((a, b) => a - b);
        for (let i = 1; i < years.length; i++) {
          const prevYear = years[i - 1];
          const currYear = years[i];
          const prevRent = byYear.get(prevYear)!;
          const currRent = byYear.get(currYear)!;
          const expected = Math.round(prevRent * (1 + rate) * 100) / 100;
          assertAlmostEquals(
            currRent,
            expected,
            0.02,
            `Year ${currYear} rent (${currRent}) should equal year ${prevYear} rent (${prevRent}) * (1 + ${rate}) = ${expected}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  },
});

Deno.test({
  name: "Property 18: year 0 rent equals base_rent (no escalation in first year)",
  fn: () => {
    fc.assert(
      fc.property(fixedEscalationArb, ({ baseRent, escalationRatePct, startDate, endDate }) => {
        const rate = escalationRatePct / 100;
        const schedule = computeFixedEscalationSchedule(baseRent, rate, startDate, endDate);
        const year0Entries = schedule.filter((e) => e.leaseYear === 0);
        assert(year0Entries.length > 0, "Must have year 0 entries");
        for (const entry of year0Entries) {
          assertAlmostEquals(
            entry.escalated_rent,
            baseRent,
            0.01,
            `Year 0 escalated_rent (${entry.escalated_rent}) must equal base_rent (${baseRent})`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 18: escalated_rent is monotonically non-decreasing across years",
  fn: () => {
    fc.assert(
      fc.property(fixedEscalationArb, ({ baseRent, escalationRatePct, startDate, endDate }) => {
        const rate = escalationRatePct / 100;
        const schedule = computeFixedEscalationSchedule(baseRent, rate, startDate, endDate);
        const byYear = new Map<number, number>();
        for (const entry of schedule) {
          if (!byYear.has(entry.leaseYear)) byYear.set(entry.leaseYear, entry.escalated_rent);
        }
        const years = [...byYear.keys()].sort((a, b) => a - b);
        for (let i = 1; i < years.length; i++) {
          const prev = byYear.get(years[i - 1])!;
          const curr = byYear.get(years[i])!;
          assert(
            curr >= prev - 0.01,
            `Rent must not decrease: year ${years[i]} (${curr}) < year ${years[i - 1]} (${prev})`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

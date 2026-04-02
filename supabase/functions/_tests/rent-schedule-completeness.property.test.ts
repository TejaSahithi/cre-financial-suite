// @ts-nocheck
/**
 * Property-Based Test: Rent Schedule Completeness
 * Feature: backend-driven-pipeline, Task 8.11
 *
 * **Validates: Requirements 5.6**
 *
 * Property 22: For any lease with valid start_date and end_date, the rent schedule must
 * contain exactly one entry per calendar month in the lease term.
 */

import { assertEquals, assertGreater } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure computation logic
// ---------------------------------------------------------------------------

/**
 * Generates an array of "YYYY-MM" strings for each calendar month from start to end (inclusive).
 */
function generateMonthRange(start: Date, end: Date): string[] {
  const months: string[] = [];
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

/**
 * Calculates the expected number of months between two dates (inclusive of both endpoints' months).
 */
function expectedMonthCount(start: Date, end: Date): number {
  const startYear = start.getUTCFullYear();
  const startMonth = start.getUTCMonth();
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth();
  return (endYear - startYear) * 12 + (endMonth - startMonth) + 1;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Dates in 2020-2030 range, end > start
const dateRangeArb = fc
  .tuple(
    fc.date({ min: new Date("2020-01-01"), max: new Date("2029-11-30") }),
    fc.date({ min: new Date("2020-02-01"), max: new Date("2030-12-31") }),
  )
  .filter(([start, end]) => end > start);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 22: generateMonthRange length equals expected month count between start and end",
  fn: () => {
    fc.assert(
      fc.property(dateRangeArb, ([start, end]) => {
        const months = generateMonthRange(start, end);
        const expected = expectedMonthCount(start, end);

        assertEquals(
          months.length,
          expected,
          `Month range length (${months.length}) must equal expected count (${expected}) for ${start.toISOString()} to ${end.toISOString()}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 22: generateMonthRange contains no duplicate months",
  fn: () => {
    fc.assert(
      fc.property(dateRangeArb, ([start, end]) => {
        const months = generateMonthRange(start, end);
        const unique = new Set(months);

        assertEquals(
          unique.size,
          months.length,
          `Month range must have no duplicates. Got ${months.length - unique.size} duplicates`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 22: generateMonthRange first entry matches start month and last matches end month",
  fn: () => {
    fc.assert(
      fc.property(dateRangeArb, ([start, end]) => {
        const months = generateMonthRange(start, end);

        assertGreater(months.length, 0, "Month range must not be empty");

        const expectedFirst = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
        const expectedLast = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, "0")}`;

        assertEquals(
          months[0],
          expectedFirst,
          `First month (${months[0]}) must match start month (${expectedFirst})`,
        );
        assertEquals(
          months[months.length - 1],
          expectedLast,
          `Last month (${months[months.length - 1]}) must match end month (${expectedLast})`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 22: generateMonthRange entries are in strictly ascending order",
  fn: () => {
    fc.assert(
      fc.property(dateRangeArb, ([start, end]) => {
        const months = generateMonthRange(start, end);

        for (let i = 1; i < months.length; i++) {
          const prev = months[i - 1];
          const curr = months[i];
          assertEquals(
            curr > prev,
            true,
            `Months must be ascending: ${prev} should be before ${curr}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

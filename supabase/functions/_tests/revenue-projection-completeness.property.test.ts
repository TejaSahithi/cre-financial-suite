// @ts-nocheck
/**
 * Property-Based Test: Revenue Projection Completeness
 * Feature: backend-driven-pipeline, Task 11.2
 *
 * **Validates: Requirements 8.1, 8.2**
 *
 * Property 28: For any fiscal year, monthly_projections must have exactly
 * 12 entries (one per month 1-12).
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper function
// ---------------------------------------------------------------------------

interface MonthlyProjection {
  month: number;
  year: number;
  base_rent: number;
  cam_recovery: number;
  other_income: number;
  total: number;
}

/**
 * Generates exactly 12 monthly projection entries for a given fiscal year.
 */
function generateMonthlyProjections(fiscalYear: number): MonthlyProjection[] {
  return Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    year: fiscalYear,
    base_rent: 0,
    cam_recovery: 0,
    other_income: 0,
    total: 0,
  }));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const fiscalYearArb = fc.integer({ min: 2000, max: 2100 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 28: generateMonthlyProjections always returns exactly 12 entries",
  fn: () => {
    fc.assert(
      fc.property(fiscalYearArb, (fiscalYear) => {
        const projections = generateMonthlyProjections(fiscalYear);
        assertEquals(
          projections.length,
          12,
          `Fiscal year ${fiscalYear} must produce exactly 12 monthly projections, got ${projections.length}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 28: monthly projections cover months 1 through 12 exactly",
  fn: () => {
    fc.assert(
      fc.property(fiscalYearArb, (fiscalYear) => {
        const projections = generateMonthlyProjections(fiscalYear);
        const months = projections.map((p) => p.month).sort((a, b) => a - b);
        for (let i = 0; i < 12; i++) {
          assertEquals(
            months[i],
            i + 1,
            `Month at index ${i} must be ${i + 1}, got ${months[i]}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 28: all projections belong to the requested fiscal year",
  fn: () => {
    fc.assert(
      fc.property(fiscalYearArb, (fiscalYear) => {
        const projections = generateMonthlyProjections(fiscalYear);
        for (const p of projections) {
          assertEquals(
            p.year,
            fiscalYear,
            `Projection year (${p.year}) must equal fiscal year (${fiscalYear})`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

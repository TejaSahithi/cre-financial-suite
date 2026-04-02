// @ts-nocheck
/**
 * Property-Based Test: Vacancy Revenue Handling
 * Feature: backend-driven-pipeline, Task 11.3
 *
 * **Validates: Requirements 8.3**
 *
 * Property 29: For any month with no active leases, base_rent must be 0.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

interface Lease {
  id: string;
  start_date: string;
  end_date: string;
  monthly_rent: number;
}

/**
 * Returns leases that are active during the given year/month.
 * A lease is active if: start_date <= month_end AND end_date >= month_start.
 */
function getActiveLeases(leases: Lease[], year: number, month: number): Lease[] {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0)); // last day of month

  return leases.filter((lease) => {
    if (!lease.start_date || !lease.end_date) return false;
    const leaseStart = new Date(lease.start_date + "T00:00:00Z");
    const leaseEnd = new Date(lease.end_date + "T00:00:00Z");
    return leaseStart <= monthEnd && leaseEnd >= monthStart;
  });
}

/**
 * Computes base_rent for a month: sum of monthly_rent for active leases.
 * Returns 0 when no leases are active.
 */
function computeBaseRent(leases: Lease[], year: number, month: number): number {
  const active = getActiveLeases(leases, year, month);
  return active.reduce((sum, l) => sum + l.monthly_rent, 0);
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

// Leases that are entirely outside 2024 (so 2024 is always vacant)
const pastLeaseArb = fc.record({
  id: fc.uuid(),
  start_date: fc.constant("2020-01-01"),
  end_date: fc.constant("2022-12-31"),
  monthly_rent: fc.float({ min: 100, max: 10000, noNaN: true }),
});

const futureLeaseArb = fc.record({
  id: fc.uuid(),
  start_date: fc.constant("2026-01-01"),
  end_date: fc.constant("2027-12-31"),
  monthly_rent: fc.float({ min: 100, max: 10000, noNaN: true }),
});

const vacancyArb = fc.record({
  leases: fc.array(fc.oneof(pastLeaseArb, futureLeaseArb), { minLength: 0, maxLength: 5 }),
  month: fc.integer({ min: 1, max: 12 }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 29: base_rent is 0 when getActiveLeases returns empty",
  fn: () => {
    fc.assert(
      fc.property(vacancyArb, ({ leases, month }) => {
        const year = 2024; // all generated leases are outside 2024
        const active = getActiveLeases(leases, year, month);
        const baseRent = computeBaseRent(leases, year, month);

        if (active.length === 0) {
          assertEquals(
            baseRent,
            0,
            `base_rent must be 0 when no active leases. Got ${baseRent}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 29: empty lease list always produces base_rent of 0",
  fn: () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2000, max: 2100 }),
        fc.integer({ min: 1, max: 12 }),
        (year, month) => {
          const baseRent = computeBaseRent([], year, month);
          assertEquals(baseRent, 0, `Empty lease list must produce base_rent=0, got ${baseRent}`);
        },
      ),
      { numRuns: 100 },
    );
  },
});

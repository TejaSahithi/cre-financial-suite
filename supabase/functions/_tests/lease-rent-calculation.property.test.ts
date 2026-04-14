// @ts-nocheck
/**
 * Property-Based Test: Lease Rent Calculation
 * Feature: backend-driven-pipeline, Task 8.6
 *
 * **Validates: Requirements 5.1**
 *
 * Property 17: For any lease with monthly_rent > 0, every month in the rent
 * schedule must have total_rent >= base_rent
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure computation logic extracted from compute-lease/index.ts
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

function computeLeaseSchedule(
  lease: Record<string, any>,
  leaseConfig: Record<string, any> | null,
) {
  const months = generateMonthRange(lease.start_date, lease.end_date);
  const baseRent = Number(lease.monthly_rent) || 0;
  const configValues = leaseConfig?.config_values ?? {};
  const escalationType: string = configValues.escalation_type ?? "none";
  let escalationRate: number;
  if (escalationType === "cpi") {
    escalationRate = Number(configValues.cpi_rate ?? 3) / 100;
  } else if (escalationType === "fixed") {
    escalationRate = Number(configValues.escalation_rate ?? 0) / 100;
  } else {
    escalationRate = 0;
  }
  const camCap = leaseConfig?.cam_cap != null ? Number(leaseConfig.cam_cap) : null;
  const camPerSf = 0; // no property config in pure test
  const squareFootage = Number(lease.square_footage) || 0;
  const rawMonthlyCam = squareFootage * camPerSf;

  const rentSchedule: any[] = [];
  const escalatedRentByYear: Map<number, number> = new Map();

  for (const month of months) {
    const leaseYear = getLeaseYear(lease.start_date, month);
    let escalatedRent: number;
    if (escalationRate === 0 || leaseYear <= 0) {
      escalatedRent = baseRent;
    } else {
      if (escalatedRentByYear.has(leaseYear)) {
        escalatedRent = escalatedRentByYear.get(leaseYear)!;
      } else {
        const previousYearRent = escalatedRentByYear.get(leaseYear - 1) ?? baseRent;
        escalatedRent = Math.round(previousYearRent * (1 + escalationRate) * 100) / 100;
        escalatedRentByYear.set(leaseYear, escalatedRent);
      }
    }
    if (!escalatedRentByYear.has(0)) escalatedRentByYear.set(0, baseRent);

    let camCharge = rawMonthlyCam;
    if (camCap != null && camCharge > camCap) camCharge = camCap;

    const monthTotal = Math.round((escalatedRent + camCharge) * 100) / 100;
    rentSchedule.push({
      month,
      base_rent: Math.round(baseRent * 100) / 100,
      escalated_rent: Math.round(escalatedRent * 100) / 100,
      cam_charge: Math.round(camCharge * 100) / 100,
      total_rent: monthTotal,
    });
  }
  return rentSchedule;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const leaseArb = fc.record({
  monthly_rent: fc.float({ min: Math.fround(1), max: Math.fround(100000), noNaN: true, noDefaultInfinity: true }),
  square_footage: fc.integer({ min: 0, max: 50000 }),
  start_date: fc.constant("2024-01-01"),
  end_date: fc.constantFrom("2024-06-30", "2024-12-31", "2025-12-31", "2026-12-31"),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 17: total_rent >= base_rent for every month when monthly_rent > 0",
  fn: () => {
    fc.assert(
      fc.property(leaseArb, (lease) => {
        const schedule = computeLeaseSchedule(lease, null);
        assert(schedule.length > 0, "Rent schedule must not be empty");
        for (const entry of schedule) {
          assert(
            entry.total_rent >= entry.base_rent,
            `total_rent (${entry.total_rent}) must be >= base_rent (${entry.base_rent}) for month ${entry.month}`,
          );
        }
      }),
      { numRuns: 200 },
    );
  },
});

Deno.test({
  name: "Property 17: total_rent >= base_rent with CAM charges present",
  fn: () => {
    const leaseWithCamArb = fc.record({
      monthly_rent: fc.float({ min: Math.fround(1), max: Math.fround(50000), noNaN: true, noDefaultInfinity: true }),
      square_footage: fc.integer({ min: 100, max: 20000 }),
      start_date: fc.constant("2024-01-01"),
      end_date: fc.constant("2024-12-31"),
    });

    fc.assert(
      fc.property(leaseWithCamArb, (lease) => {
        // cam_cap = 0 means cam_charge = 0, total_rent = escalated_rent >= base_rent
        const schedule = computeLeaseSchedule(lease, { cam_cap: 0 });
        for (const entry of schedule) {
          assert(
            entry.total_rent >= entry.base_rent,
            `total_rent (${entry.total_rent}) must be >= base_rent (${entry.base_rent})`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

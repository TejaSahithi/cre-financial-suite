// @ts-nocheck
/**
 * Unit Tests: Lease Computation
 * Feature: backend-driven-pipeline, Task 8.12
 *
 * Tests pure lease computation helper functions.
 * Requirements: 5.1, 5.2, 5.4
 */

import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

/**
 * Generates an array of "YYYY-MM" strings from start to end (inclusive).
 */
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

/**
 * Returns the lease year (0-indexed) for a given month relative to the lease start.
 */
function getLeaseYear(startDate: string, currentMonth: string): number {
  const start = new Date(startDate + "T00:00:00Z");
  const current = new Date(currentMonth + "-01T00:00:00Z");
  const yearDiff = current.getUTCFullYear() - start.getUTCFullYear();
  const monthDiff = current.getUTCMonth() - start.getUTCMonth();
  return monthDiff < 0 ? yearDiff - 1 : yearDiff;
}

/**
 * Computes the escalated rent for each month of a lease.
 * escalationType: "none" | "fixed"
 * escalationRate: decimal (e.g. 0.03 for 3%)
 */
function computeRentSchedule(
  baseRent: number,
  startDate: string,
  endDate: string,
  escalationType: "none" | "fixed",
  escalationRate: number,
): { month: string; escalated_rent: number }[] {
  const months = generateMonthRange(startDate, endDate);
  const escalatedRentByYear = new Map<number, number>([[0, baseRent]]);
  const result: { month: string; escalated_rent: number }[] = [];

  for (const month of months) {
    const leaseYear = getLeaseYear(startDate, month);
    let escalatedRent: number;

    if (escalationType === "none" || escalationRate === 0 || leaseYear <= 0) {
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

    result.push({ month, escalated_rent: escalatedRent });
  }

  return result;
}

/**
 * Computes the CAM charge for a month, applying an optional cap.
 * leaseType: "gross" | "triple_net" | "modified_gross"
 * camPerSf: monthly CAM per square foot
 * squareFootage: tenant's square footage
 * camCap: optional monthly cap (null = no cap)
 */
function computeCAMCharge(
  leaseType: string,
  squareFootage: number,
  camPerSf: number,
  camCap: number | null,
): number {
  if (leaseType === "gross") {
    return 0;
  }
  const rawCam = squareFootage * camPerSf;
  if (camCap !== null && rawCam > camCap) {
    return camCap;
  }
  return rawCam;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Lease with no escalation: monthly_rent stays flat for all 12 months
Deno.test("Lease with no escalation: rent stays flat for all 12 months", () => {
  const baseRent = 5000;
  const schedule = computeRentSchedule(baseRent, "2024-01-01", "2024-12-31", "none", 0);

  assertEquals(schedule.length, 12, "Must have 12 monthly entries");
  for (const entry of schedule) {
    assertEquals(
      entry.escalated_rent,
      baseRent,
      `Rent for ${entry.month} must equal base rent ${baseRent}`,
    );
  }
});

// 2. Lease with fixed 3% annual escalation: after 12 months, rent = base * 1.03
Deno.test("Lease with fixed 3% annual escalation: rent after year 1 = base * 1.03", () => {
  const baseRent = 4000;
  const escalationRate = 0.03;
  // 2-year lease: Jan 2024 – Dec 2025
  const schedule = computeRentSchedule(baseRent, "2024-01-01", "2025-12-31", "fixed", escalationRate);

  assertEquals(schedule.length, 24, "Must have 24 monthly entries");

  // Year 0 (months 1-12): rent = baseRent
  const year0Entries = schedule.slice(0, 12);
  for (const entry of year0Entries) {
    assertEquals(entry.escalated_rent, baseRent, `Year 0 rent must equal base rent`);
  }

  // Year 1 (months 13-24): rent = baseRent * 1.03
  const expectedYear1Rent = Math.round(baseRent * 1.03 * 100) / 100;
  const year1Entries = schedule.slice(12, 24);
  for (const entry of year1Entries) {
    assertAlmostEquals(
      entry.escalated_rent,
      expectedYear1Rent,
      0.01,
      `Year 1 rent must equal base * 1.03 = ${expectedYear1Rent}`,
    );
  }
});

// 3. Gross lease: cam_charge = 0 (tenant pays flat rent)
Deno.test("Gross lease: CAM charge is always 0", () => {
  const camCharge = computeCAMCharge("gross", 2000, 1.5, null);
  assertEquals(camCharge, 0, "Gross lease must have zero CAM charge");
});

Deno.test("Gross lease with CAM cap: CAM charge is still 0", () => {
  const camCharge = computeCAMCharge("gross", 2000, 1.5, 500);
  assertEquals(camCharge, 0, "Gross lease must have zero CAM charge even with a cap");
});

// 4. Triple-net lease: cam_charge > 0 when cam_per_sf > 0
Deno.test("Triple-net lease: CAM charge > 0 when cam_per_sf > 0", () => {
  const camCharge = computeCAMCharge("triple_net", 1000, 2.0, null);
  assert(camCharge > 0, `Triple-net lease must have positive CAM charge. Got ${camCharge}`);
  assertEquals(camCharge, 2000, "CAM charge must equal sqft * cam_per_sf = 1000 * 2.0 = 2000");
});

// 5. Lease with CAM cap: cam_charge never exceeds cap
Deno.test("Lease with CAM cap: cam_charge does not exceed cap", () => {
  const squareFootage = 5000;
  const camPerSf = 3.0; // raw = 15000
  const camCap = 8000;

  const camCharge = computeCAMCharge("triple_net", squareFootage, camPerSf, camCap);
  assert(
    camCharge <= camCap,
    `CAM charge (${camCharge}) must not exceed cap (${camCap})`,
  );
  assertEquals(camCharge, camCap, "CAM charge must equal the cap when raw CAM exceeds it");
});

Deno.test("Lease with CAM cap: cam_charge equals raw when below cap", () => {
  const squareFootage = 500;
  const camPerSf = 2.0; // raw = 1000
  const camCap = 5000;

  const camCharge = computeCAMCharge("triple_net", squareFootage, camPerSf, camCap);
  assertEquals(camCharge, 1000, "CAM charge must equal raw amount when below cap");
});

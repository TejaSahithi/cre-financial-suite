// @ts-nocheck
/**
 * Property-Based Test: CAM Cap Enforcement
 * Feature: backend-driven-pipeline, Task 8.9
 *
 * **Validates: Requirements 5.4, 7.3**
 *
 * Property 20: For any lease with cam_cap C, cam_charge in every month
 * must be <= C
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
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

function computeCamCharges(
  squareFootage: number,
  camPerSf: number,
  camCap: number | null,
  startDate: string,
  endDate: string,
): { month: string; cam_charge: number }[] {
  const months = generateMonthRange(startDate, endDate);
  const rawMonthlyCam = squareFootage * camPerSf;
  return months.map((month) => {
    let camCharge = rawMonthlyCam;
    if (camCap != null && camCharge > camCap) camCharge = camCap;
    return { month, cam_charge: Math.round(camCharge * 100) / 100 };
  });
}

// CAM cap enforcement from compute-cam (tenant level)
function applyTenantCamCap(tenantCam: number, camCap: number | null): number {
  if (camCap != null && tenantCam > camCap) return camCap;
  return tenantCam;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const camCapArb = fc.record({
  squareFootage: fc.integer({ min: 100, max: 50000 }),
  camPerSf: fc.float({ min: Math.fround(0.01), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
  camCap: fc.float({ min: Math.fround(0), max: Math.fround(5000), noNaN: true, noDefaultInfinity: true }),
  startDate: fc.constant("2024-01-01"),
  endDate: fc.constant("2024-12-31"),
});

const tenantCamArb = fc.record({
  tenantCam: fc.float({ min: Math.fround(0), max: Math.fround(100000), noNaN: true, noDefaultInfinity: true }),
  camCap: fc.float({ min: Math.fround(0), max: Math.fround(50000), noNaN: true, noDefaultInfinity: true }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 20: cam_charge <= cam_cap for every month in rent schedule",
  fn: () => {
    fc.assert(
      fc.property(camCapArb, ({ squareFootage, camPerSf, camCap, startDate, endDate }) => {
        const schedule = computeCamCharges(squareFootage, camPerSf, camCap, startDate, endDate);
        assert(schedule.length > 0, "Schedule must not be empty");
        for (const entry of schedule) {
          assert(
            entry.cam_charge <= camCap + 0.01,
            `cam_charge (${entry.cam_charge}) must be <= cam_cap (${camCap}) for month ${entry.month}`,
          );
        }
      }),
      { numRuns: 300 },
    );
  },
});

Deno.test({
  name: "Property 20: tenant CAM charge after cap <= cam_cap",
  fn: () => {
    fc.assert(
      fc.property(tenantCamArb, ({ tenantCam, camCap }) => {
        const result = applyTenantCamCap(tenantCam, camCap);
        assert(
          result <= camCap + 0.001,
          `After cap, tenant CAM (${result}) must be <= cam_cap (${camCap})`,
        );
      }),
      { numRuns: 500 },
    );
  },
});

Deno.test({
  name: "Property 20: cam_charge equals raw cam when raw < cam_cap",
  fn: () => {
    fc.assert(
      fc.property(
        fc.record({
          squareFootage: fc.integer({ min: 100, max: 1000 }),
          camPerSf: fc.float({ min: Math.fround(0.01), max: Math.fround(1), noNaN: true, noDefaultInfinity: true }),
          // cap is always larger than raw cam (sqft * camPerSf <= 1000)
          camCap: fc.float({ min: Math.fround(1001), max: Math.fround(100000), noNaN: true, noDefaultInfinity: true }),
        }),
        ({ squareFootage, camPerSf, camCap }) => {
          const rawCam = squareFootage * camPerSf;
          const schedule = computeCamCharges(squareFootage, camPerSf, camCap, "2024-01-01", "2024-03-31");
          for (const entry of schedule) {
            assert(
              Math.abs(entry.cam_charge - Math.round(rawCam * 100) / 100) < 0.01,
              `When raw cam (${rawCam}) < cap (${camCap}), cam_charge should equal raw cam`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  },
});

Deno.test({
  name: "Property 20: cam_charge equals cam_cap when raw cam exceeds cap",
  fn: () => {
    fc.assert(
      fc.property(
        fc.record({
          // raw cam = sqft * camPerSf; ensure raw > cap
          squareFootage: fc.integer({ min: 10000, max: 50000 }),
          camPerSf: fc.float({ min: Math.fround(5), max: Math.fround(10), noNaN: true, noDefaultInfinity: true }),
          camCap: fc.float({ min: Math.fround(1), max: Math.fround(100), noNaN: true, noDefaultInfinity: true }),
        }),
        ({ squareFootage, camPerSf, camCap }) => {
          const schedule = computeCamCharges(squareFootage, camPerSf, camCap, "2024-01-01", "2024-03-31");
          for (const entry of schedule) {
            assert(
              Math.abs(entry.cam_charge - camCap) < 0.01,
              `When raw cam exceeds cap, cam_charge (${entry.cam_charge}) should equal cam_cap (${camCap})`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  },
});

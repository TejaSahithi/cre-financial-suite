// @ts-nocheck
/**
 * Unit Tests: Revenue Projection
 * Feature: backend-driven-pipeline, Task 11.5
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4
 */

import {
  assertEquals,
  assertAlmostEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

interface Lease {
  id: string;
  start_date: string;
  end_date: string;
  monthly_rent: number;
}

interface MonthlyProjection {
  month: number;
  year: number;
  base_rent: number;
  cam_recovery: number;
  other_income: number;
  total: number;
}

function getActiveLeases(leases: Lease[], year: number, month: number): Lease[] {
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd = new Date(Date.UTC(year, month, 0));
  return leases.filter((lease) => {
    if (!lease.start_date || !lease.end_date) return false;
    const leaseStart = new Date(lease.start_date + "T00:00:00Z");
    const leaseEnd = new Date(lease.end_date + "T00:00:00Z");
    return leaseStart <= monthEnd && leaseEnd >= monthStart;
  });
}

function computeMonthlyRevenue(
  leases: Lease[],
  year: number,
  month: number,
  camRecovery: number,
  otherIncome: number,
): MonthlyProjection {
  const active = getActiveLeases(leases, year, month);
  const baseRent = active.reduce((sum, l) => sum + l.monthly_rent, 0);
  const total = baseRent + camRecovery + otherIncome;
  return { month, year, base_rent: baseRent, cam_recovery: camRecovery, other_income: otherIncome, total };
}

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

function aggregateRevenue(projections: MonthlyProjection[]): { annual_total: number } {
  const annual_total = projections.reduce((sum, p) => sum + p.total, 0);
  return { annual_total };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Revenue with all income types: base_rent=5000, cam_recovery=500, other=200 → total=5700
Deno.test("Revenue with all income types: total = base_rent + cam_recovery + other_income", () => {
  const leases: Lease[] = [
    { id: "l1", start_date: "2024-01-01", end_date: "2024-12-31", monthly_rent: 5000 },
  ];
  const result = computeMonthlyRevenue(leases, 2024, 6, 500, 200);

  assertAlmostEquals(result.base_rent, 5000, 0.01, "base_rent must be 5000");
  assertAlmostEquals(result.cam_recovery, 500, 0.01, "cam_recovery must be 500");
  assertAlmostEquals(result.other_income, 200, 0.01, "other_income must be 200");
  assertAlmostEquals(result.total, 5700, 0.01, "total must be 5700");
});

// 2. Vacancy period: month with no active leases → base_rent=0, total=0
Deno.test("Vacancy period: no active leases → base_rent=0 and total=0", () => {
  // Lease ended before the test month
  const leases: Lease[] = [
    { id: "l1", start_date: "2023-01-01", end_date: "2023-12-31", monthly_rent: 5000 },
  ];
  const result = computeMonthlyRevenue(leases, 2024, 6, 0, 0);

  assertEquals(result.base_rent, 0, "base_rent must be 0 during vacancy");
  assertEquals(result.total, 0, "total must be 0 during vacancy");
});

Deno.test("Vacancy period: future lease not yet started → base_rent=0", () => {
  const leases: Lease[] = [
    { id: "l1", start_date: "2025-01-01", end_date: "2025-12-31", monthly_rent: 8000 },
  ];
  const result = computeMonthlyRevenue(leases, 2024, 6, 0, 0);
  assertEquals(result.base_rent, 0, "Future lease must not contribute to base_rent");
});

// 3. Revenue aggregation: 12 months of 5000 each → annual_total=60000
Deno.test("Revenue aggregation: 12 months of 5000 each → annual_total=60000", () => {
  const projections: MonthlyProjection[] = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    year: 2024,
    base_rent: 5000,
    cam_recovery: 0,
    other_income: 0,
    total: 5000,
  }));

  const result = aggregateRevenue(projections);
  assertAlmostEquals(result.annual_total, 60000, 0.01, "annual_total must be 60000");
});

Deno.test("Revenue aggregation: mixed monthly totals sum correctly", () => {
  const totals = [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000, 5700];
  const projections: MonthlyProjection[] = totals.map((total, i) => ({
    month: i + 1,
    year: 2024,
    base_rent: total,
    cam_recovery: 0,
    other_income: 0,
    total,
  }));

  const result = aggregateRevenue(projections);
  const expected = totals.reduce((s, t) => s + t, 0);
  assertAlmostEquals(result.annual_total, expected, 0.01, `annual_total must be ${expected}`);
});

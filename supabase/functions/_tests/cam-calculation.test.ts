// @ts-nocheck
/**
 * Unit Tests: CAM Calculation
 * Feature: backend-driven-pipeline, Task 10.4
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4
 */

import {
  assertEquals,
  assertAlmostEquals,
  assert,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Pure helper functions
// ---------------------------------------------------------------------------

interface Tenant {
  id: string;
  square_footage: number;
  cam_cap?: number | null;
}

interface Expense {
  category: string;
  amount: number;
}

/**
 * Computes pro-rata CAM charges for each tenant.
 */
function proRataCAM(
  totalCAM: number,
  tenants: Tenant[],
): { id: string; cam_charge: number }[] {
  const totalSqft = tenants.reduce((sum, t) => sum + t.square_footage, 0);
  if (totalSqft === 0) return tenants.map((t) => ({ id: t.id, cam_charge: 0 }));
  return tenants.map((t) => ({
    id: t.id,
    cam_charge: (t.square_footage / totalSqft) * totalCAM,
  }));
}

/**
 * Applies a per-tenant CAM cap.
 */
function applyCAMCap(rawCam: number, camCap: number | null | undefined): number {
  if (camCap != null && rawCam > camCap) return camCap;
  return rawCam;
}

/**
 * Calculates a tenant's CAM charge, filtering out excluded categories.
 */
function calculateTenantCAM(
  expenses: Expense[],
  excludedCategories: string[],
  sqft: number,
  totalSqft: number,
): number {
  if (totalSqft === 0) return 0;
  const eligible = expenses.filter((e) => !excludedCategories.includes(e.category));
  const pool = eligible.reduce((sum, e) => sum + e.amount, 0);
  return (sqft / totalSqft) * pool;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// 1. Pro-rata with 3 tenants (1000, 2000, 2000 sqft, total 5000)
Deno.test("Pro-rata CAM: 3 tenants with 1000/2000/2000 sqft get correct share of 10000 CAM", () => {
  const totalCAM = 10000;
  const tenants: Tenant[] = [
    { id: "t1", square_footage: 1000 },
    { id: "t2", square_footage: 2000 },
    { id: "t3", square_footage: 2000 },
  ];

  const charges = proRataCAM(totalCAM, tenants);
  const totalSqft = 5000;

  const t1 = charges.find((c) => c.id === "t1")!;
  const t2 = charges.find((c) => c.id === "t2")!;
  const t3 = charges.find((c) => c.id === "t3")!;

  // t1: 1000/5000 * 10000 = 2000
  assertAlmostEquals(t1.cam_charge, 2000, 0.01, "Tenant 1 (1000 sqft) should get 2000");
  // t2: 2000/5000 * 10000 = 4000
  assertAlmostEquals(t2.cam_charge, 4000, 0.01, "Tenant 2 (2000 sqft) should get 4000");
  // t3: 2000/5000 * 10000 = 4000
  assertAlmostEquals(t3.cam_charge, 4000, 0.01, "Tenant 3 (2000 sqft) should get 4000");

  // Sum should equal totalCAM
  const sum = charges.reduce((s, c) => s + c.cam_charge, 0);
  assertAlmostEquals(sum, totalCAM, 0.01, "Sum of charges must equal totalCAM");
});

// 2. CAM cap: tenant with 3000 sqft, cam_cap=2000, raw_cam=3000 → capped at 2000
Deno.test("CAM cap: raw_cam=3000 with cap=2000 is capped at 2000", () => {
  const rawCam = 3000;
  const camCap = 2000;
  const result = applyCAMCap(rawCam, camCap);
  assertEquals(result, 2000, "CAM charge must be capped at 2000");
});

Deno.test("CAM cap: raw_cam=1500 with cap=2000 is not capped", () => {
  const rawCam = 1500;
  const camCap = 2000;
  const result = applyCAMCap(rawCam, camCap);
  assertEquals(result, 1500, "CAM charge below cap must not be modified");
});

Deno.test("CAM cap: null cap means no cap applied", () => {
  const rawCam = 9999;
  const result = applyCAMCap(rawCam, null);
  assertEquals(result, 9999, "No cap should leave charge unchanged");
});

// 3. CAM exclusions: exclude "management" category, verify it's not in tenant's charge
Deno.test("CAM exclusions: excluding 'management' removes it from tenant charge", () => {
  const expenses: Expense[] = [
    { category: "utilities", amount: 3000 },
    { category: "maintenance", amount: 2000 },
    { category: "management", amount: 5000 }, // should be excluded
  ];
  const sqft = 1000;
  const totalSqft = 5000;

  const withExclusion = calculateTenantCAM(expenses, ["management"], sqft, totalSqft);
  const withoutExclusion = calculateTenantCAM(expenses, [], sqft, totalSqft);

  // Without exclusion: (3000+2000+5000) * (1000/5000) = 10000 * 0.2 = 2000
  assertAlmostEquals(withoutExclusion, 2000, 0.01, "Without exclusion should be 2000");

  // With exclusion: (3000+2000) * (1000/5000) = 5000 * 0.2 = 1000
  assertAlmostEquals(withExclusion, 1000, 0.01, "With management excluded should be 1000");

  assert(withExclusion < withoutExclusion, "Exclusion must reduce the CAM charge");
});

Deno.test("CAM exclusions: excluding all categories results in zero charge", () => {
  const expenses: Expense[] = [
    { category: "utilities", amount: 3000 },
    { category: "management", amount: 5000 },
  ];
  const result = calculateTenantCAM(expenses, ["utilities", "management"], 1000, 5000);
  assertEquals(result, 0, "Excluding all categories must result in zero charge");
});

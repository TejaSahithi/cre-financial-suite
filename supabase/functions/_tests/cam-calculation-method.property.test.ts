// @ts-nocheck
/**
 * Property-Based Test: CAM Calculation Method
 * Feature: backend-driven-pipeline, Task 10.2
 *
 * **Validates: Requirements 7.1, 7.2**
 *
 * Property 26: For pro_rata method, sum of all tenant_charges must equal
 * total_cam_pool (within 0.01 tolerance).
 */

import { assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure helper function
// ---------------------------------------------------------------------------

interface Tenant {
  square_footage: number;
}

interface TenantCharge {
  square_footage: number;
  cam_charge: number;
}

/**
 * Computes pro-rata CAM charges for each tenant.
 * Each tenant gets (sqft / totalSqft) * totalCAM.
 */
function proRataCAM(totalCAM: number, tenants: Tenant[]): TenantCharge[] {
  const totalSqft = tenants.reduce((sum, t) => sum + t.square_footage, 0);
  if (totalSqft === 0) {
    return tenants.map((t) => ({ square_footage: t.square_footage, cam_charge: 0 }));
  }
  return tenants.map((t) => ({
    square_footage: t.square_footage,
    cam_charge: (t.square_footage / totalSqft) * totalCAM,
  }));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const tenantArb = fc.record({
  square_footage: fc.integer({ min: 100, max: 10000 }),
});

const proRataArb = fc.record({
  totalCAM: fc.float({ min: 0, max: 1_000_000, noNaN: true }),
  tenants: fc.array(tenantArb, { minLength: 1, maxLength: 20 }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 26: sum of tenant_charges equals total_cam_pool (within 0.01)",
  fn: () => {
    fc.assert(
      fc.property(proRataArb, ({ totalCAM, tenants }) => {
        const charges = proRataCAM(totalCAM, tenants);
        const sumCharges = charges.reduce((sum, c) => sum + c.cam_charge, 0);
        const diff = Math.abs(sumCharges - totalCAM);
        assert(
          diff <= 0.01,
          `Sum of tenant charges (${sumCharges}) must equal totalCAM (${totalCAM}) within 0.01. Diff: ${diff}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

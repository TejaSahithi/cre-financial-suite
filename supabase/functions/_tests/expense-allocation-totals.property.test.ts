// @ts-nocheck
/**
 * Property-Based Test: Expense Allocation Totals
 * Feature: backend-driven-pipeline, Task 9.3
 *
 * **Validates: Requirements 6.2**
 *
 * Property 24: For any property with N tenants (each with square_footage),
 * sum of all tenant pro-rata allocations must equal total_recoverable
 * (within floating point tolerance of 0.01).
 */

import { assertAlmostEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Types and pure computation logic
// ---------------------------------------------------------------------------

interface Tenant {
  id: string;
  square_footage: number;
}

interface TenantAllocation {
  tenant_id: string;
  allocation: number;
}

/**
 * Allocates totalRecoverable across tenants by pro-rata square footage.
 * Each tenant gets (sqft / totalSqft) * totalRecoverable.
 */
function allocateExpenses(totalRecoverable: number, tenants: Tenant[]): TenantAllocation[] {
  if (tenants.length === 0) return [];

  const totalSqft = tenants.reduce((sum, t) => sum + t.square_footage, 0);
  if (totalSqft === 0) {
    // Equal split when no square footage data
    const equalShare = totalRecoverable / tenants.length;
    return tenants.map((t) => ({ tenant_id: t.id, allocation: equalShare }));
  }

  return tenants.map((t) => ({
    tenant_id: t.id,
    allocation: (t.square_footage / totalSqft) * totalRecoverable,
  }));
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const tenantArb = fc.record({
  id: fc.uuid(),
  square_footage: fc.integer({ min: 100, max: 50_000 }),
});

const tenantsArb = fc.array(tenantArb, { minLength: 1, maxLength: 20 });

const totalRecoverableArb = fc.float({ min: 0, max: 1_000_000, noNaN: true });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 24: sum of tenant allocations equals total_recoverable (within 0.01 tolerance)",
  fn: () => {
    fc.assert(
      fc.property(totalRecoverableArb, tenantsArb, (totalRecoverable, tenants) => {
        const allocations = allocateExpenses(totalRecoverable, tenants);
        const allocationSum = allocations.reduce((sum, a) => sum + a.allocation, 0);

        assertAlmostEquals(
          allocationSum,
          totalRecoverable,
          0.01,
          `Sum of allocations (${allocationSum}) must equal total_recoverable (${totalRecoverable})`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 24: each tenant allocation is non-negative",
  fn: () => {
    fc.assert(
      fc.property(totalRecoverableArb, tenantsArb, (totalRecoverable, tenants) => {
        const allocations = allocateExpenses(totalRecoverable, tenants);
        for (const a of allocations) {
          assertAlmostEquals(
            Math.max(0, a.allocation),
            a.allocation,
            0.001,
            `Allocation for tenant ${a.tenant_id} must be non-negative. Got ${a.allocation}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 24: tenants with equal sqft each receive equal allocation",
  fn: () => {
    const totalRecoverable = 9000;
    const tenants: Tenant[] = [
      { id: "t1", square_footage: 1000 },
      { id: "t2", square_footage: 1000 },
      { id: "t3", square_footage: 1000 },
    ];

    const allocations = allocateExpenses(totalRecoverable, tenants);
    for (const a of allocations) {
      assertAlmostEquals(a.allocation, 3000, 0.01, `Each tenant must receive 3000`);
    }
  },
});

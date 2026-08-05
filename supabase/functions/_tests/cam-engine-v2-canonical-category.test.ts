// CAM Enhancement and Budget Readiness Specification v2.0 — section 8.3
// ("Do not compare a category UUID with a text value such as Insurance") and
// section 16 ("Do not use fuzzy text matching as the authoritative
// assignment").
//
// These tests use REALISTIC data shapes: recovery_pool_categories.
// expense_category_id is a public.expense_categories UUID, while
// cam_expense_inputs.category is a human label such as 'Insurance'. The
// pre-existing suites could not catch the production defect because their
// fixtures used one symbolic string ("utilities") for BOTH fields, so a
// label/UUID comparison still matched.
//
// Against the pre-fix engine (which compared c.expense_category_id to
// amount.category) every assertion below about inclusion fails: a
// normally-configured pool -- one that has at least one 'include' rule --
// classified every real expense as `excluded`, driving the pool to 0.00 and
// every tenant's recovery to 0.00.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyCategoryInclusionExclusion } from "../_shared/cam-engine-v2/pools/pool-builder.ts";
import type { PoolSegmentAmount } from "../_shared/cam-engine-v2/pools/pool-builder.ts";
import type { RecoveryPoolCategory } from "../_shared/cam-engine-v2/contracts/cam-domain-types.ts";

// Real-shaped identifiers: a UUID for the canonical category, a human label
// for the frozen display snapshot. These are deliberately NOT equal.
const INSURANCE_ID = "3f1b9c62-5d4a-4e37-9a21-0c8e5b7d1a44";
const CLEANING_ID = "7c2d4e18-9b53-4a6f-8e10-2d9f6c3b5e77";
const INSURANCE_LABEL = "Insurance";

function poolCategory(
  expenseCategoryId: string,
  inclusionMode: "include" | "exclude" = "include",
): RecoveryPoolCategory {
  return {
    id: `cat-${expenseCategoryId}-${inclusionMode}`,
    org_id: "org-1",
    pool_id: "pool-1",
    expense_category_id: expenseCategoryId,
    inclusion_mode: inclusionMode,
    variability_default: "fixed",
    controllability_default: "uncontrollable",
    created_at: "",
    updated_at: "",
  };
}

function amount(overrides: Partial<PoolSegmentAmount> = {}): PoolSegmentAmount {
  return {
    pool_id: "pool-1",
    segment: { start: "2026-01-01", end: "2026-01-31", monthIndex: 1 },
    category: INSURANCE_LABEL,
    expense_category_id: INSURANCE_ID,
    amount: 100_000,
    source_expense_input_id: "exp-insurance",
    variability: "fixed",
    controllability: "uncontrollable",
    ...overrides,
  };
}

Deno.test("canonical category: an included expense is recovered even though its label differs from the pool's category UUID", () => {
  const { included, excluded, exceptions } = applyCategoryInclusionExclusion(
    [amount()],
    { "pool-1": [poolCategory(INSURANCE_ID, "include")] },
  );
  // Pre-fix this was included=0 / excluded=1: the whole pool silently
  // collapsed to zero recoverable dollars.
  assertEquals(included.length, 1);
  assertEquals(included[0].amount, 100_000);
  assertEquals(excluded.length, 0);
  assertEquals(exceptions.length, 0);
});

Deno.test("canonical category: an explicit exclude rule actually excludes, matched on the UUID and not the label", () => {
  const { included, excluded, exceptions } = applyCategoryInclusionExclusion(
    [amount()],
    { "pool-1": [poolCategory(INSURANCE_ID, "include"), poolCategory(INSURANCE_ID, "exclude")] },
  );
  // Explicit exclusion wins over broad inclusion. Pre-fix the exclude rule
  // never matched at all, so exclusion depended on the include-fallthrough
  // rather than on the lease's actual exclusion.
  assertEquals(excluded.length, 1);
  assertEquals(included.length, 0);
  assertEquals(exceptions.length, 0);
});

Deno.test("canonical category: an expense in an include-only pool for a DIFFERENT category is still excluded", () => {
  const { included, excluded } = applyCategoryInclusionExclusion(
    [amount()], // insurance
    { "pool-1": [poolCategory(CLEANING_ID, "include")] }, // pool only accepts cleaning
  );
  assertEquals(included.length, 0);
  assertEquals(excluded.length, 1);
});

Deno.test("canonical category: unresolved category blocks with EXPENSE_CATEGORY_MISSING instead of being recovered on a guess", () => {
  const { included, excluded, exceptions } = applyCategoryInclusionExclusion(
    [amount({ expense_category_id: null })],
    { "pool-1": [poolCategory(INSURANCE_ID, "include")] },
  );
  assertEquals(included.length, 0);
  assertEquals(excluded.length, 1);
  assertEquals(exceptions.length, 1);
  assertEquals(exceptions[0].code, "EXPENSE_CATEGORY_MISSING");
  assertEquals(exceptions[0].severity, "blocking");
  assertEquals(exceptions[0].entity_id, "exp-insurance");
  // The unresolvable label is surfaced so the user can act on it.
  assertEquals(exceptions[0].message.includes(INSURANCE_LABEL), true);
});

Deno.test("canonical category: EXPENSE_CATEGORY_MISSING is reported once per input per pool, not once per segment", () => {
  const twelveSegments = Array.from({ length: 12 }, (_, i) =>
    amount({
      expense_category_id: null,
      segment: { start: `2026-${String(i + 1).padStart(2, "0")}-01`, end: `2026-${String(i + 1).padStart(2, "0")}-28`, monthIndex: i + 1 },
    }));
  const { exceptions, excluded } = applyCategoryInclusionExclusion(
    twelveSegments,
    { "pool-1": [poolCategory(INSURANCE_ID, "include")] },
  );
  assertEquals(excluded.length, 12);
  assertEquals(exceptions.length, 1);
});

Deno.test("canonical category: an open pool (no configured categories) still includes an unresolved input without raising", () => {
  // A pool with zero categories is 'open' -- POOL_CATEGORY_MISSING readiness
  // owns that gap, so this function must not double-report it here.
  const { included, excluded, exceptions } = applyCategoryInclusionExclusion(
    [amount({ expense_category_id: null })],
    { "pool-1": [] },
  );
  assertEquals(included.length, 1);
  assertEquals(excluded.length, 0);
  assertEquals(exceptions.length, 0);
});

Deno.test("canonical category: a label that happens to equal another category's UUID is never matched by label", () => {
  // Defense against re-introducing label matching: the label here is a UUID
  // string for a DIFFERENT category. Only expense_category_id may decide.
  const { included, excluded } = applyCategoryInclusionExclusion(
    [amount({ category: CLEANING_ID, expense_category_id: INSURANCE_ID })],
    { "pool-1": [poolCategory(CLEANING_ID, "include")] },
  );
  assertEquals(included.length, 0);
  assertEquals(excluded.length, 1);
});

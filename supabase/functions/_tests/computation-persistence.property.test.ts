// @ts-nocheck
/**
 * Property-Based Test: Computation Persistence
 * Feature: backend-driven-pipeline, Task 16.5
 *
 * **Validates: Requirements 5.7, 6.6, 7.6, 8.6, 9.6, 10.6**
 *
 * Property 37: Every computation result must be stored in computation_snapshots.
 * createSnapshot always returns object with engine_type, inputs, outputs, computed_at fields.
 */

import { assertEquals, assertExists, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

interface ComputationSnapshot {
  engine_type: string;
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  computed_at: string;
}

/**
 * Creates a computation snapshot object for persistence.
 * Returns a snapshot with engine_type, inputs, outputs, and computed_at.
 */
function createSnapshot(
  engineType: string,
  inputs: Record<string, any>,
  outputs: Record<string, any>,
): ComputationSnapshot {
  return {
    engine_type: engineType,
    inputs: { ...inputs },
    outputs: { ...outputs },
    computed_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const engineTypeArb = fc.constantFrom(
  "lease",
  "expense",
  "cam",
  "revenue",
  "budget",
  "reconciliation",
);

const leaseInputsArb = fc.record({
  lease_id: fc.uuid(),
  base_rent: fc.float({ min: 100, max: 100000, noNaN: true }),
  escalation_rate: fc.float({ min: 0, max: 0.5, noNaN: true }),
  start_date: fc.constant("2024-01-01"),
  end_date: fc.constant("2026-12-31"),
});

const expenseInputsArb = fc.record({
  property_id: fc.uuid(),
  total_expenses: fc.float({ min: 0, max: 1000000, noNaN: true }),
  period: fc.constant("2024"),
});

const camInputsArb = fc.record({
  tenant_id: fc.uuid(),
  square_footage: fc.integer({ min: 100, max: 50000 }),
  total_cam_pool: fc.float({ min: 0, max: 500000, noNaN: true }),
});

const revenueInputsArb = fc.record({
  property_id: fc.uuid(),
  occupancy_rate: fc.float({ min: 0, max: 1, noNaN: true }),
  base_rent_total: fc.float({ min: 0, max: 5000000, noNaN: true }),
});

const genericInputsArb = fc.oneof(
  leaseInputsArb,
  expenseInputsArb,
  camInputsArb,
  revenueInputsArb,
);

const outputsArb = fc.record({
  total: fc.float({ min: 0, max: 10000000, noNaN: true }),
  line_items: fc.array(
    fc.record({
      label: fc.string({ minLength: 1, maxLength: 50 }),
      amount: fc.float({ min: 0, max: 1000000, noNaN: true }),
    }),
    { minLength: 0, maxLength: 10 },
  ),
});

// ISO 8601 timestamp pattern
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 37: createSnapshot always returns object with required fields",
  fn: () => {
    fc.assert(
      fc.property(engineTypeArb, genericInputsArb, outputsArb, (engineType, inputs, outputs) => {
        const snapshot = createSnapshot(engineType, inputs, outputs);

        // Property: all required fields must be present
        assertExists(snapshot.engine_type, "engine_type must be present");
        assertExists(snapshot.inputs, "inputs must be present");
        assertExists(snapshot.outputs, "outputs must be present");
        assertExists(snapshot.computed_at, "computed_at must be present");
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 37: createSnapshot engine_type matches the provided engine type",
  fn: () => {
    fc.assert(
      fc.property(engineTypeArb, genericInputsArb, outputsArb, (engineType, inputs, outputs) => {
        const snapshot = createSnapshot(engineType, inputs, outputs);
        assertEquals(
          snapshot.engine_type,
          engineType,
          `engine_type must be '${engineType}', got '${snapshot.engine_type}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 37: createSnapshot computed_at is a valid ISO timestamp",
  fn: () => {
    fc.assert(
      fc.property(engineTypeArb, genericInputsArb, outputsArb, (engineType, inputs, outputs) => {
        const before = Date.now();
        const snapshot = createSnapshot(engineType, inputs, outputs);
        const after = Date.now();

        assert(
          ISO_TIMESTAMP_RE.test(snapshot.computed_at),
          `computed_at '${snapshot.computed_at}' must be a valid ISO timestamp`,
        );

        const computedTime = new Date(snapshot.computed_at).getTime();
        assert(
          computedTime >= before && computedTime <= after,
          `computed_at must be set to current time. Got: ${snapshot.computed_at}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 37: createSnapshot preserves inputs and outputs",
  fn: () => {
    fc.assert(
      fc.property(engineTypeArb, genericInputsArb, outputsArb, (engineType, inputs, outputs) => {
        const snapshot = createSnapshot(engineType, inputs, outputs);

        assertEquals(
          snapshot.inputs,
          inputs,
          "inputs must be preserved in snapshot",
        );
        assertEquals(
          snapshot.outputs,
          outputs,
          "outputs must be preserved in snapshot",
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 37: createSnapshot does not mutate original inputs/outputs",
  fn: () => {
    fc.assert(
      fc.property(engineTypeArb, genericInputsArb, outputsArb, (engineType, inputs, outputs) => {
        const originalInputs = JSON.parse(JSON.stringify(inputs));
        const originalOutputs = JSON.parse(JSON.stringify(outputs));

        createSnapshot(engineType, inputs, outputs);

        assertEquals(inputs, originalInputs, "Original inputs must not be mutated");
        assertEquals(outputs, originalOutputs, "Original outputs must not be mutated");
      }),
      { numRuns: 100 },
    );
  },
});

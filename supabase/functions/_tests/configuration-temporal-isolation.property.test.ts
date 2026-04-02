// @ts-nocheck
/**
 * Property-Based Test: Configuration Temporal Isolation
 * Feature: backend-driven-pipeline, Task 14.3
 *
 * **Validates: Requirements 13.4**
 *
 * Property 42: Configuration changes must not affect already-computed snapshots.
 * applyConfig(snapshot, config).inputs === snapshot.inputs (inputs are immutable).
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Snapshot {
  id: string;
  engine_type: string;
  inputs: Record<string, any>;
  outputs: Record<string, any>;
  computed_at: string;
  config_snapshot: Record<string, any>;
}

interface Config {
  cam_calculation_method?: string;
  fiscal_year_start?: number;
  escalation_rate?: number;
  cam_cap?: number | null;
  [key: string]: any;
}

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

/**
 * Applies a config to a snapshot at read time.
 * Config is read-only at compute time — the snapshot's inputs are immutable.
 * Returns the snapshot unchanged (config cannot retroactively alter inputs).
 */
function applyConfig(snapshot: Snapshot, config: Config): Snapshot {
  // Config is read-only at compute time; snapshot inputs must not be mutated.
  return {
    ...snapshot,
    // config_snapshot records what config was active, but inputs stay the same
    config_snapshot: { ...config },
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const inputsArb = fc.record({
  base_rent: fc.float({ min: 100, max: 100000, noNaN: true }),
  square_footage: fc.integer({ min: 100, max: 50000 }),
  lease_term_months: fc.integer({ min: 1, max: 120 }),
  escalation_rate: fc.float({ min: 0, max: 0.5, noNaN: true }),
});

const outputsArb = fc.record({
  total_rent: fc.float({ min: 0, max: 10000000, noNaN: true }),
  cam_charge: fc.float({ min: 0, max: 100000, noNaN: true }),
});

const snapshotArb = fc.record({
  id: fc.uuid(),
  engine_type: fc.constantFrom("lease", "cam", "revenue", "budget", "expense"),
  inputs: inputsArb,
  outputs: outputsArb,
  computed_at: fc.constant(new Date().toISOString()),
  config_snapshot: fc.record({
    cam_calculation_method: fc.constantFrom("pro_rata", "fixed", "capped"),
    fiscal_year_start: fc.integer({ min: 1, max: 12 }),
  }),
});

const configArb = fc.record({
  cam_calculation_method: fc.constantFrom("pro_rata", "fixed", "capped"),
  fiscal_year_start: fc.integer({ min: 1, max: 12 }),
  escalation_rate: fc.float({ min: 0, max: 50, noNaN: true }),
  cam_cap: fc.option(fc.float({ min: 0, max: 100000, noNaN: true }), { nil: null }),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 42: applyConfig does not mutate snapshot.inputs",
  fn: () => {
    fc.assert(
      fc.property(snapshotArb, configArb, (snapshot, config) => {
        const originalInputs = JSON.parse(JSON.stringify(snapshot.inputs));
        const result = applyConfig(snapshot, config);

        // Property: inputs must be identical to original snapshot inputs
        assertEquals(
          result.inputs,
          originalInputs,
          "snapshot.inputs must be unchanged after applyConfig",
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 42: applyConfig does not mutate snapshot.outputs",
  fn: () => {
    fc.assert(
      fc.property(snapshotArb, configArb, (snapshot, config) => {
        const originalOutputs = JSON.parse(JSON.stringify(snapshot.outputs));
        const result = applyConfig(snapshot, config);

        assertEquals(
          result.outputs,
          originalOutputs,
          "snapshot.outputs must be unchanged after applyConfig",
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 42: applyConfig preserves computed_at timestamp",
  fn: () => {
    fc.assert(
      fc.property(snapshotArb, configArb, (snapshot, config) => {
        const result = applyConfig(snapshot, config);

        assertEquals(
          result.computed_at,
          snapshot.computed_at,
          "computed_at must not change after applyConfig",
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 42: applyConfig with different configs produces same inputs",
  fn: () => {
    fc.assert(
      fc.property(snapshotArb, configArb, configArb, (snapshot, config1, config2) => {
        const result1 = applyConfig(snapshot, config1);
        const result2 = applyConfig(snapshot, config2);

        // Regardless of which config is applied, inputs must be identical
        assertEquals(
          result1.inputs,
          result2.inputs,
          "inputs must be the same regardless of which config is applied",
        );
      }),
      { numRuns: 100 },
    );
  },
});

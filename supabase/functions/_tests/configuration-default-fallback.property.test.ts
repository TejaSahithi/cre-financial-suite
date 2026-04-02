// @ts-nocheck
/**
 * Property-Based Test: Configuration Default Fallback
 * Feature: backend-driven-pipeline, Task 14.2
 *
 * **Validates: Requirements 13.3**
 *
 * Property 41: When property_config is missing, system defaults must be used.
 * For any partial config, mergeWithDefaults always returns a complete config
 * with all default keys present.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

/**
 * Merges a partial config with defaults, filling in any missing keys.
 * Keys present in config take precedence; missing keys fall back to defaults.
 */
function mergeWithDefaults(
  config: Record<string, any>,
  defaults: Record<string, any>,
): Record<string, any> {
  const result: Record<string, any> = { ...defaults };
  for (const [key, value] of Object.entries(config)) {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// System defaults (mirrors config-helper.ts)
// ---------------------------------------------------------------------------

const SYSTEM_DEFAULTS = {
  cam_calculation_method: "pro_rata",
  expense_recovery_method: "base_year",
  fiscal_year_start: 1,
  admin_fee_pct: 10,
  gross_up_pct: 0,
  escalation_rate: 3,
  cam_per_sf: 0,
};

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const camMethodArb = fc.constantFrom("pro_rata", "fixed", "capped");
const expRecoveryArb = fc.constantFrom("base_year", "full", "none");

/** Generates a partial config with a random subset of keys */
const partialConfigArb = fc.record(
  {
    cam_calculation_method: fc.option(camMethodArb, { nil: undefined }),
    expense_recovery_method: fc.option(expRecoveryArb, { nil: undefined }),
    fiscal_year_start: fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }),
    admin_fee_pct: fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
    gross_up_pct: fc.option(fc.float({ min: 0, max: 100, noNaN: true }), { nil: undefined }),
    escalation_rate: fc.option(fc.float({ min: 0, max: 50, noNaN: true }), { nil: undefined }),
    cam_per_sf: fc.option(fc.float({ min: 0, max: 1000, noNaN: true }), { nil: undefined }),
  },
  { requiredKeys: [] },
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 41: mergeWithDefaults always returns all default keys",
  fn: () => {
    fc.assert(
      fc.property(partialConfigArb, (partialConfig) => {
        // Remove undefined values to simulate a truly partial config
        const config: Record<string, any> = {};
        for (const [k, v] of Object.entries(partialConfig)) {
          if (v !== undefined) config[k] = v;
        }

        const result = mergeWithDefaults(config, SYSTEM_DEFAULTS);

        // Property: every default key must be present in the result
        for (const key of Object.keys(SYSTEM_DEFAULTS)) {
          assert(
            key in result,
            `Key '${key}' must be present in merged config`,
          );
          assert(
            result[key] !== null && result[key] !== undefined,
            `Key '${key}' must not be null/undefined in merged config`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 41: mergeWithDefaults uses config values when present",
  fn: () => {
    fc.assert(
      fc.property(partialConfigArb, (partialConfig) => {
        const config: Record<string, any> = {};
        for (const [k, v] of Object.entries(partialConfig)) {
          if (v !== undefined) config[k] = v;
        }

        const result = mergeWithDefaults(config, SYSTEM_DEFAULTS);

        // Property: keys present in config must retain their values
        for (const [key, value] of Object.entries(config)) {
          assertEquals(
            result[key],
            value,
            `Key '${key}' must retain config value '${value}', got '${result[key]}'`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 41: empty config returns all defaults unchanged",
  fn: () => {
    const result = mergeWithDefaults({}, SYSTEM_DEFAULTS);
    for (const [key, value] of Object.entries(SYSTEM_DEFAULTS)) {
      assertEquals(result[key], value, `Empty config must return default for '${key}'`);
    }
  },
});

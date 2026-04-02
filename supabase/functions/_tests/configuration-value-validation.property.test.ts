// @ts-nocheck
/**
 * Property-Based Test: Configuration Value Validation
 * Feature: backend-driven-pipeline, Task 14.4
 *
 * **Validates: Requirements 13.5**
 *
 * Property 43: Configuration values must be within acceptable ranges.
 * validateConfig returns errors for out-of-range values.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

interface ConfigValidationError {
  field: string;
  message: string;
  value: any;
}

/**
 * Validates configuration values are within acceptable ranges.
 * Returns an array of errors (empty if all values are valid).
 */
function validateConfig(config: Record<string, any>): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  const VALID_CAM_METHODS = ["pro_rata", "fixed", "capped"];

  if (
    config.cam_calculation_method !== undefined &&
    !VALID_CAM_METHODS.includes(config.cam_calculation_method)
  ) {
    errors.push({
      field: "cam_calculation_method",
      message: `Must be one of: ${VALID_CAM_METHODS.join(", ")}`,
      value: config.cam_calculation_method,
    });
  }

  if (config.fiscal_year_start !== undefined) {
    const fys = Number(config.fiscal_year_start);
    if (!Number.isInteger(fys) || fys < 1 || fys > 12) {
      errors.push({
        field: "fiscal_year_start",
        message: "Must be an integer between 1 and 12",
        value: config.fiscal_year_start,
      });
    }
  }

  if (config.escalation_rate !== undefined) {
    const er = Number(config.escalation_rate);
    if (isNaN(er) || er < 0 || er > 100) {
      errors.push({
        field: "escalation_rate",
        message: "Must be a number between 0 and 100",
        value: config.escalation_rate,
      });
    }
  }

  if (config.cam_cap !== undefined && config.cam_cap !== null) {
    const cc = Number(config.cam_cap);
    if (isNaN(cc) || cc < 0) {
      errors.push({
        field: "cam_cap",
        message: "Must be a non-negative number",
        value: config.cam_cap,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const validCamMethodArb = fc.constantFrom("pro_rata", "fixed", "capped");
const invalidCamMethodArb = fc.string({ minLength: 1, maxLength: 20 }).filter(
  (s) => !["pro_rata", "fixed", "capped"].includes(s),
);

const validFiscalYearArb = fc.integer({ min: 1, max: 12 });
const invalidFiscalYearArb = fc.oneof(
  fc.integer({ min: 13, max: 100 }),
  fc.integer({ min: -100, max: 0 }),
);

const validEscalationRateArb = fc.float({ min: 0, max: Math.fround(100), noNaN: true });
const invalidEscalationRateArb = fc.oneof(
  fc.integer({ min: 101, max: 10000 }).map(Number),
  fc.integer({ min: -10000, max: -1 }).map(Number),
);

const validCamCapArb = fc.float({ min: 0, max: Math.fround(1000000), noNaN: true });
const invalidCamCapArb = fc.integer({ min: -10000, max: -1 }).map(Number);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 43: invalid cam_calculation_method produces an error",
  fn: () => {
    fc.assert(
      fc.property(invalidCamMethodArb, (method) => {
        const errors = validateConfig({ cam_calculation_method: method });
        const camError = errors.find((e) => e.field === "cam_calculation_method");
        assert(
          camError !== undefined,
          `Expected error for cam_calculation_method='${method}', got none`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: valid cam_calculation_method produces no error",
  fn: () => {
    fc.assert(
      fc.property(validCamMethodArb, (method) => {
        const errors = validateConfig({ cam_calculation_method: method });
        const camError = errors.find((e) => e.field === "cam_calculation_method");
        assertEquals(
          camError,
          undefined,
          `Expected no error for cam_calculation_method='${method}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: fiscal_year_start out of range 1-12 produces an error",
  fn: () => {
    fc.assert(
      fc.property(invalidFiscalYearArb, (fys) => {
        const errors = validateConfig({ fiscal_year_start: fys });
        const fysError = errors.find((e) => e.field === "fiscal_year_start");
        assert(
          fysError !== undefined,
          `Expected error for fiscal_year_start=${fys}, got none`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: fiscal_year_start in range 1-12 produces no error",
  fn: () => {
    fc.assert(
      fc.property(validFiscalYearArb, (fys) => {
        const errors = validateConfig({ fiscal_year_start: fys });
        const fysError = errors.find((e) => e.field === "fiscal_year_start");
        assertEquals(
          fysError,
          undefined,
          `Expected no error for fiscal_year_start=${fys}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: escalation_rate outside 0-100 produces an error",
  fn: () => {
    fc.assert(
      fc.property(invalidEscalationRateArb, (rate) => {
        const errors = validateConfig({ escalation_rate: rate });
        const rateError = errors.find((e) => e.field === "escalation_rate");
        assert(
          rateError !== undefined,
          `Expected error for escalation_rate=${rate}, got none`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: escalation_rate in range 0-100 produces no error",
  fn: () => {
    fc.assert(
      fc.property(validEscalationRateArb, (rate) => {
        const errors = validateConfig({ escalation_rate: rate });
        const rateError = errors.find((e) => e.field === "escalation_rate");
        assertEquals(
          rateError,
          undefined,
          `Expected no error for escalation_rate=${rate}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: negative cam_cap produces an error",
  fn: () => {
    fc.assert(
      fc.property(invalidCamCapArb, (cap) => {
        const errors = validateConfig({ cam_cap: cap });
        const capError = errors.find((e) => e.field === "cam_cap");
        assert(
          capError !== undefined,
          `Expected error for cam_cap=${cap}, got none`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: non-negative cam_cap produces no error",
  fn: () => {
    fc.assert(
      fc.property(validCamCapArb, (cap) => {
        const errors = validateConfig({ cam_cap: cap });
        const capError = errors.find((e) => e.field === "cam_cap");
        assertEquals(
          capError,
          undefined,
          `Expected no error for cam_cap=${cap}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 43: fully valid config produces no errors",
  fn: () => {
    fc.assert(
      fc.property(
        validCamMethodArb,
        validFiscalYearArb,
        validEscalationRateArb,
        validCamCapArb,
        (method, fys, rate, cap) => {
          const errors = validateConfig({
            cam_calculation_method: method,
            fiscal_year_start: fys,
            escalation_rate: rate,
            cam_cap: cap,
          });
          assertEquals(
            errors.length,
            0,
            `Expected no errors for valid config, got: ${JSON.stringify(errors)}`,
          );
        },
      ),
      { numRuns: 100 },
    );
  },
});

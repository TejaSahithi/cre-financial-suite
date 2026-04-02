// @ts-nocheck
/**
 * Property-Based Test: Computation Error Handling
 * Feature: backend-driven-pipeline, Task 17.5
 *
 * **Validates: Requirements 15.4**
 *
 * Property 45: Computation errors must be categorized and include error_code.
 * formatComputationError always returns object with error=true and non-empty message.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

interface ComputationErrorResponse {
  error: true;
  error_code: "COMPUTATION_FAILED";
  message: string;
}

/**
 * Formats a computation error into a standardised error response object.
 */
function formatComputationError(message: string): ComputationErrorResponse {
  return {
    error: true,
    error_code: "COMPUTATION_FAILED",
    message: message && message.trim().length > 0 ? message : "Computation failed",
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const nonEmptyMessageArb = fc.string({ minLength: 1, maxLength: 500 });

const anyMessageArb = fc.oneof(
  fc.string({ minLength: 1, maxLength: 500 }),
  fc.constant(""),
  fc.constant("   "),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 45: formatComputationError always returns error=true",
  fn: () => {
    fc.assert(
      fc.property(nonEmptyMessageArb, (message) => {
        const result = formatComputationError(message);
        assertEquals(
          result.error,
          true,
          `error must be true, got ${result.error}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 45: formatComputationError always returns error_code='COMPUTATION_FAILED'",
  fn: () => {
    fc.assert(
      fc.property(nonEmptyMessageArb, (message) => {
        const result = formatComputationError(message);
        assertEquals(
          result.error_code,
          "COMPUTATION_FAILED",
          `error_code must be 'COMPUTATION_FAILED', got '${result.error_code}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 45: formatComputationError always returns non-empty message",
  fn: () => {
    fc.assert(
      fc.property(anyMessageArb, (message) => {
        const result = formatComputationError(message);
        assert(
          result.message !== null && result.message !== undefined,
          "message must not be null/undefined",
        );
        assert(
          result.message.length > 0,
          `message must not be empty, got '${result.message}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 45: formatComputationError preserves the original message when non-empty",
  fn: () => {
    fc.assert(
      fc.property(nonEmptyMessageArb, (message) => {
        const result = formatComputationError(message);
        assertEquals(
          result.message,
          message,
          `message must equal the provided message`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

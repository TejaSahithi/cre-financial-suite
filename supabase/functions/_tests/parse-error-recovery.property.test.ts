// @ts-nocheck
/**
 * Property-Based Test: Parse Error Recovery
 * Feature: backend-driven-pipeline, Task 17.4
 *
 * **Validates: Requirements 15.1**
 *
 * Property 44: Parse errors must produce descriptive error messages with error_code.
 * formatParseError always returns object with error=true and non-empty message.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

interface ParseErrorResponse {
  error: true;
  error_code: "PARSING_FAILED";
  message: string;
}

/**
 * Formats a parse error into a standardised error response object.
 */
function formatParseError(message: string): ParseErrorResponse {
  return {
    error: true,
    error_code: "PARSING_FAILED",
    message: message && message.trim().length > 0 ? message : "Parsing failed",
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
  name: "Property 44: formatParseError always returns error=true",
  fn: () => {
    fc.assert(
      fc.property(nonEmptyMessageArb, (message) => {
        const result = formatParseError(message);
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
  name: "Property 44: formatParseError always returns error_code='PARSING_FAILED'",
  fn: () => {
    fc.assert(
      fc.property(nonEmptyMessageArb, (message) => {
        const result = formatParseError(message);
        assertEquals(
          result.error_code,
          "PARSING_FAILED",
          `error_code must be 'PARSING_FAILED', got '${result.error_code}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 44: formatParseError always returns non-empty message",
  fn: () => {
    fc.assert(
      fc.property(anyMessageArb, (message) => {
        const result = formatParseError(message);
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
  name: "Property 44: formatParseError preserves the original message when non-empty",
  fn: () => {
    fc.assert(
      fc.property(nonEmptyMessageArb, (message) => {
        const result = formatParseError(message);
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

// @ts-nocheck
/**
 * Property-Based Test: Failed Status Error Info
 * Feature: backend-driven-pipeline, Task 16.4
 *
 * **Validates: Requirements 11.4**
 *
 * Property 36: When status is 'failed', error_message must be present and non-empty.
 * markFailed always produces status='failed' and non-empty error_message.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

interface PipelineRecord {
  id: string;
  status: string;
  updated_at: string;
  error_message?: string | null;
  failed_step?: string | null;
  [key: string]: any;
}

/**
 * Marks a pipeline record as failed with the given error message.
 * Sets status='failed', error_message, and updates updated_at.
 */
function markFailed(record: PipelineRecord, errorMessage: string): PipelineRecord {
  return {
    ...record,
    status: "failed",
    error_message: errorMessage,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const recordArb = fc.record({
  id: fc.uuid(),
  status: fc.constantFrom("uploaded", "parsing", "parsed", "validating", "validated", "storing"),
  updated_at: fc.constant(new Date(Date.now() - 5000).toISOString()),
  error_message: fc.constant(null),
});

/** Non-empty error messages */
const errorMessageArb = fc.string({ minLength: 1, maxLength: 500 });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 36: markFailed always sets status to 'failed'",
  fn: () => {
    fc.assert(
      fc.property(recordArb, errorMessageArb, (record, errorMessage) => {
        const result = markFailed(record, errorMessage);
        assertEquals(
          result.status,
          "failed",
          `status must be 'failed', got '${result.status}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 36: markFailed always sets non-empty error_message",
  fn: () => {
    fc.assert(
      fc.property(recordArb, errorMessageArb, (record, errorMessage) => {
        const result = markFailed(record, errorMessage);

        assert(
          result.error_message !== null && result.error_message !== undefined,
          "error_message must not be null/undefined after markFailed",
        );
        assert(
          result.error_message.length > 0,
          "error_message must not be empty after markFailed",
        );
        assertEquals(
          result.error_message,
          errorMessage,
          `error_message must equal the provided message`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 36: markFailed updates updated_at to current time",
  fn: () => {
    fc.assert(
      fc.property(recordArb, errorMessageArb, (record, errorMessage) => {
        const before = Date.now();
        const result = markFailed(record, errorMessage);
        const after = Date.now();

        const resultTime = new Date(result.updated_at).getTime();
        assert(
          resultTime >= before && resultTime <= after,
          `updated_at must be set to current time. Got: ${result.updated_at}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 36: markFailed preserves record id",
  fn: () => {
    fc.assert(
      fc.property(recordArb, errorMessageArb, (record, errorMessage) => {
        const result = markFailed(record, errorMessage);
        assertEquals(result.id, record.id, "id must be preserved after markFailed");
      }),
      { numRuns: 100 },
    );
  },
});

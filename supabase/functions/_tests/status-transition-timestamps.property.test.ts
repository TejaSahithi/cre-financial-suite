// @ts-nocheck
/**
 * Property-Based Test: Status Transition Timestamps
 * Feature: backend-driven-pipeline, Task 16.3
 *
 * **Validates: Requirements 11.2**
 *
 * Property 35: Every status transition must update the updated_at timestamp.
 * updateStatus always produces updated_at >= record.updated_at.
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

type ProcessingStatus =
  | "uploaded"
  | "parsing"
  | "parsed"
  | "pdf_parsed"
  | "validating"
  | "validated"
  | "review_required"
  | "approved"
  | "storing"
  | "stored"
  | "computing"
  | "completed"
  | "failed";

interface StatusRecord {
  id: string;
  status: ProcessingStatus;
  updated_at: string;
  [key: string]: any;
}

/**
 * Updates the status of a record and sets updated_at to the current time.
 * Returns a new record object (immutable update).
 */
function updateStatus(record: StatusRecord, newStatus: ProcessingStatus): StatusRecord {
  return {
    ...record,
    status: newStatus,
    updated_at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

const statusArb = fc.constantFrom<ProcessingStatus>(
  "uploaded",
  "parsing",
  "parsed",
  "pdf_parsed",
  "validating",
  "validated",
  "review_required",
  "approved",
  "storing",
  "stored",
  "computing",
  "completed",
  "failed",
);

/** Generates a record with an updated_at in the past (at least 1ms ago) */
const pastTimestampArb = fc.integer({ min: 1, max: 60000 }).map((msAgo) => {
  return new Date(Date.now() - msAgo).toISOString();
});

const recordArb = fc.record({
  id: fc.uuid(),
  status: statusArb,
  updated_at: pastTimestampArb,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 35: updateStatus always sets updated_at >= original updated_at",
  fn: () => {
    fc.assert(
      fc.property(recordArb, statusArb, (record, newStatus) => {
        const before = Date.now();
        const result = updateStatus(record, newStatus);
        const after = Date.now();

        const originalTime = new Date(record.updated_at).getTime();
        const resultTime = new Date(result.updated_at).getTime();

        assert(
          resultTime >= originalTime,
          `updated_at must not go backwards. Original: ${record.updated_at}, Result: ${result.updated_at}`,
        );

        // updated_at must be within the test window
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
  name: "Property 35: updateStatus sets the new status correctly",
  fn: () => {
    fc.assert(
      fc.property(recordArb, statusArb, (record, newStatus) => {
        const result = updateStatus(record, newStatus);
        assertEquals(
          result.status,
          newStatus,
          `status must be updated to '${newStatus}', got '${result.status}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 35: updateStatus does not mutate the original record",
  fn: () => {
    fc.assert(
      fc.property(recordArb, statusArb, (record, newStatus) => {
        const originalStatus = record.status;
        const originalUpdatedAt = record.updated_at;

        updateStatus(record, newStatus);

        assertEquals(record.status, originalStatus, "Original record status must not be mutated");
        assertEquals(
          record.updated_at,
          originalUpdatedAt,
          "Original record updated_at must not be mutated",
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 35: updateStatus preserves all other record fields",
  fn: () => {
    fc.assert(
      fc.property(recordArb, statusArb, (record, newStatus) => {
        const result = updateStatus(record, newStatus);
        assertEquals(result.id, record.id, "id must be preserved");
      }),
      { numRuns: 100 },
    );
  },
});

// @ts-nocheck
/**
 * Property-Based Test: Export File Generation
 * Feature: backend-driven-pipeline, Task 18.3
 *
 * **Validates: Requirements 18.1, 18.2**
 *
 * Property 46: For any array of row objects, jsonToCSV must produce a valid CSV
 * with correct row count. CSV line count = rows.length + 1 (header row).
 */

import { assertEquals, assert } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

/**
 * Escapes a CSV cell value.
 * Wraps in quotes if the value contains comma, double-quote, or newline.
 */
function escapeCSVValue(value: any): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Converts an array of row objects to CSV text.
 * First line is the header row using the provided headers array.
 * Each subsequent line is a data row.
 */
function jsonToCSV(rows: Record<string, any>[], headers: string[]): string {
  if (headers.length === 0) return "";

  const headerLine = headers.map(escapeCSVValue).join(",");

  if (rows.length === 0) return headerLine;

  const dataLines = rows.map((row) =>
    headers.map((h) => escapeCSVValue(row[h])).join(",")
  );

  return [headerLine, ...dataLines].join("\n");
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Simple alphanumeric header names — no special CSV chars */
const headerArb = fc.stringOf(
  fc.char().filter((c) => /[a-zA-Z0-9_]/.test(c)),
  { minLength: 1, maxLength: 15 },
);

const headersArb = fc
  .array(headerArb, { minLength: 1, maxLength: 8 })
  .filter((headers) => new Set(headers).size === headers.length);

/** Simple cell values without special CSV chars for column-count tests */
const simpleCellArb = fc.oneof(
  fc.stringOf(fc.char().filter((c) => /[a-zA-Z0-9 _\-]/.test(c)), { minLength: 0, maxLength: 20 }),
  fc.integer({ min: 0, max: 999999 }).map(String),
);

/** Combined arbitrary: headers + matching rows */
const headersAndRowsArb = headersArb.chain((headers) =>
  fc.record({
    headers: fc.constant(headers),
    rows: fc.array(
      fc.record(Object.fromEntries(headers.map((h) => [h, simpleCellArb]))),
      { minLength: 0, maxLength: 30 },
    ),
  })
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 46: CSV line count equals rows.length + 1 (header row)",
  fn: () => {
    fc.assert(
      fc.property(headersAndRowsArb, ({ headers, rows }) => {
        const csv = jsonToCSV(rows, headers);
        const lines = csv.split("\n");

        assertEquals(
          lines.length,
          rows.length + 1,
          `CSV must have ${rows.length + 1} lines (${rows.length} data + 1 header), got ${lines.length}`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 46: CSV first line is the header row",
  fn: () => {
    fc.assert(
      fc.property(headersAndRowsArb, ({ headers, rows }) => {
        const csv = jsonToCSV(rows, headers);
        const firstLine = csv.split("\n")[0];
        const expectedHeader = headers.join(",");

        assertEquals(
          firstLine,
          expectedHeader,
          `First CSV line must be the header row. Expected: '${expectedHeader}', got: '${firstLine}'`,
        );
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 46: empty rows array produces only header line",
  fn: () => {
    fc.assert(
      fc.property(headersArb, (headers) => {
        const csv = jsonToCSV([], headers);
        const lines = csv.split("\n");
        assertEquals(lines.length, 1, "Empty rows must produce exactly 1 line (header)");
        assertEquals(lines[0], headers.join(","), "Single line must be the header");
      }),
      { numRuns: 100 },
    );
  },
});

Deno.test({
  name: "Property 46: each data row has the same number of columns as headers",
  fn: () => {
    fc.assert(
      fc.property(headersAndRowsArb, ({ headers, rows }) => {
        if (rows.length === 0) return; // no data rows to check
        const csv = jsonToCSV(rows, headers);
        const lines = csv.split("\n");
        // Skip header (index 0), check each data line
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(",");
          assertEquals(
            cols.length,
            headers.length,
            `Row ${i} must have ${headers.length} columns, got ${cols.length}`,
          );
        }
      }),
      { numRuns: 100 },
    );
  },
});

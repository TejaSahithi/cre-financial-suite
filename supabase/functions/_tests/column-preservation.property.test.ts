// @ts-nocheck
/**
 * Property-Based Test: Column and Type Preservation
 * Feature: backend-driven-pipeline, Task 3.8
 *
 * **Validates: Requirements 2.5, 2.6**
 *
 * Property 6: Column and Type Preservation
 * For any CSV, all column headers must be preserved in parsed output, empty values become null.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";
import { parseLeases } from "../_shared/parsers/lease-parser.ts";
import { parseExpenses } from "../_shared/parsers/expense-parser.ts";
import { parseProperties } from "../_shared/parsers/property-parser.ts";
import { parseRevenues } from "../_shared/parsers/revenue-parser.ts";

// ---------------------------------------------------------------------------
// Known mapped column names per parser (so we can verify they appear in output)
// ---------------------------------------------------------------------------

const LEASE_KNOWN_COLUMNS = [
  "tenant_name",
  "start_date",
  "end_date",
  "monthly_rent",
  "square_footage",
  "lease_type",
  "property_id",
  "unit_id",
];

const EXPENSE_KNOWN_COLUMNS = [
  "category",
  "amount",
  "date",
  "property_id",
  "vendor",
  "gl_code",
];

const PROPERTY_KNOWN_COLUMNS = [
  "name",
  "address",
  "city",
  "state",
  "square_footage",
  "property_type",
];

const REVENUE_KNOWN_COLUMNS = [
  "revenue_type",
  "amount",
  "period",
  "property_id",
];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Safe column header: lowercase letters + underscore, no collision with known mapped names */
const customHeaderArb = fc
  .tuple(
    fc.string({ minLength: 4, maxLength: 8, unit: fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i", "j") }),
    fc.string({ minLength: 2, maxLength: 5, unit: fc.constantFrom("p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z") })
  )
  .map(([a, b]) => `custom_${a}${b}`);

/** Non-empty cell value (no commas to keep CSV simple) */
const nonEmptyCellArb = fc.oneof(
  fc.integer({ min: 1, max: 99999 }).map(String),
  fc
    .array(fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i"), { minLength: 2, maxLength: 10 })
    .map((c) => c.join(""))
);

/** Cell that may be empty (to test null handling) */
const maybeCellArb = fc.oneof(
  { weight: 3, arbitrary: nonEmptyCellArb },
  { weight: 1, arbitrary: fc.constant("") }
);

/** A dataset of custom (unmapped) headers + rows */
const customCsvDatasetArb = fc
  .array(customHeaderArb, { minLength: 2, maxLength: 5 })
  .chain((headers) => {
    const uniqueHeaders = [...new Set(headers)];
    return fc
      .array(
        fc.array(maybeCellArb, { minLength: uniqueHeaders.length, maxLength: uniqueHeaders.length }),
        { minLength: 1, maxLength: 6 }
      )
      .map((rows) => ({ headers: uniqueHeaders, rows }));
  });

/** A dataset using known mapped column names */
const knownLeaseDatasetArb = fc
  .array(
    fc.array(maybeCellArb, { minLength: LEASE_KNOWN_COLUMNS.length, maxLength: LEASE_KNOWN_COLUMNS.length }),
    { minLength: 1, maxLength: 5 }
  )
  .map((rows) => ({ headers: LEASE_KNOWN_COLUMNS, rows }));

const knownExpenseDatasetArb = fc
  .array(
    fc.array(maybeCellArb, { minLength: EXPENSE_KNOWN_COLUMNS.length, maxLength: EXPENSE_KNOWN_COLUMNS.length }),
    { minLength: 1, maxLength: 5 }
  )
  .map((rows) => ({ headers: EXPENSE_KNOWN_COLUMNS, rows }));

const knownPropertyDatasetArb = fc
  .array(
    fc.array(maybeCellArb, { minLength: PROPERTY_KNOWN_COLUMNS.length, maxLength: PROPERTY_KNOWN_COLUMNS.length }),
    { minLength: 1, maxLength: 5 }
  )
  .map((rows) => ({ headers: PROPERTY_KNOWN_COLUMNS, rows }));

const knownRevenueDatasetArb = fc
  .array(
    fc.array(maybeCellArb, { minLength: REVENUE_KNOWN_COLUMNS.length, maxLength: REVENUE_KNOWN_COLUMNS.length }),
    { minLength: 1, maxLength: 5 }
  )
  .map((rows) => ({ headers: REVENUE_KNOWN_COLUMNS, rows }));

// ---------------------------------------------------------------------------
// Helper: build raw row objects
// ---------------------------------------------------------------------------
function buildRawRows(headers: string[], rows: string[][]): Array<Record<string, string>> {
  return rows.map((cells) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = cells[i] ?? "";
    });
    return obj;
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 6: Column Preservation - lease parser preserves all custom (unmapped) column headers",
  fn: () => {
    fc.assert(
      fc.property(customCsvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseLeases(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (const parsedRow of result.rows) {
          for (const header of headers) {
            // Custom (unmapped) columns must be preserved as-is
            assertEquals(
              Object.prototype.hasOwnProperty.call(parsedRow, header),
              true,
              `Custom column "${header}" must be present in parsed row`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Column Preservation - expense parser preserves all custom column headers",
  fn: () => {
    fc.assert(
      fc.property(customCsvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseExpenses(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (const parsedRow of result.rows) {
          for (const header of headers) {
            assertEquals(
              Object.prototype.hasOwnProperty.call(parsedRow, header),
              true,
              `Custom column "${header}" must be present in parsed row`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Column Preservation - property parser preserves all custom column headers",
  fn: () => {
    fc.assert(
      fc.property(customCsvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseProperties(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (const parsedRow of result.rows) {
          for (const header of headers) {
            assertEquals(
              Object.prototype.hasOwnProperty.call(parsedRow, header),
              true,
              `Custom column "${header}" must be present in parsed row`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Column Preservation - revenue parser preserves all custom column headers",
  fn: () => {
    fc.assert(
      fc.property(customCsvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseRevenues(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (const parsedRow of result.rows) {
          for (const header of headers) {
            assertEquals(
              Object.prototype.hasOwnProperty.call(parsedRow, header),
              true,
              `Custom column "${header}" must be present in parsed row`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Null Handling - lease parser converts empty values to null",
  fn: () => {
    fc.assert(
      fc.property(knownLeaseDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseLeases(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const originalCells = rows[rowIdx];
          const parsedRow = result.rows[rowIdx];

          for (let colIdx = 0; colIdx < headers.length; colIdx++) {
            const header = headers[colIdx];
            const originalValue = originalCells[colIdx];

            if (originalValue === "") {
              // Empty string input must produce null in the parsed output
              // (applies to string fields; numeric/date fields also return null for empty)
              const parsedValue = parsedRow[header];
              assertEquals(
                parsedValue,
                null,
                `Empty value for "${header}" in row ${rowIdx} must be null, got: ${parsedValue}`
              );
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Null Handling - expense parser converts empty values to null",
  fn: () => {
    fc.assert(
      fc.property(knownExpenseDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseExpenses(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const originalCells = rows[rowIdx];
          const parsedRow = result.rows[rowIdx];

          for (let colIdx = 0; colIdx < headers.length; colIdx++) {
            const header = headers[colIdx];
            const originalValue = originalCells[colIdx];

            if (originalValue === "") {
              const parsedValue = parsedRow[header];
              assertEquals(
                parsedValue,
                null,
                `Empty value for "${header}" in row ${rowIdx} must be null, got: ${parsedValue}`
              );
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Null Handling - property parser converts empty values to null",
  fn: () => {
    fc.assert(
      fc.property(knownPropertyDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseProperties(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const originalCells = rows[rowIdx];
          const parsedRow = result.rows[rowIdx];

          for (let colIdx = 0; colIdx < headers.length; colIdx++) {
            const header = headers[colIdx];
            const originalValue = originalCells[colIdx];

            if (originalValue === "") {
              const parsedValue = parsedRow[header];
              assertEquals(
                parsedValue,
                null,
                `Empty value for "${header}" in row ${rowIdx} must be null, got: ${parsedValue}`
              );
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 6: Null Handling - revenue parser converts empty values to null",
  fn: () => {
    fc.assert(
      fc.property(knownRevenueDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);
        const result = parseRevenues(rawRows);

        assertEquals(result.rows.length, rows.length, "Row count must match");

        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
          const originalCells = rows[rowIdx];
          const parsedRow = result.rows[rowIdx];

          for (let colIdx = 0; colIdx < headers.length; colIdx++) {
            const header = headers[colIdx];
            const originalValue = originalCells[colIdx];

            if (originalValue === "") {
              const parsedValue = parsedRow[header];
              assertEquals(
                parsedValue,
                null,
                `Empty value for "${header}" in row ${rowIdx} must be null, got: ${parsedValue}`
              );
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

// @ts-nocheck
/**
 * Property-Based Test: Parser Round-Trip Preservation
 * Feature: backend-driven-pipeline, Task 3.6
 *
 * **Validates: Requirements 2.8**
 *
 * Property 4: Parser Round-Trip Preservation
 * For any CSV file, parsing it and re-serializing to CSV should preserve all non-null values.
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import fc from "https://esm.sh/fast-check@3.15.0";
import { parseLeases } from "../_shared/parsers/lease-parser.ts";
import { parseExpenses } from "../_shared/parsers/expense-parser.ts";
import { parseProperties } from "../_shared/parsers/property-parser.ts";
import { parseRevenues } from "../_shared/parsers/revenue-parser.ts";

// ---------------------------------------------------------------------------
// CSV pretty-printer (mirrors the design doc's printCSV)
// ---------------------------------------------------------------------------

/**
 * Serialize an array of row objects back to CSV text.
 * Internal fields prefixed with "_" (e.g. _row_number) are excluded.
 */
function printCSV(rows: Array<Record<string, any>>, headers: string[]): string {
  const lines: string[] = [headers.join(",")];
  for (const row of rows) {
    const values = headers.map((h) => {
      const val = row[h];
      if (val == null) return "";
      const str = String(val);
      // Quote values that contain commas, quotes, or newlines
      if (str.includes(",") || str.includes('"') || str.includes("\n")) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    });
    lines.push(values.join(","));
  }
  return lines.join("\n");
}

/**
 * Parse a CSV text string into an array of row objects keyed by header.
 */
function parseCSVText(csvText: string): { headers: string[]; rows: Array<Record<string, string>> } {
  const lines = csvText.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].split(",");
  const rows = lines.slice(1).map((line) => {
    const cells = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cells[i] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Safe column header: lowercase letters and underscores only */
const safeHeaderArb = fc
  .tuple(
    fc.string({ minLength: 3, maxLength: 10, unit: fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m") }),
    fc.string({ minLength: 1, maxLength: 5, unit: fc.constantFrom("n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z") })
  )
  .map(([a, b]) => `${a}_${b}`);

/** Cell value: non-empty string without commas or quotes (to keep CSV simple) */
const safeCellArb = fc.oneof(
  fc.integer({ min: 1, max: 99999 }).map((n) => String(n)),
  fc.string({ minLength: 1, maxLength: 15, unit: fc.constantFrom("a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p") })
);

/** A complete CSV dataset: headers + rows with no empty cells (so all values are non-null) */
const csvDatasetArb = fc
  .array(safeHeaderArb, { minLength: 2, maxLength: 6 })
  .chain((headers) => {
    // Deduplicate headers
    const uniqueHeaders = [...new Set(headers)];
    return fc
      .array(
        fc.array(safeCellArb, { minLength: uniqueHeaders.length, maxLength: uniqueHeaders.length }),
        { minLength: 1, maxLength: 8 }
      )
      .map((rows) => ({ headers: uniqueHeaders, rows }));
  });

// ---------------------------------------------------------------------------
// Helper: build raw row objects from headers + cell arrays
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
// Helper: extract non-internal keys from a parsed row
// ---------------------------------------------------------------------------
function publicKeys(row: Record<string, any>): string[] {
  return Object.keys(row).filter((k) => !k.startsWith("_"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "Property 4: Round-Trip - lease parser preserves all non-null values",
  fn: () => {
    fc.assert(
      fc.property(csvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);

        // First parse
        const firstParse = parseLeases(rawRows);

        // Re-serialize to CSV using the public keys from the first parse
        const firstRow = firstParse.rows[0];
        const outputHeaders = publicKeys(firstRow);
        const csvText = printCSV(firstParse.rows, outputHeaders);

        // Parse the CSV text back into raw rows
        const { rows: reparsedRaw } = parseCSVText(csvText);

        // Second parse
        const secondParse = parseLeases(reparsedRaw);

        // Property: every non-null value in the first parse must equal the
        // corresponding value in the second parse
        assertEquals(
          firstParse.rows.length,
          secondParse.rows.length,
          "Row count must be preserved across round-trip"
        );

        for (let i = 0; i < firstParse.rows.length; i++) {
          const first = firstParse.rows[i];
          const second = secondParse.rows[i];

          for (const key of outputHeaders) {
            const v1 = first[key];
            const v2 = second[key];
            if (v1 !== null && v1 !== undefined) {
              assertEquals(
                v2,
                v1,
                `Round-trip must preserve value for key "${key}" in row ${i}: expected ${v1}, got ${v2}`
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
  name: "Property 4: Round-Trip - expense parser preserves all non-null values",
  fn: () => {
    fc.assert(
      fc.property(csvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);

        const firstParse = parseExpenses(rawRows);
        const firstRow = firstParse.rows[0];
        const outputHeaders = publicKeys(firstRow);
        const csvText = printCSV(firstParse.rows, outputHeaders);

        const { rows: reparsedRaw } = parseCSVText(csvText);
        const secondParse = parseExpenses(reparsedRaw);

        assertEquals(firstParse.rows.length, secondParse.rows.length, "Row count preserved");

        for (let i = 0; i < firstParse.rows.length; i++) {
          const first = firstParse.rows[i];
          const second = secondParse.rows[i];
          for (const key of outputHeaders) {
            const v1 = first[key];
            const v2 = second[key];
            if (v1 !== null && v1 !== undefined) {
              assertEquals(v2, v1, `Round-trip key "${key}" row ${i}: expected ${v1}, got ${v2}`);
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 4: Round-Trip - property parser preserves all non-null values",
  fn: () => {
    fc.assert(
      fc.property(csvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);

        const firstParse = parseProperties(rawRows);
        const firstRow = firstParse.rows[0];
        const outputHeaders = publicKeys(firstRow);
        const csvText = printCSV(firstParse.rows, outputHeaders);

        const { rows: reparsedRaw } = parseCSVText(csvText);
        const secondParse = parseProperties(reparsedRaw);

        assertEquals(firstParse.rows.length, secondParse.rows.length, "Row count preserved");

        for (let i = 0; i < firstParse.rows.length; i++) {
          const first = firstParse.rows[i];
          const second = secondParse.rows[i];
          for (const key of outputHeaders) {
            const v1 = first[key];
            const v2 = second[key];
            if (v1 !== null && v1 !== undefined) {
              assertEquals(v2, v1, `Round-trip key "${key}" row ${i}: expected ${v1}, got ${v2}`);
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

Deno.test({
  name: "Property 4: Round-Trip - revenue parser preserves all non-null values",
  fn: () => {
    fc.assert(
      fc.property(csvDatasetArb, ({ headers, rows }) => {
        const rawRows = buildRawRows(headers, rows);

        const firstParse = parseRevenues(rawRows);
        const firstRow = firstParse.rows[0];
        const outputHeaders = publicKeys(firstRow);
        const csvText = printCSV(firstParse.rows, outputHeaders);

        const { rows: reparsedRaw } = parseCSVText(csvText);
        const secondParse = parseRevenues(reparsedRaw);

        assertEquals(firstParse.rows.length, secondParse.rows.length, "Row count preserved");

        for (let i = 0; i < firstParse.rows.length; i++) {
          const first = firstParse.rows[i];
          const second = secondParse.rows[i];
          for (const key of outputHeaders) {
            const v1 = first[key];
            const v2 = second[key];
            if (v1 !== null && v1 !== undefined) {
              assertEquals(v2, v1, `Round-trip key "${key}" row ${i}: expected ${v1}, got ${v2}`);
            }
          }
        }
      }),
      { numRuns: 100 }
    );
  },
});

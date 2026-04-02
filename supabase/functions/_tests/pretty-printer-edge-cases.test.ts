// @ts-nocheck
/**
 * Unit Tests: Pretty Printer Edge Cases (CSV Escaping)
 * Feature: backend-driven-pipeline, Task 18.5
 *
 * Requirements: 2.7, 18.2
 *
 * Tests CSV cell escaping for special characters:
 * commas, double quotes, newlines, null/undefined, and normal values.
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

// ---------------------------------------------------------------------------
// Pure function under test
// ---------------------------------------------------------------------------

/**
 * Escapes a single CSV cell value.
 * - Wraps in double quotes if value contains comma, double-quote, or newline
 * - Escapes internal double quotes by doubling them ("")
 * - Returns empty string for null/undefined
 * - Returns value unchanged if no special characters
 */
function escapeCSVCell(value: any): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test({
  name: "CSV escaping: value with comma is wrapped in double quotes",
  fn: () => {
    const result = escapeCSVCell("Smith, John");
    assertEquals(result, '"Smith, John"', `Expected '"Smith, John"', got '${result}'`);
  },
});

Deno.test({
  name: 'CSV escaping: value with double quote uses doubled-quote escaping',
  fn: () => {
    const result = escapeCSVCell('He said "hello"');
    assertEquals(
      result,
      '"He said ""hello"""',
      `Expected '"He said ""hello"""', got '${result}'`,
    );
  },
});

Deno.test({
  name: "CSV escaping: value with newline is wrapped in double quotes",
  fn: () => {
    const result = escapeCSVCell("line1\nline2");
    assertEquals(result, '"line1\nline2"', `Expected '"line1\\nline2"', got '${result}'`);
  },
});

Deno.test({
  name: "CSV escaping: null value returns empty string",
  fn: () => {
    const result = escapeCSVCell(null);
    assertEquals(result, "", `Expected empty string for null, got '${result}'`);
  },
});

Deno.test({
  name: "CSV escaping: undefined value returns empty string",
  fn: () => {
    const result = escapeCSVCell(undefined);
    assertEquals(result, "", `Expected empty string for undefined, got '${result}'`);
  },
});

Deno.test({
  name: "CSV escaping: normal value without special chars is returned unchanged",
  fn: () => {
    const result = escapeCSVCell("HelloWorld");
    assertEquals(result, "HelloWorld", `Expected 'HelloWorld' unchanged, got '${result}'`);
  },
});

Deno.test({
  name: "CSV escaping: numeric value is returned as string unchanged",
  fn: () => {
    const result = escapeCSVCell(42);
    assertEquals(result, "42", `Expected '42', got '${result}'`);
  },
});

Deno.test({
  name: "CSV escaping: value with carriage return is wrapped in double quotes",
  fn: () => {
    const result = escapeCSVCell("line1\r\nline2");
    assertEquals(
      result,
      '"line1\r\nline2"',
      `Expected value with CRLF to be quoted`,
    );
  },
});

Deno.test({
  name: "CSV escaping: empty string returns empty string",
  fn: () => {
    const result = escapeCSVCell("");
    assertEquals(result, "", `Expected empty string, got '${result}'`);
  },
});

Deno.test({
  name: "CSV escaping: value with only spaces is returned unchanged",
  fn: () => {
    const result = escapeCSVCell("   ");
    assertEquals(result, "   ", `Expected '   ' unchanged, got '${result}'`);
  },
});

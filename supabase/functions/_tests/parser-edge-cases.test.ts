// @ts-nocheck
/**
 * Unit Tests: Parser Edge Cases
 * Feature: backend-driven-pipeline, Task 3.9
 *
 * **Validates: Requirements 2.4, 2.5, 2.6**
 *
 * Tests:
 * - Empty file (0 rows)
 * - File with only headers (no data rows)
 * - Malformed CSV with mismatched columns
 * - Various date formats (MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD)
 * - International currency formats (€, £, $)
 */

import { assertEquals, assertExists } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parseLeases, normalizeDate, normalizeCurrency } from "../_shared/parsers/lease-parser.ts";
import { parseExpenses } from "../_shared/parsers/expense-parser.ts";
import { parseProperties } from "../_shared/parsers/property-parser.ts";
import { parseRevenues } from "../_shared/parsers/revenue-parser.ts";

// ===========================================================================
// Empty file (0 rows)
// ===========================================================================

Deno.test("Edge Case: empty file - lease parser returns 0 rows and no errors", () => {
  const result = parseLeases([]);
  assertEquals(result.rows.length, 0, "Should return 0 rows for empty input");
  assertEquals(result.errors.length, 0, "Should return 0 errors for empty input");
});

Deno.test("Edge Case: empty file - expense parser returns 0 rows and no errors", () => {
  const result = parseExpenses([]);
  assertEquals(result.rows.length, 0);
  assertEquals(result.errors.length, 0);
});

Deno.test("Edge Case: empty file - property parser returns 0 rows and no errors", () => {
  const result = parseProperties([]);
  assertEquals(result.rows.length, 0);
  assertEquals(result.errors.length, 0);
});

Deno.test("Edge Case: empty file - revenue parser returns 0 rows and no errors", () => {
  const result = parseRevenues([]);
  assertEquals(result.rows.length, 0);
  assertEquals(result.errors.length, 0);
});

// ===========================================================================
// File with only headers (no data rows)
// ===========================================================================

Deno.test("Edge Case: headers only - lease parser returns 0 rows", () => {
  // Simulates a CSV that was parsed into 0 raw rows (only header line existed)
  const result = parseLeases([]);
  assertEquals(result.rows.length, 0, "Headers-only file should produce 0 data rows");
});

Deno.test("Edge Case: headers only - expense parser returns 0 rows", () => {
  const result = parseExpenses([]);
  assertEquals(result.rows.length, 0);
});

Deno.test("Edge Case: headers only - property parser returns 0 rows", () => {
  const result = parseProperties([]);
  assertEquals(result.rows.length, 0);
});

Deno.test("Edge Case: headers only - revenue parser returns 0 rows", () => {
  const result = parseRevenues([]);
  assertEquals(result.rows.length, 0);
});

// ===========================================================================
// Malformed CSV with mismatched columns
// ===========================================================================

Deno.test("Edge Case: mismatched columns - lease parser handles missing fields as null", () => {
  // Row has fewer fields than expected — missing fields should be null
  const rawRows = [
    {
      tenant_name: "Acme Corp",
      // start_date, end_date, monthly_rent intentionally absent
    },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows.length, 1, "Should still produce 1 row");
  assertEquals(result.rows[0].tenant_name, "Acme Corp");
  assertEquals(result.rows[0].start_date, null, "Missing start_date should be null");
  assertEquals(result.rows[0].end_date, null, "Missing end_date should be null");
  assertEquals(result.rows[0].monthly_rent, null, "Missing monthly_rent should be null");
});

Deno.test("Edge Case: mismatched columns - expense parser handles missing fields as null", () => {
  const rawRows = [
    {
      category: "Utilities",
      // amount, date intentionally absent
    },
  ];

  const result = parseExpenses(rawRows);

  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].category, "Utilities");
  assertEquals(result.rows[0].amount, null);
  assertEquals(result.rows[0].date, null);
});

Deno.test("Edge Case: mismatched columns - property parser handles missing fields as null", () => {
  const rawRows = [
    {
      name: "Sunset Plaza",
      // address, city, square_footage intentionally absent
    },
  ];

  const result = parseProperties(rawRows);

  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].name, "Sunset Plaza");
  assertEquals(result.rows[0].address, null);
  assertEquals(result.rows[0].city, null);
  assertEquals(result.rows[0].square_footage, null);
});

Deno.test("Edge Case: mismatched columns - extra unknown columns are preserved", () => {
  const rawRows = [
    {
      tenant_name: "Acme Corp",
      unknown_col_1: "value1",
      unknown_col_2: "value2",
      another_extra: "extra",
    },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows.length, 1);
  assertEquals(result.rows[0].tenant_name, "Acme Corp");
  // Extra columns must be preserved
  assertEquals(result.rows[0].unknown_col_1, "value1");
  assertEquals(result.rows[0].unknown_col_2, "value2");
  assertEquals(result.rows[0].another_extra, "extra");
});

// ===========================================================================
// Various date formats
// ===========================================================================

Deno.test("Date Format: MM/DD/YYYY is normalized to YYYY-MM-DD", () => {
  assertEquals(normalizeDate("01/15/2024"), "2024-01-15");
  assertEquals(normalizeDate("12/31/2023"), "2023-12-31");
  assertEquals(normalizeDate("06/01/2025"), "2025-06-01");
});

Deno.test("Date Format: M/D/YYYY (single-digit month/day) is normalized to YYYY-MM-DD", () => {
  assertEquals(normalizeDate("1/5/2024"), "2024-01-05");
  assertEquals(normalizeDate("3/7/2024"), "2024-03-07");
  assertEquals(normalizeDate("9/1/2023"), "2023-09-01");
});

Deno.test("Date Format: YYYY-MM-DD is preserved as-is", () => {
  assertEquals(normalizeDate("2024-01-15"), "2024-01-15");
  assertEquals(normalizeDate("2023-12-31"), "2023-12-31");
  assertEquals(normalizeDate("2025-06-01"), "2025-06-01");
});

Deno.test("Date Format: null and empty string return null", () => {
  assertEquals(normalizeDate(null), null);
  assertEquals(normalizeDate(""), null);
  assertEquals(normalizeDate("   "), null);
});

Deno.test("Date Format: unrecognized format is returned as-is (not null)", () => {
  // Unrecognized formats pass through so validation layer can catch them
  const result = normalizeDate("January 15, 2024");
  assertEquals(result, "January 15, 2024");
});

Deno.test("Date Format: lease parser normalizes all date fields", () => {
  const rawRows = [
    {
      tenant_name: "Test Tenant",
      start_date: "01/15/2024",
      end_date: "12/31/2026",
      escalation_date: "1/1/2025",
    },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows[0].start_date, "2024-01-15");
  assertEquals(result.rows[0].end_date, "2026-12-31");
  assertEquals(result.rows[0].escalation_date, "2025-01-01");
});

Deno.test("Date Format: expense parser normalizes date field", () => {
  const rawRows = [
    {
      category: "Maintenance",
      date: "3/7/2024",
    },
  ];

  const result = parseExpenses(rawRows);
  assertEquals(result.rows[0].date, "2024-03-07");
});

Deno.test("Date Format: revenue parser normalizes period field", () => {
  const rawRows = [
    {
      revenue_type: "Base Rent",
      period: "06/01/2024",
    },
  ];

  const result = parseRevenues(rawRows);
  assertEquals(result.rows[0].period, "2024-06-01");
});

// ===========================================================================
// International currency formats
// ===========================================================================

Deno.test("Currency Format: USD ($) symbol is removed and value converted to number", () => {
  assertEquals(normalizeCurrency("$1000"), 1000);
  assertEquals(normalizeCurrency("$1,000"), 1000);
  assertEquals(normalizeCurrency("$1,500.75"), 1500.75);
  assertEquals(normalizeCurrency("$ 2500"), 2500);
});

Deno.test("Currency Format: Euro (€) symbol is removed and value converted to number", () => {
  assertEquals(normalizeCurrency("€1000"), 1000);
  assertEquals(normalizeCurrency("€1,000"), 1000);
  assertEquals(normalizeCurrency("€2,500.50"), 2500.50);
});

Deno.test("Currency Format: British Pound (£) symbol is removed and value converted to number", () => {
  assertEquals(normalizeCurrency("£1000"), 1000);
  assertEquals(normalizeCurrency("£1,500"), 1500);
  assertEquals(normalizeCurrency("£3,750.25"), 3750.25);
});

Deno.test("Currency Format: plain number without symbol is converted correctly", () => {
  assertEquals(normalizeCurrency("1000"), 1000);
  assertEquals(normalizeCurrency("1000.50"), 1000.50);
  assertEquals(normalizeCurrency("1,000,000"), 1000000);
});

Deno.test("Currency Format: null and empty string return null", () => {
  assertEquals(normalizeCurrency(null), null);
  assertEquals(normalizeCurrency(""), null);
  assertEquals(normalizeCurrency("   "), null);
});

Deno.test("Currency Format: non-numeric string returns null", () => {
  assertEquals(normalizeCurrency("N/A"), null);
  assertEquals(normalizeCurrency("TBD"), null);
});

Deno.test("Currency Format: lease parser handles all currency symbols in monthly_rent", () => {
  const rawRows = [
    { tenant_name: "Tenant A", monthly_rent: "$2,500.00" },
    { tenant_name: "Tenant B", monthly_rent: "€1,800.00" },
    { tenant_name: "Tenant C", monthly_rent: "£3,200.50" },
    { tenant_name: "Tenant D", monthly_rent: "1500" },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows[0].monthly_rent, 2500);
  assertEquals(result.rows[1].monthly_rent, 1800);
  assertEquals(result.rows[2].monthly_rent, 3200.50);
  assertEquals(result.rows[3].monthly_rent, 1500);
});

Deno.test("Currency Format: expense parser handles all currency symbols in amount", () => {
  const rawRows = [
    { category: "Utilities", amount: "$500.00" },
    { category: "Maintenance", amount: "€750.00" },
    { category: "Insurance", amount: "£1,200.00" },
  ];

  const result = parseExpenses(rawRows);

  assertEquals(result.rows[0].amount, 500);
  assertEquals(result.rows[1].amount, 750);
  assertEquals(result.rows[2].amount, 1200);
});

Deno.test("Currency Format: revenue parser handles all currency symbols in amount", () => {
  const rawRows = [
    { revenue_type: "Base Rent", amount: "$5,000.00" },
    { revenue_type: "CAM Recovery", amount: "€800.00" },
    { revenue_type: "Other Income", amount: "£250.50" },
  ];

  const result = parseRevenues(rawRows);

  assertEquals(result.rows[0].amount, 5000);
  assertEquals(result.rows[1].amount, 800);
  assertEquals(result.rows[2].amount, 250.50);
});

// ===========================================================================
// Row number preservation
// ===========================================================================

Deno.test("Edge Case: row numbers are correctly assigned starting from 2", () => {
  const rawRows = [
    { tenant_name: "Row 1" },
    { tenant_name: "Row 2" },
    { tenant_name: "Row 3" },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows[0]._row_number, 2, "First data row should be row 2 (row 1 is headers)");
  assertEquals(result.rows[1]._row_number, 3);
  assertEquals(result.rows[2]._row_number, 4);
});

// ===========================================================================
// Null value handling
// ===========================================================================

Deno.test("Edge Case: null values in raw rows are preserved as null", () => {
  const rawRows = [
    {
      tenant_name: "Acme Corp",
      start_date: null,
      monthly_rent: null,
    },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows[0].tenant_name, "Acme Corp");
  assertEquals(result.rows[0].start_date, null);
  assertEquals(result.rows[0].monthly_rent, null);
});

Deno.test("Edge Case: empty string values are converted to null for string fields", () => {
  const rawRows = [
    {
      tenant_name: "",
      lease_type: "",
      property_id: "",
    },
  ];

  const result = parseLeases(rawRows);

  assertEquals(result.rows[0].tenant_name, null);
  assertEquals(result.rows[0].lease_type, null);
  assertEquals(result.rows[0].property_id, null);
});

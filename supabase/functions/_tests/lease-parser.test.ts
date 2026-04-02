// @ts-nocheck
/**
 * Unit Tests: Lease Parser Module
 * Feature: backend-driven-pipeline, Task 3.2
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Tests the lease parser module which:
 * - Maps column variations (tenant_name, tenant, lessee → tenant_name)
 * - Converts dates to ISO 8601 format
 * - Converts currency strings to numeric
 * - Preserves row numbers for error reporting
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { 
  parseLeases, 
  normalizeDate, 
  normalizeCurrency, 
  normalizeNumber 
} from "../_shared/parsers/lease-parser.ts";

Deno.test({
  name: "Lease Parser: Maps tenant_name column variations",
  fn: () => {
    // Test various column name variations for tenant_name
    const testCases = [
      { tenant_name: 'John Doe' },
      { tenant: 'Jane Smith' },
      { lessee: 'Bob Johnson' },
      { 'tenant name': 'Alice Brown' },
      { 'lessee name': 'Charlie Wilson' }
    ];
    
    for (const testCase of testCases) {
      const result = parseLeases([testCase]);
      assertEquals(result.rows.length, 1, 'Should parse one row');
      assertEquals(
        result.rows[0].tenant_name !== null, 
        true, 
        `Should map ${Object.keys(testCase)[0]} to tenant_name`
      );
    }
  }
});

Deno.test({
  name: "Lease Parser: Maps start_date column variations",
  fn: () => {
    const testCases = [
      { start_date: '2024-01-01' },
      { start: '2024-01-01' },
      { lease_start: '2024-01-01' },
      { commencement_date: '2024-01-01' },
      { 'lease start': '2024-01-01' }
    ];
    
    for (const testCase of testCases) {
      const result = parseLeases([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].start_date !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to start_date`
      );
    }
  }
});

Deno.test({
  name: "Lease Parser: Maps monthly_rent column variations",
  fn: () => {
    const testCases = [
      { monthly_rent: '1000' },
      { rent: '1000' },
      { base_rent: '1000' },
      { 'monthly rent': '1000' },
      { 'base rent': '1000' }
    ];
    
    for (const testCase of testCases) {
      const result = parseLeases([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].monthly_rent !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to monthly_rent`
      );
    }
  }
});

Deno.test({
  name: "normalizeDate: Converts MM/DD/YYYY to ISO 8601",
  fn: () => {
    assertEquals(normalizeDate('01/15/2024'), '2024-01-15');
    assertEquals(normalizeDate('1/5/2024'), '2024-01-05');
    assertEquals(normalizeDate('12/31/2024'), '2024-12-31');
  }
});

Deno.test({
  name: "normalizeDate: Converts M/D/YYYY to ISO 8601",
  fn: () => {
    assertEquals(normalizeDate('1/1/2024'), '2024-01-01');
    assertEquals(normalizeDate('3/7/2024'), '2024-03-07');
    assertEquals(normalizeDate('11/9/2024'), '2024-11-09');
  }
});

Deno.test({
  name: "normalizeDate: Preserves YYYY-MM-DD format",
  fn: () => {
    assertEquals(normalizeDate('2024-01-15'), '2024-01-15');
    assertEquals(normalizeDate('2024-12-31'), '2024-12-31');
  }
});

Deno.test({
  name: "normalizeDate: Handles null and empty strings",
  fn: () => {
    assertEquals(normalizeDate(null), null);
    assertEquals(normalizeDate(''), null);
    assertEquals(normalizeDate('   '), null);
  }
});

Deno.test({
  name: "normalizeCurrency: Removes dollar sign and converts to number",
  fn: () => {
    assertEquals(normalizeCurrency('$1000'), 1000);
    assertEquals(normalizeCurrency('$1,000'), 1000);
    assertEquals(normalizeCurrency('$1,000.50'), 1000.50);
  }
});

Deno.test({
  name: "normalizeCurrency: Removes euro and pound symbols",
  fn: () => {
    assertEquals(normalizeCurrency('€1000'), 1000);
    assertEquals(normalizeCurrency('£1,500.75'), 1500.75);
  }
});

Deno.test({
  name: "normalizeCurrency: Removes commas and spaces",
  fn: () => {
    assertEquals(normalizeCurrency('1,000'), 1000);
    assertEquals(normalizeCurrency('1 000'), 1000);
    assertEquals(normalizeCurrency('1, 000. 50'), 1000.50);
  }
});

Deno.test({
  name: "normalizeCurrency: Handles plain numbers",
  fn: () => {
    assertEquals(normalizeCurrency('1000'), 1000);
    assertEquals(normalizeCurrency('1000.50'), 1000.50);
  }
});

Deno.test({
  name: "normalizeCurrency: Handles null and empty strings",
  fn: () => {
    assertEquals(normalizeCurrency(null), null);
    assertEquals(normalizeCurrency(''), null);
    assertEquals(normalizeCurrency('   '), null);
  }
});

Deno.test({
  name: "normalizeNumber: Converts string to number",
  fn: () => {
    assertEquals(normalizeNumber('1000'), 1000);
    assertEquals(normalizeNumber('1000.50'), 1000.50);
    assertEquals(normalizeNumber('1,000'), 1000);
  }
});

Deno.test({
  name: "normalizeNumber: Handles null and empty strings",
  fn: () => {
    assertEquals(normalizeNumber(null), null);
    assertEquals(normalizeNumber(''), null);
    assertEquals(normalizeNumber('   '), null);
  }
});

Deno.test({
  name: "Lease Parser: Converts dates to ISO 8601 format",
  fn: () => {
    const rawRows = [
      {
        tenant_name: 'John Doe',
        start_date: '01/15/2024',
        end_date: '12/31/2025'
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0].start_date, '2024-01-15');
    assertEquals(result.rows[0].end_date, '2025-12-31');
  }
});

Deno.test({
  name: "Lease Parser: Converts currency strings to numeric",
  fn: () => {
    const rawRows = [
      {
        tenant_name: 'John Doe',
        monthly_rent: '$1,500.00'
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0].monthly_rent, 1500);
  }
});

Deno.test({
  name: "Lease Parser: Converts square footage to numeric",
  fn: () => {
    const rawRows = [
      {
        tenant_name: 'John Doe',
        square_footage: '1,200'
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0].square_footage, 1200);
  }
});

Deno.test({
  name: "Lease Parser: Preserves row numbers",
  fn: () => {
    const rawRows = [
      { tenant_name: 'John Doe' },
      { tenant_name: 'Jane Smith' },
      { tenant_name: 'Bob Johnson' }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0]._row_number, 2); // Row 1 is headers
    assertEquals(result.rows[1]._row_number, 3);
    assertEquals(result.rows[2]._row_number, 4);
  }
});

Deno.test({
  name: "Lease Parser: Handles missing values as null",
  fn: () => {
    const rawRows = [
      {
        tenant_name: 'John Doe',
        start_date: '2024-01-01',
        end_date: '',
        monthly_rent: null
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0].tenant_name, 'John Doe');
    assertEquals(result.rows[0].start_date, '2024-01-01');
    assertEquals(result.rows[0].end_date, null);
    assertEquals(result.rows[0].monthly_rent, null);
  }
});

Deno.test({
  name: "Lease Parser: Preserves unmapped columns",
  fn: () => {
    const rawRows = [
      {
        tenant_name: 'John Doe',
        custom_field: 'Custom Value',
        another_field: '123'
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0].tenant_name, 'John Doe');
    assertEquals(result.rows[0].custom_field, 'Custom Value');
    assertEquals(result.rows[0].another_field, '123');
  }
});

Deno.test({
  name: "Lease Parser: Complete lease record with all fields",
  fn: () => {
    const rawRows = [
      {
        tenant: 'Acme Corp',
        start: '01/01/2024',
        end: '12/31/2026',
        rent: '$2,500.00',
        sqft: '1,500',
        lease_type: 'triple_net',
        escalation_type: 'fixed',
        escalation_rate: '3.5',
        escalation_date: '01/01/2025',
        property_id: 'prop-123',
        unit_id: 'unit-456'
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows[0].tenant_name, 'Acme Corp');
    assertEquals(result.rows[0].start_date, '2024-01-01');
    assertEquals(result.rows[0].end_date, '2026-12-31');
    assertEquals(result.rows[0].monthly_rent, 2500);
    assertEquals(result.rows[0].square_footage, 1500);
    assertEquals(result.rows[0].lease_type, 'triple_net');
    assertEquals(result.rows[0].escalation_type, 'fixed');
    assertEquals(result.rows[0].escalation_rate, 3.5);
    assertEquals(result.rows[0].escalation_date, '2025-01-01');
    assertEquals(result.rows[0].property_id, 'prop-123');
    assertEquals(result.rows[0].unit_id, 'unit-456');
  }
});

Deno.test({
  name: "Lease Parser: Multiple rows with mixed data",
  fn: () => {
    const rawRows = [
      {
        tenant_name: 'John Doe',
        start_date: '01/15/2024',
        monthly_rent: '$1,000'
      },
      {
        lessee: 'Jane Smith',
        lease_start: '2024-06-01',
        base_rent: '1500'
      },
      {
        tenant: 'Bob Johnson',
        start: '3/1/2024',
        rent: '€2,000.50'
      }
    ];
    
    const result = parseLeases(rawRows);
    
    assertEquals(result.rows.length, 3);
    
    // First row
    assertEquals(result.rows[0].tenant_name, 'John Doe');
    assertEquals(result.rows[0].start_date, '2024-01-15');
    assertEquals(result.rows[0].monthly_rent, 1000);
    
    // Second row
    assertEquals(result.rows[1].tenant_name, 'Jane Smith');
    assertEquals(result.rows[1].start_date, '2024-06-01');
    assertEquals(result.rows[1].monthly_rent, 1500);
    
    // Third row
    assertEquals(result.rows[2].tenant_name, 'Bob Johnson');
    assertEquals(result.rows[2].start_date, '2024-03-01');
    assertEquals(result.rows[2].monthly_rent, 2000.50);
  }
});

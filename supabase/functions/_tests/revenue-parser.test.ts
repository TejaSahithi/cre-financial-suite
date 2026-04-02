// @ts-nocheck
/**
 * Unit Tests: Revenue Parser Module
 * Feature: backend-driven-pipeline, Task 3.5
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Tests the revenue parser module which:
 * - Maps revenue columns (revenue_type, amount, period, property_id)
 * - Handles revenue line item fields
 * - Converts data types appropriately
 * - Preserves row numbers for error reporting
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { 
  parseRevenues, 
  normalizeDate, 
  normalizeCurrency, 
  normalizeNumber
} from "../_shared/parsers/revenue-parser.ts";

Deno.test({
  name: "Revenue Parser: Maps revenue_type column variations",
  fn: () => {
    const testCases = [
      { revenue_type: 'base_rent' },
      { type: 'cam_recovery' },
      { 'revenue type': 'late_fee' },
      { income_type: 'other' },
      { 'income type': 'base_rent' },
      { category: 'cam_recovery' }
    ];
    
    for (const testCase of testCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1, 'Should parse one row');
      assertEquals(
        result.rows[0].revenue_type !== null, 
        true, 
        `Should map ${Object.keys(testCase)[0]} to revenue_type`
      );
      assertEquals(
        result.rows[0].type !== null, 
        true, 
        `Should also map ${Object.keys(testCase)[0]} to type`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Maps amount column variations",
  fn: () => {
    const testCases = [
      { amount: '5000' },
      { revenue_amount: '5000' },
      { 'revenue amount': '5000' },
      { income: '5000' },
      { revenue: '5000' },
      { total: '5000' }
    ];
    
    for (const testCase of testCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].amount !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to amount`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Maps period column variations",
  fn: () => {
    const testCases = [
      { period: '2024-01-01' },
      { date: '2024-01-01' },
      { revenue_date: '2024-01-01' },
      { 'revenue date': '2024-01-01' },
      { transaction_date: '2024-01-01' },
      { 'transaction date': '2024-01-01' }
    ];
    
    for (const testCase of testCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].period !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to period`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Maps property_id column variations",
  fn: () => {
    const testCases = [
      { property_id: 'prop-123' },
      { property: 'prop-456' },
      { 'property id': 'prop-789' },
      { property_name: 'Building A' },
      { 'property name': 'Building B' }
    ];
    
    for (const testCase of testCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].property_id !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to property_id`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Maps lease_id column variations",
  fn: () => {
    const testCases = [
      { lease_id: 'lease-123' },
      { lease: 'lease-456' },
      { 'lease id': 'lease-789' },
      { lease_name: 'Lease A' },
      { 'lease name': 'Lease B' }
    ];
    
    for (const testCase of testCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].lease_id !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to lease_id`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Maps fiscal_year and month column variations",
  fn: () => {
    const fiscalYearCases = [
      { fiscal_year: '2024' },
      { 'fiscal year': '2024' },
      { year: '2024' },
      { fy: '2024' }
    ];
    
    for (const testCase of fiscalYearCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].fiscal_year !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to fiscal_year`
      );
    }
    
    const monthCases = [
      { month: '3' },
      { period_month: '3' },
      { 'period month': '3' },
      { month_number: '3' },
      { 'month number': '3' }
    ];
    
    for (const testCase of monthCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].month !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to month`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Maps notes column variations",
  fn: () => {
    const testCases = [
      { notes: 'Payment received' },
      { note: 'Late payment' },
      { description: 'Monthly rent' },
      { memo: 'Partial payment' },
      { comments: 'Paid in full' },
      { comment: 'Early payment' }
    ];
    
    for (const testCase of testCases) {
      const result = parseRevenues([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].notes !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to notes`
      );
    }
  }
});

Deno.test({
  name: "Revenue Parser: Converts dates to ISO 8601 format",
  fn: () => {
    const rawRows = [
      {
        revenue_type: 'base_rent',
        period: '01/15/2024',
        amount: '5000'
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].period, '2024-01-15');
  }
});

Deno.test({
  name: "Revenue Parser: Converts currency strings to numeric",
  fn: () => {
    const rawRows = [
      {
        revenue_type: 'base_rent',
        amount: '$5,500.00'
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].amount, 5500);
  }
});

Deno.test({
  name: "Revenue Parser: Converts fiscal_year and month to numeric",
  fn: () => {
    const rawRows = [
      {
        revenue_type: 'base_rent',
        fiscal_year: '2024',
        month: '6'
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].fiscal_year, 2024);
    assertEquals(result.rows[0].month, 6);
  }
});

Deno.test({
  name: "Revenue Parser: Preserves row numbers",
  fn: () => {
    const rawRows = [
      { revenue_type: 'base_rent' },
      { revenue_type: 'cam_recovery' },
      { revenue_type: 'late_fee' }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0]._row_number, 2); // Row 1 is headers
    assertEquals(result.rows[1]._row_number, 3);
    assertEquals(result.rows[2]._row_number, 4);
  }
});

Deno.test({
  name: "Revenue Parser: Handles missing values as null",
  fn: () => {
    const rawRows = [
      {
        revenue_type: 'base_rent',
        period: '2024-01-01',
        amount: '',
        notes: null
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].revenue_type, 'base_rent');
    assertEquals(result.rows[0].type, 'base_rent');
    assertEquals(result.rows[0].period, '2024-01-01');
    assertEquals(result.rows[0].amount, null);
    assertEquals(result.rows[0].notes, null);
  }
});

Deno.test({
  name: "Revenue Parser: Preserves unmapped columns",
  fn: () => {
    const rawRows = [
      {
        revenue_type: 'base_rent',
        custom_field: 'Custom Value',
        another_field: '123'
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].revenue_type, 'base_rent');
    assertEquals(result.rows[0].custom_field, 'Custom Value');
    assertEquals(result.rows[0].another_field, '123');
  }
});

Deno.test({
  name: "Revenue Parser: Complete revenue record with all fields",
  fn: () => {
    const rawRows = [
      {
        revenue_type: 'base_rent',
        revenue_amount: '$8,500.00',
        period: '01/15/2024',
        property: 'prop-123',
        lease: 'lease-456',
        fiscal_year: '2024',
        month: '1',
        notes: 'Monthly rent payment'
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].revenue_type, 'base_rent');
    assertEquals(result.rows[0].type, 'base_rent');
    assertEquals(result.rows[0].amount, 8500);
    assertEquals(result.rows[0].period, '2024-01-15');
    assertEquals(result.rows[0].property_id, 'prop-123');
    assertEquals(result.rows[0].lease_id, 'lease-456');
    assertEquals(result.rows[0].fiscal_year, 2024);
    assertEquals(result.rows[0].month, 1);
    assertEquals(result.rows[0].notes, 'Monthly rent payment');
  }
});

Deno.test({
  name: "Revenue Parser: Multiple rows with mixed data",
  fn: () => {
    const rawRows = [
      {
        type: 'base_rent',
        date: '01/15/2024',
        amount: '$5,000'
      },
      {
        revenue_type: 'cam_recovery',
        revenue_date: '2024-02-01',
        income: '1500'
      },
      {
        income_type: 'late_fee',
        transaction_date: '3/1/2024',
        total: '€250.50'
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows.length, 3);
    
    // First row
    assertEquals(result.rows[0].revenue_type, 'base_rent');
    assertEquals(result.rows[0].type, 'base_rent');
    assertEquals(result.rows[0].period, '2024-01-15');
    assertEquals(result.rows[0].amount, 5000);
    
    // Second row
    assertEquals(result.rows[1].revenue_type, 'cam_recovery');
    assertEquals(result.rows[1].type, 'cam_recovery');
    assertEquals(result.rows[1].period, '2024-02-01');
    assertEquals(result.rows[1].amount, 1500);
    
    // Third row
    assertEquals(result.rows[2].revenue_type, 'late_fee');
    assertEquals(result.rows[2].type, 'late_fee');
    assertEquals(result.rows[2].period, '2024-03-01');
    assertEquals(result.rows[2].amount, 250.50);
  }
});

Deno.test({
  name: "Revenue Parser: Handles various revenue types",
  fn: () => {
    const rawRows = [
      { type: 'base_rent', amount: '5000' },
      { type: 'cam_recovery', amount: '1000' },
      { type: 'late_fee', amount: '100' },
      { type: 'other', amount: '500' }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].revenue_type, 'base_rent');
    assertEquals(result.rows[0].type, 'base_rent');
    assertEquals(result.rows[1].revenue_type, 'cam_recovery');
    assertEquals(result.rows[1].type, 'cam_recovery');
    assertEquals(result.rows[2].revenue_type, 'late_fee');
    assertEquals(result.rows[2].type, 'late_fee');
    assertEquals(result.rows[3].revenue_type, 'other');
    assertEquals(result.rows[3].type, 'other');
  }
});

Deno.test({
  name: "Revenue Parser: Handles date format variations",
  fn: () => {
    const rawRows = [
      { period: '2024-01-15' },  // ISO format
      { period: '01/15/2024' },  // MM/DD/YYYY
      { period: '1/5/2024' },    // M/D/YYYY
      { period: '03-20-2024' }   // MM-DD-YYYY
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].period, '2024-01-15');
    assertEquals(result.rows[1].period, '2024-01-15');
    assertEquals(result.rows[2].period, '2024-01-05');
    assertEquals(result.rows[3].period, '2024-03-20');
  }
});

Deno.test({
  name: "Revenue Parser: Handles currency format variations",
  fn: () => {
    const rawRows = [
      { amount: '5000' },
      { amount: '$5,000' },
      { amount: '€5,000.50' },
      { amount: '£ 5,000.75' }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].amount, 5000);
    assertEquals(result.rows[1].amount, 5000);
    assertEquals(result.rows[2].amount, 5000.50);
    assertEquals(result.rows[3].amount, 5000.75);
  }
});

Deno.test({
  name: "Revenue Parser: Empty CSV returns empty result",
  fn: () => {
    const rawRows: Array<Record<string, any>> = [];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows.length, 0);
    assertEquals(result.errors.length, 0);
  }
});

Deno.test({
  name: "Revenue Parser: Trims whitespace from string fields",
  fn: () => {
    const rawRows = [
      {
        revenue_type: '  base_rent  ',
        property_id: '  prop-123  ',
        notes: '  Payment received  '
      }
    ];
    
    const result = parseRevenues(rawRows);
    
    assertEquals(result.rows[0].revenue_type, 'base_rent');
    assertEquals(result.rows[0].type, 'base_rent');
    assertEquals(result.rows[0].property_id, 'prop-123');
    assertEquals(result.rows[0].notes, 'Payment received');
  }
});

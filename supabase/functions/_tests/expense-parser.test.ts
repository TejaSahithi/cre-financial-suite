// @ts-nocheck
/**
 * Unit Tests: Expense Parser Module
 * Feature: backend-driven-pipeline, Task 3.3
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Tests the expense parser module which:
 * - Maps expense-specific columns (category, amount, date, property_id)
 * - Handles expense classification fields
 * - Converts data types appropriately
 * - Preserves row numbers for error reporting
 */

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { 
  parseExpenses, 
  normalizeDate, 
  normalizeCurrency, 
  normalizeNumber,
  normalizeBoolean
} from "../_shared/parsers/expense-parser.ts";

Deno.test({
  name: "Expense Parser: Maps category column variations",
  fn: () => {
    const testCases = [
      { category: 'Utilities' },
      { expense_category: 'Maintenance' },
      { 'expense category': 'Insurance' },
      { type: 'Repairs' },
      { expense_type: 'Taxes' }
    ];
    
    for (const testCase of testCases) {
      const result = parseExpenses([testCase]);
      assertEquals(result.rows.length, 1, 'Should parse one row');
      assertEquals(
        result.rows[0].category !== null, 
        true, 
        `Should map ${Object.keys(testCase)[0]} to category`
      );
    }
  }
});

Deno.test({
  name: "Expense Parser: Maps amount column variations",
  fn: () => {
    const testCases = [
      { amount: '1000' },
      { expense_amount: '1000' },
      { 'expense amount': '1000' },
      { cost: '1000' },
      { total: '1000' }
    ];
    
    for (const testCase of testCases) {
      const result = parseExpenses([testCase]);
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
  name: "Expense Parser: Maps date column variations",
  fn: () => {
    const testCases = [
      { date: '2024-01-01' },
      { expense_date: '2024-01-01' },
      { 'expense date': '2024-01-01' },
      { transaction_date: '2024-01-01' },
      { 'transaction date': '2024-01-01' }
    ];
    
    for (const testCase of testCases) {
      const result = parseExpenses([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].date !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to date`
      );
    }
  }
});

Deno.test({
  name: "Expense Parser: Maps property_id column variations",
  fn: () => {
    const testCases = [
      { property_id: 'prop-123' },
      { property: 'prop-456' },
      { 'property id': 'prop-789' },
      { property_name: 'Building A' }
    ];
    
    for (const testCase of testCases) {
      const result = parseExpenses([testCase]);
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
  name: "Expense Parser: Maps classification column variations",
  fn: () => {
    const testCases = [
      { classification: 'recoverable' },
      { expense_classification: 'non_recoverable' },
      { recoverable: 'conditional' },
      { recovery_type: 'recoverable' }
    ];
    
    for (const testCase of testCases) {
      const result = parseExpenses([testCase]);
      assertEquals(result.rows.length, 1);
      assertEquals(
        result.rows[0].classification !== null,
        true,
        `Should map ${Object.keys(testCase)[0]} to classification`
      );
    }
  }
});

Deno.test({
  name: "normalizeBoolean: Converts true variations",
  fn: () => {
    assertEquals(normalizeBoolean('true'), true);
    assertEquals(normalizeBoolean('True'), true);
    assertEquals(normalizeBoolean('TRUE'), true);
    assertEquals(normalizeBoolean('yes'), true);
    assertEquals(normalizeBoolean('Yes'), true);
    assertEquals(normalizeBoolean('1'), true);
    assertEquals(normalizeBoolean('y'), true);
    assertEquals(normalizeBoolean('Y'), true);
  }
});

Deno.test({
  name: "normalizeBoolean: Converts false variations",
  fn: () => {
    assertEquals(normalizeBoolean('false'), false);
    assertEquals(normalizeBoolean('False'), false);
    assertEquals(normalizeBoolean('FALSE'), false);
    assertEquals(normalizeBoolean('no'), false);
    assertEquals(normalizeBoolean('No'), false);
    assertEquals(normalizeBoolean('0'), false);
    assertEquals(normalizeBoolean('n'), false);
    assertEquals(normalizeBoolean('N'), false);
  }
});

Deno.test({
  name: "normalizeBoolean: Handles null and empty strings",
  fn: () => {
    assertEquals(normalizeBoolean(null), null);
    assertEquals(normalizeBoolean(''), null);
    assertEquals(normalizeBoolean('   '), null);
  }
});

Deno.test({
  name: "normalizeBoolean: Returns null for invalid values",
  fn: () => {
    assertEquals(normalizeBoolean('maybe'), null);
    assertEquals(normalizeBoolean('invalid'), null);
    assertEquals(normalizeBoolean('2'), null);
  }
});

Deno.test({
  name: "Expense Parser: Converts dates to ISO 8601 format",
  fn: () => {
    const rawRows = [
      {
        category: 'Utilities',
        date: '01/15/2024',
        amount: '1000'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].date, '2024-01-15');
  }
});

Deno.test({
  name: "Expense Parser: Converts currency strings to numeric",
  fn: () => {
    const rawRows = [
      {
        category: 'Maintenance',
        amount: '$1,500.00'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].amount, 1500);
  }
});

Deno.test({
  name: "Expense Parser: Converts fiscal_year and month to numeric",
  fn: () => {
    const rawRows = [
      {
        category: 'Insurance',
        fiscal_year: '2024',
        month: '3'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].fiscal_year, 2024);
    assertEquals(result.rows[0].month, 3);
  }
});

Deno.test({
  name: "Expense Parser: Converts is_controllable to boolean",
  fn: () => {
    const rawRows = [
      {
        category: 'Utilities',
        is_controllable: 'yes'
      },
      {
        category: 'Taxes',
        controllable: 'no'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].is_controllable, true);
    assertEquals(result.rows[1].is_controllable, false);
  }
});

Deno.test({
  name: "Expense Parser: Preserves row numbers",
  fn: () => {
    const rawRows = [
      { category: 'Utilities' },
      { category: 'Maintenance' },
      { category: 'Insurance' }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0]._row_number, 2); // Row 1 is headers
    assertEquals(result.rows[1]._row_number, 3);
    assertEquals(result.rows[2]._row_number, 4);
  }
});

Deno.test({
  name: "Expense Parser: Handles missing values as null",
  fn: () => {
    const rawRows = [
      {
        category: 'Utilities',
        date: '2024-01-01',
        amount: '',
        vendor: null
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].category, 'Utilities');
    assertEquals(result.rows[0].date, '2024-01-01');
    assertEquals(result.rows[0].amount, null);
    assertEquals(result.rows[0].vendor, null);
  }
});

Deno.test({
  name: "Expense Parser: Preserves unmapped columns",
  fn: () => {
    const rawRows = [
      {
        category: 'Utilities',
        custom_field: 'Custom Value',
        another_field: '123'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].category, 'Utilities');
    assertEquals(result.rows[0].custom_field, 'Custom Value');
    assertEquals(result.rows[0].another_field, '123');
  }
});

Deno.test({
  name: "Expense Parser: Complete expense record with all fields",
  fn: () => {
    const rawRows = [
      {
        expense_category: 'Utilities',
        expense_amount: '$2,500.00',
        expense_date: '01/15/2024',
        property: 'prop-123',
        expense_classification: 'recoverable',
        vendor_name: 'ABC Services',
        vendor_id: 'vendor-456',
        gl_code: '5100',
        fiscal_year: '2024',
        month: '1',
        data_source: 'manual',
        controllable: 'yes'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].category, 'Utilities');
    assertEquals(result.rows[0].amount, 2500);
    assertEquals(result.rows[0].date, '2024-01-15');
    assertEquals(result.rows[0].property_id, 'prop-123');
    assertEquals(result.rows[0].classification, 'recoverable');
    assertEquals(result.rows[0].vendor, 'ABC Services');
    assertEquals(result.rows[0].vendor_id, 'vendor-456');
    assertEquals(result.rows[0].gl_code, '5100');
    assertEquals(result.rows[0].fiscal_year, 2024);
    assertEquals(result.rows[0].month, 1);
    assertEquals(result.rows[0].source, 'manual');
    assertEquals(result.rows[0].is_controllable, true);
  }
});

Deno.test({
  name: "Expense Parser: Multiple rows with mixed data",
  fn: () => {
    const rawRows = [
      {
        category: 'Utilities',
        date: '01/15/2024',
        amount: '$1,000'
      },
      {
        expense_category: 'Maintenance',
        expense_date: '2024-02-01',
        cost: '1500'
      },
      {
        type: 'Insurance',
        transaction_date: '3/1/2024',
        total: '€2,000.50'
      }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows.length, 3);
    
    // First row
    assertEquals(result.rows[0].category, 'Utilities');
    assertEquals(result.rows[0].date, '2024-01-15');
    assertEquals(result.rows[0].amount, 1000);
    
    // Second row
    assertEquals(result.rows[1].category, 'Maintenance');
    assertEquals(result.rows[1].date, '2024-02-01');
    assertEquals(result.rows[1].amount, 1500);
    
    // Third row
    assertEquals(result.rows[2].category, 'Insurance');
    assertEquals(result.rows[2].date, '2024-03-01');
    assertEquals(result.rows[2].amount, 2000.50);
  }
});

Deno.test({
  name: "Expense Parser: Handles vendor column variations",
  fn: () => {
    const rawRows = [
      { vendor: 'ABC Corp' },
      { vendor_name: 'XYZ Services' },
      { supplier: 'DEF Company' },
      { payee: 'GHI Inc' }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].vendor, 'ABC Corp');
    assertEquals(result.rows[1].vendor, 'XYZ Services');
    assertEquals(result.rows[2].vendor, 'DEF Company');
    assertEquals(result.rows[3].vendor, 'GHI Inc');
  }
});

Deno.test({
  name: "Expense Parser: Handles GL code column variations",
  fn: () => {
    const rawRows = [
      { gl_code: '5100' },
      { 'gl code': '5200' },
      { account_code: '5300' },
      { gl_account: '5400' }
    ];
    
    const result = parseExpenses(rawRows);
    
    assertEquals(result.rows[0].gl_code, '5100');
    assertEquals(result.rows[1].gl_code, '5200');
    assertEquals(result.rows[2].gl_code, '5300');
    assertEquals(result.rows[3].gl_code, '5400');
  }
});

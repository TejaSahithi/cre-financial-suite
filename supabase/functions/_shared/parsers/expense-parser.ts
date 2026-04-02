// @ts-nocheck
/**
 * Expense Parser Module
 * Feature: backend-driven-pipeline, Task 3.3
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Parses expense data from CSV format:
 * - Maps expense-specific columns (category, amount, date, property_id)
 * - Handles expense classification fields
 * - Converts data types appropriately
 * - Preserves row numbers for error reporting
 */

export interface ParsedExpense {
  category: string | null;
  amount: number | null;
  date: string | null;
  property_id: string | null;
  classification: string | null;
  vendor: string | null;
  vendor_id: string | null;
  gl_code: string | null;
  fiscal_year: number | null;
  month: number | null;
  source: string | null;
  is_controllable: boolean | null;
  [key: string]: string | number | boolean | null;
  _row_number?: number;
}

export interface ExpenseParseResult {
  rows: ParsedExpense[];
  errors: Array<{
    row: number;
    field: string;
    message: string;
  }>;
}

/**
 * Column mapping for expense fields
 * Maps various column name variations to standardized field names
 */
const COLUMN_MAPPINGS: Record<string, string[]> = {
  category: ['category', 'expense_category', 'expense category', 'type', 'expense_type', 'expense type'],
  amount: ['amount', 'expense_amount', 'expense amount', 'cost', 'total', 'expense'],
  date: ['date', 'expense_date', 'expense date', 'transaction_date', 'transaction date'],
  property_id: ['property_id', 'property', 'property id', 'property_name', 'property name'],
  classification: ['classification', 'expense_classification', 'expense classification', 'recoverable', 'recovery_type', 'recovery type'],
  vendor: ['vendor', 'vendor_name', 'vendor name', 'supplier', 'payee'],
  vendor_id: ['vendor_id', 'vendor id', 'supplier_id', 'supplier id'],
  gl_code: ['gl_code', 'gl code', 'account_code', 'account code', 'gl_account', 'gl account'],
  fiscal_year: ['fiscal_year', 'fiscal year', 'year', 'fy'],
  month: ['month', 'period', 'month_number', 'month number'],
  source: ['source', 'data_source', 'data source', 'origin'],
  is_controllable: ['is_controllable', 'controllable', 'is controllable', 'can_control', 'can control']
};

/**
 * Find the standardized field name for a given column header
 */
function findStandardFieldName(columnHeader: string): string | null {
  const normalized = columnHeader.toLowerCase().trim();
  
  for (const [standardName, variations] of Object.entries(COLUMN_MAPPINGS)) {
    if (variations.includes(normalized)) {
      return standardName;
    }
  }
  
  return null;
}

/**
 * Convert date string to ISO 8601 format (YYYY-MM-DD)
 * Handles formats: MM/DD/YYYY, M/D/YYYY, YYYY-MM-DD
 */
export function normalizeDate(dateStr: string | null): string | null {
  if (!dateStr || dateStr.trim() === '') {
    return null;
  }
  
  const trimmed = dateStr.trim();
  
  // Already in ISO format (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  
  // Handle MM/DD/YYYY or M/D/YYYY format
  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const month = slashMatch[1].padStart(2, '0');
    const day = slashMatch[2].padStart(2, '0');
    const year = slashMatch[3];
    return `${year}-${month}-${day}`;
  }
  
  // Handle MM-DD-YYYY or M-D-YYYY format
  const dashMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (dashMatch) {
    const month = dashMatch[1].padStart(2, '0');
    const day = dashMatch[2].padStart(2, '0');
    const year = dashMatch[3];
    return `${year}-${month}-${day}`;
  }
  
  // Return original if format not recognized (validation will catch this)
  return trimmed;
}

/**
 * Convert currency string to numeric value
 * Removes symbols ($, €, £), commas, and spaces
 */
export function normalizeCurrency(currencyStr: string | null): number | null {
  if (!currencyStr || currencyStr.trim() === '') {
    return null;
  }
  
  const trimmed = currencyStr.trim();
  
  // Remove currency symbols, commas, and spaces
  const cleaned = trimmed
    .replace(/[$€£,\s]/g, '')
    .trim();
  
  if (cleaned === '') {
    return null;
  }
  
  const parsed = parseFloat(cleaned);
  
  return isNaN(parsed) ? null : parsed;
}

/**
 * Convert string to number
 */
export function normalizeNumber(numStr: string | null): number | null {
  if (!numStr || numStr.trim() === '') {
    return null;
  }
  
  const trimmed = numStr.trim();
  
  // Remove commas
  const cleaned = trimmed.replace(/,/g, '');
  
  const parsed = parseFloat(cleaned);
  
  return isNaN(parsed) ? null : parsed;
}

/**
 * Convert string to boolean
 * Handles: true/false, yes/no, 1/0, y/n
 */
export function normalizeBoolean(boolStr: string | null): boolean | null {
  if (!boolStr || boolStr.trim() === '') {
    return null;
  }
  
  const normalized = boolStr.toLowerCase().trim();
  
  if (['true', 'yes', '1', 'y'].includes(normalized)) {
    return true;
  }
  
  if (['false', 'no', '0', 'n'].includes(normalized)) {
    return false;
  }
  
  return null;
}

/**
 * Parse expense data from raw CSV rows
 * 
 * @param rawRows - Array of raw CSV row objects with original column names
 * @returns ExpenseParseResult with parsed rows and any errors
 */
export function parseExpenses(rawRows: Array<Record<string, any>>): ExpenseParseResult {
  const parsedRows: ParsedExpense[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  
  for (let i = 0; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    const rowNumber = i + 2; // +2 because row 1 is headers, and we're 0-indexed
    
    const parsedRow: ParsedExpense = {
      category: null,
      amount: null,
      date: null,
      property_id: null,
      classification: null,
      vendor: null,
      vendor_id: null,
      gl_code: null,
      fiscal_year: null,
      month: null,
      source: null,
      is_controllable: null,
      _row_number: rowNumber
    };
    
    // Map columns to standardized field names
    for (const [columnName, value] of Object.entries(rawRow)) {
      const standardField = findStandardFieldName(columnName);
      
      if (standardField) {
        // Apply type conversions based on field type
        if (standardField === 'date') {
          parsedRow[standardField] = normalizeDate(value as string);
        } else if (standardField === 'amount') {
          parsedRow[standardField] = normalizeCurrency(value as string);
        } else if (standardField === 'fiscal_year' || standardField === 'month') {
          parsedRow[standardField] = normalizeNumber(value as string);
        } else if (standardField === 'is_controllable') {
          parsedRow[standardField] = normalizeBoolean(value as string);
        } else {
          // String fields - preserve as-is or null
          parsedRow[standardField] = value === null || value === '' ? null : String(value).trim();
        }
      } else {
        // Preserve unmapped columns as-is
        parsedRow[columnName] = value;
      }
    }
    
    parsedRows.push(parsedRow);
  }
  
  return {
    rows: parsedRows,
    errors
  };
}

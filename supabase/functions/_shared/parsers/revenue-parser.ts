// @ts-nocheck
/**
 * Revenue Parser Module
 * Feature: backend-driven-pipeline, Task 3.5
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Parses revenue data from CSV format:
 * - Maps revenue columns (revenue_type, amount, period, property_id)
 * - Handles revenue line item fields
 * - Converts data types appropriately
 * - Preserves row numbers for error reporting
 */

export interface ParsedRevenue {
  revenue_type: string | null;
  type: string | null;
  amount: number | null;
  period: string | null;
  property_id: string | null;
  lease_id: string | null;
  fiscal_year: number | null;
  month: number | null;
  notes: string | null;
  [key: string]: string | number | null;
  _row_number?: number;
}

export interface RevenueParseResult {
  rows: ParsedRevenue[];
  errors: Array<{
    row: number;
    field: string;
    message: string;
  }>;
}

/**
 * Column mapping for revenue fields
 * Maps various column name variations to standardized field names
 */
const COLUMN_MAPPINGS: Record<string, string[]> = {
  revenue_type: ['revenue_type', 'type', 'revenue type', 'income_type', 'income type', 'category'],
  amount: ['amount', 'revenue_amount', 'revenue amount', 'income', 'revenue', 'total'],
  period: ['period', 'date', 'revenue_date', 'revenue date', 'transaction_date', 'transaction date'],
  property_id: ['property_id', 'property', 'property id', 'property_name', 'property name'],
  lease_id: ['lease_id', 'lease', 'lease id', 'lease_name', 'lease name'],
  fiscal_year: ['fiscal_year', 'fiscal year', 'year', 'fy'],
  month: ['month', 'period_month', 'period month', 'month_number', 'month number'],
  notes: ['notes', 'note', 'description', 'memo', 'comments', 'comment']
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
 * Parse revenue data from raw CSV rows
 * 
 * @param rawRows - Array of raw CSV row objects with original column names
 * @returns RevenueParseResult with parsed rows and any errors
 */
export function parseRevenues(rawRows: Array<Record<string, any>>): RevenueParseResult {
  const parsedRows: ParsedRevenue[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  
  for (let i = 0; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    const rowNumber = i + 2; // +2 because row 1 is headers, and we're 0-indexed
    
    const parsedRow: ParsedRevenue = {
      revenue_type: null,
      type: null,
      amount: null,
      period: null,
      property_id: null,
      lease_id: null,
      fiscal_year: null,
      month: null,
      notes: null,
      _row_number: rowNumber
    };
    
    // Map columns to standardized field names
    for (const [columnName, value] of Object.entries(rawRow)) {
      const standardField = findStandardFieldName(columnName);
      
      if (standardField) {
        // Apply type conversions based on field type
        if (standardField === 'period') {
          parsedRow[standardField] = normalizeDate(value as string);
        } else if (standardField === 'amount') {
          parsedRow[standardField] = normalizeCurrency(value as string);
        } else if (standardField === 'fiscal_year' || standardField === 'month') {
          parsedRow[standardField] = normalizeNumber(value as string);
        } else if (standardField === 'revenue_type') {
          // Map revenue_type to both revenue_type and type fields
          const normalizedValue = value === null || value === '' ? null : String(value).trim();
          parsedRow.revenue_type = normalizedValue;
          parsedRow.type = normalizedValue;
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

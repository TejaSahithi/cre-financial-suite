// @ts-nocheck
/**
 * Lease Parser Module
 * Feature: backend-driven-pipeline, Task 3.2
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Parses lease data from CSV format:
 * - Maps column variations (tenant_name, tenant, lessee → tenant_name)
 * - Converts dates to ISO 8601 format
 * - Converts currency strings to numeric
 * - Preserves row numbers for error reporting
 */

export interface ParsedLease {
  tenant_name: string | null;
  start_date: string | null;
  end_date: string | null;
  monthly_rent: number | null;
  square_footage: number | null;
  lease_type: string | null;
  escalation_type: string | null;
  escalation_rate: number | null;
  escalation_date: string | null;
  property_id: string | null;
  unit_id: string | null;
  [key: string]: string | number | null;
  _row_number?: number;
}

export interface LeaseParseResult {
  rows: ParsedLease[];
  errors: Array<{
    row: number;
    field: string;
    message: string;
  }>;
}

/**
 * Column mapping for lease fields
 * Maps various column name variations to standardized field names
 */
const COLUMN_MAPPINGS: Record<string, string[]> = {
  tenant_name: ['tenant_name', 'tenant', 'lessee', 'tenant name', 'lessee name'],
  start_date: ['start_date', 'start', 'lease_start', 'commencement_date', 'lease start', 'commencement date'],
  end_date: ['end_date', 'end', 'lease_end', 'expiration_date', 'lease end', 'expiration date'],
  monthly_rent: ['monthly_rent', 'rent', 'base_rent', 'monthly rent', 'base rent'],
  square_footage: ['square_footage', 'sqft', 'sq_ft', 'area', 'square footage'],
  lease_type: ['lease_type', 'type', 'lease type'],
  escalation_type: ['escalation_type', 'escalation', 'escalation type'],
  escalation_rate: ['escalation_rate', 'escalation_pct', 'escalation rate', 'escalation pct'],
  escalation_date: ['escalation_date', 'escalation_start', 'escalation date', 'escalation start'],
  property_id: ['property_id', 'property', 'property id'],
  unit_id: ['unit_id', 'unit', 'unit id']
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
 * Parse lease data from raw CSV rows
 * 
 * @param rawRows - Array of raw CSV row objects with original column names
 * @returns LeaseParseResult with parsed rows and any errors
 */
export function parseLeases(rawRows: Array<Record<string, any>>): LeaseParseResult {
  const parsedRows: ParsedLease[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  
  for (let i = 0; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    const rowNumber = i + 2; // +2 because row 1 is headers, and we're 0-indexed
    
    const parsedRow: ParsedLease = {
      tenant_name: null,
      start_date: null,
      end_date: null,
      monthly_rent: null,
      square_footage: null,
      lease_type: null,
      escalation_type: null,
      escalation_rate: null,
      escalation_date: null,
      property_id: null,
      unit_id: null,
      _row_number: rowNumber
    };
    
    // Map columns to standardized field names
    for (const [columnName, value] of Object.entries(rawRow)) {
      const standardField = findStandardFieldName(columnName);
      
      if (standardField) {
        // Apply type conversions based on field type
        if (standardField === 'start_date' || standardField === 'end_date' || standardField === 'escalation_date') {
          parsedRow[standardField] = normalizeDate(value as string);
        } else if (standardField === 'monthly_rent') {
          parsedRow[standardField] = normalizeCurrency(value as string);
        } else if (standardField === 'square_footage' || standardField === 'escalation_rate') {
          parsedRow[standardField] = normalizeNumber(value as string);
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

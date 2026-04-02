// @ts-nocheck
/**
 * Property Parser Module
 * Feature: backend-driven-pipeline, Task 3.4
 * 
 * **Validates: Requirements 2.2, 2.5, 2.6**
 * 
 * Parses property data from CSV format:
 * - Maps property columns (name, address, square_footage, property_type)
 * - Handles portfolio/building/unit hierarchy fields
 * - Converts data types appropriately
 * - Preserves row numbers for error reporting
 */

export interface ParsedProperty {
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  square_footage: number | null;
  property_type: string | null;
  portfolio_id: string | null;
  portfolio_name: string | null;
  building_id: string | null;
  building_name: string | null;
  unit_id: string | null;
  unit_number: string | null;
  year_built: number | null;
  number_of_units: number | null;
  [key: string]: string | number | null;
  _row_number?: number;
}

export interface PropertyParseResult {
  rows: ParsedProperty[];
  errors: Array<{
    row: number;
    field: string;
    message: string;
  }>;
}

/**
 * Column mapping for property fields
 * Maps various column name variations to standardized field names
 */
const COLUMN_MAPPINGS: Record<string, string[]> = {
  name: ['name', 'property_name', 'property name', 'property', 'building_name', 'building name'],
  address: ['address', 'street_address', 'street address', 'street', 'location'],
  city: ['city', 'municipality', 'town'],
  state: ['state', 'province', 'region'],
  zip_code: ['zip_code', 'zip', 'postal_code', 'postal code', 'zipcode', 'zip code'],
  square_footage: ['square_footage', 'sqft', 'sq_ft', 'area', 'square footage', 'total_area', 'total area'],
  property_type: ['property_type', 'type', 'property type', 'asset_type', 'asset type'],
  portfolio_id: ['portfolio_id', 'portfolio', 'portfolio id'],
  portfolio_name: ['portfolio_name', 'portfolio name'],
  building_id: ['building_id', 'building', 'building id'],
  building_name: ['building_name', 'building name'],
  unit_id: ['unit_id', 'unit', 'unit id'],
  unit_number: ['unit_number', 'unit number', 'unit_no', 'unit no', 'suite', 'suite_number', 'suite number'],
  year_built: ['year_built', 'year built', 'construction_year', 'construction year', 'built_year', 'built year'],
  number_of_units: ['number_of_units', 'number of units', 'unit_count', 'unit count', 'total_units', 'total units']
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
 * Parse property data from raw CSV rows
 * 
 * @param rawRows - Array of raw CSV row objects with original column names
 * @returns PropertyParseResult with parsed rows and any errors
 */
export function parseProperties(rawRows: Array<Record<string, any>>): PropertyParseResult {
  const parsedRows: ParsedProperty[] = [];
  const errors: Array<{ row: number; field: string; message: string }> = [];
  
  for (let i = 0; i < rawRows.length; i++) {
    const rawRow = rawRows[i];
    const rowNumber = i + 2; // +2 because row 1 is headers, and we're 0-indexed
    
    const parsedRow: ParsedProperty = {
      name: null,
      address: null,
      city: null,
      state: null,
      zip_code: null,
      square_footage: null,
      property_type: null,
      portfolio_id: null,
      portfolio_name: null,
      building_id: null,
      building_name: null,
      unit_id: null,
      unit_number: null,
      year_built: null,
      number_of_units: null,
      _row_number: rowNumber
    };
    
    // Map columns to standardized field names
    for (const [columnName, value] of Object.entries(rawRow)) {
      const standardField = findStandardFieldName(columnName);
      
      if (standardField) {
        // Apply type conversions based on field type
        if (standardField === 'square_footage' || standardField === 'year_built' || standardField === 'number_of_units') {
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

// @ts-nocheck
/**
 * Property Parser Module
 * Feature: backend-driven-pipeline, Task 3.4
 *
 * Parses property data from CSV rows into the canonical field set used by
 * BulkImportModal.jsx (MODULE_FIELDS.property).
 *
 * IMPORTANT: output keys MUST match MODULE_FIELDS canonical keys exactly.
 * Any mismatch causes fields to be silently dropped by the strict
 * allowedKeys filter in buildRows().
 *
 * Canonical key  ←  common CSV column name(s)
 * ---------------------------------------------------------------------------
 * zip            ←  zip, zip_code, zipcode, postal_code
 * total_sf       ←  total_sf, total_sqft, square_footage, sqft, …
 * total_units    ←  total_units, number_of_units, unit_count, …
 * leased_sf      ←  leased_sf, leased_sqft
 * total_buildings←  total_buildings, buildings, building_count
 * occupancy_pct  ←  occupancy_pct, occupancy_rate, occupancy
 * …etc.
 */

export interface ParsedProperty {
  property_id_code: string | null;
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  property_type: string | null;
  structure_type: string | null;
  status: string | null;
  total_sf: number | null;
  leased_sf: number | null;
  total_buildings: number | null;
  total_units: number | null;
  occupancy_pct: number | null;
  floors: number | null;
  year_built: number | null;
  purchase_price: number | null;
  market_value: number | null;
  noi: number | null;
  cap_rate: number | null;
  manager: string | null;
  owner: string | null;
  contact: string | null;
  phone: string | null;
  email: string | null;
  acquired_date: string | null;
  parcel_tax_id: string | null;
  parking_spaces: number | null;
  amenities: string | null;
  insurance_policy: string | null;
  notes: string | null;
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
 * Column mapping: canonical-key → accepted CSV header variations (lowercase).
 * Keys must exactly match MODULE_FIELDS.property[].key in BulkImportModal.jsx.
 */
const COLUMN_MAPPINGS: Record<string, string[]> = {
  property_id_code: ['property_id_code', 'property_id', 'property_code', 'asset_id', 'prop_id', 'id_code'],
  name: ['name', 'property_name', 'property name', 'property', 'asset_name', 'asset name', 'project_name', 'site_name'],
  address: ['address', 'street_address', 'street address', 'street', 'location', 'property_address', 'premises_address', 'address_line_1', 'address1'],
  city: ['city', 'municipality', 'town'],
  state: ['state', 'province', 'region'],
  zip: ['zip', 'zip_code', 'zipcode', 'postal_code', 'postal code', 'zip code'],
  property_type: ['property_type', 'type', 'property type', 'asset_type', 'asset type', 'building_type', 'use_type'],
  structure_type: ['structure_type', 'structure type', 'building_structure'],
  status: ['status', 'asset_status', 'property_status'],
  // SF / size
  total_sf: ['total_sf', 'total_sqft', 'square_footage', 'sqft', 'sq_ft', 'square feet', 'square footage', 'total_area', 'rentable_sf', 'gla', 'gross_leasable_area', 'nra', 'total_square_feet'],
  leased_sf: ['leased_sf', 'leased_sqft', 'leased sqft', 'occupied_sf', 'occupied sqft'],
  total_buildings: ['total_buildings', 'buildings', 'building_count', 'number_of_buildings'],
  total_units: ['total_units', 'number_of_units', 'number of units', 'unit_count', 'unit count', 'units'],
  occupancy_pct: ['occupancy_pct', 'occupancy_rate', 'occupancy', 'occupancy %', 'occupancy_percent', 'occ_pct'],
  floors: ['floors', 'floor_count', 'number_of_floors', 'stories', 'num_floors'],
  year_built: ['year_built', 'year built', 'construction_year', 'construction year', 'built_year', 'built'],
  // Financial
  purchase_price: ['purchase_price', 'acquisition_price', 'cost_basis', 'purchase price'],
  market_value: ['market_value', 'appraised_value', 'current_value', 'assessed_value', 'market value', 'valuation'],
  noi: ['noi', 'net_operating_income', 'annual_noi', 'net operating income'],
  cap_rate: ['cap_rate', 'capitalization_rate', 'cap rate'],
  // People
  manager: ['manager', 'property_manager', 'manager_name', 'managed_by'],
  owner: ['owner', 'owner_name', 'ownership', 'owner_entity'],
  contact: ['contact', 'property_contact', 'contact_info'],
  phone: ['phone', 'telephone', 'phone_number', 'contact_phone'],
  email: ['email', 'email_address', 'contact_email'],
  // Legal / misc
  acquired_date: ['acquired_date', 'acquisition_date', 'purchase_date', 'date_acquired'],
  parcel_tax_id: ['parcel_tax_id', 'parcel_id', 'tax_id', 'parcel id', 'parcel/tax id'],
  parking_spaces: ['parking_spaces', 'parking', 'parking_count'],
  amenities: ['amenities', 'features', 'amenity_list'],
  insurance_policy: ['insurance_policy', 'policy_number', 'insurance'],
  notes: ['notes', 'comments', 'description', 'remarks'],
};

const NUMERIC_FIELDS = new Set([
  'total_sf', 'leased_sf', 'total_buildings', 'total_units',
  'occupancy_pct', 'floors', 'year_built',
  'purchase_price', 'market_value', 'noi', 'cap_rate', 'parking_spaces',
]);

/**
 * Find the standardized (canonical) field name for a given CSV column header.
 * Tries both the raw lowercased header and a version with spaces→underscores.
 */
function findStandardFieldName(columnHeader: string): string | null {
  const rawNorm = columnHeader.toLowerCase().trim();
  const underNorm = rawNorm.replace(/\s+/g, '_');

  for (const [standardName, variations] of Object.entries(COLUMN_MAPPINGS)) {
    if (variations.includes(rawNorm) || variations.includes(underNorm)) {
      return standardName;
    }
  }
  return null;
}

/**
 * Convert a string (or number) value to a float. Strips commas, $ and %.
 */
export function normalizeNumber(numStr: string | number | null): number | null {
  if (numStr == null) return null;
  const cleaned = String(numStr).trim().replace(/,/g, '').replace(/[$%]/g, '');
  if (cleaned === '') return null;
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
    const rowNumber = i + 2; // row 1 = headers, rows are 0-indexed

    // Start with all canonical fields set to null
    const parsedRow: ParsedProperty = {
      property_id_code: null, name: null,
      address: null, city: null, state: null, zip: null,
      property_type: null, structure_type: null, status: null,
      total_sf: null, leased_sf: null, total_buildings: null, total_units: null,
      occupancy_pct: null, floors: null, year_built: null,
      purchase_price: null, market_value: null, noi: null, cap_rate: null,
      manager: null, owner: null, contact: null, phone: null, email: null,
      acquired_date: null, parcel_tax_id: null, parking_spaces: null,
      amenities: null, insurance_policy: null, notes: null,
      _row_number: rowNumber,
    };

    // Map each CSV column to the canonical field name
    for (const [columnName, value] of Object.entries(rawRow)) {
      if (columnName.startsWith('_')) continue; // skip internal metadata

      const standardField = findStandardFieldName(columnName);

      if (standardField) {
        if (NUMERIC_FIELDS.has(standardField)) {
          parsedRow[standardField] = normalizeNumber(value as string);
        } else {
          parsedRow[standardField] = (value === null || value === '') ? null : String(value).trim();
        }
      } else {
        // Preserve unmapped columns as-is (pass-through — alias map in BulkImportModal may handle them)
        parsedRow[columnName] = value;
      }
    }

    parsedRows.push(parsedRow);
  }

  return { rows: parsedRows, errors };
}

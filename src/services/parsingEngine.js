/**
 * Parsing Engine — Unified CSV/Text Data Parser
 *
 * Converts raw file content into structured, normalised JSON rows.
 * Each parser handles column name mapping and type conversion for
 * its specific module. No business logic or validation lives here.
 *
 * Flow: raw text → detect headers → normalise columns → convert types → output rows
 */

// ─── Shared Utilities ─────────────────────────────────────────────────

/**
 * Parse raw CSV text into an array of header-keyed objects.
 * Handles quoted fields, empty rows, and CRLF line endings.
 */
export function parseCSV(text) {
  if (!text || typeof text !== 'string') return { headers: [], rows: [] };

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { headers: [], rows: [] };

  const headers = splitCSVLine(lines[0]);
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.every(v => !v)) continue; // skip empty rows
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = vals[idx] || ''; });
    obj._row = i + 1; // 1-indexed source row for error reporting
    rows.push(obj);
  }

  return { headers, rows };
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

/**
 * Normalise a header string to snake_case.
 * "Tenant Name" → "tenant_name", "Base Rent ($)" → "base_rent"
 */
function normaliseHeader(h) {
  return h
    .toLowerCase()
    .replace(/[()$%#]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Try to parse a value as a number, stripping $ and commas. */
function toNumber(val) {
  if (val == null || val === '') return null;
  const cleaned = String(val).replace(/[$,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/** Try to parse a value as a date string (YYYY-MM-DD). */
function toDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // MM/DD/YYYY or M/D/YYYY
  const mdy = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  // Attempt native parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** Resolve a raw header to a canonical field name using a column map. */
function resolveColumn(rawHeader, columnMap) {
  const norm = normaliseHeader(rawHeader);
  // Exact match in map
  if (columnMap[norm]) return columnMap[norm];
  // Fuzzy match: check if any map key is a substring
  for (const [pattern, canonical] of Object.entries(columnMap)) {
    if (norm.includes(pattern) || pattern.includes(norm)) return canonical;
  }
  return norm; // pass through as-is
}

// ─── Module-Specific Parsers ──────────────────────────────────────────

// Column alias maps: raw header fragment → canonical field name
const LEASE_COLUMNS = {
  tenant: 'tenant_name', tenant_name: 'tenant_name', lessee: 'tenant_name',
  start: 'start_date', start_date: 'start_date', commencement: 'start_date', commence: 'start_date',
  end: 'end_date', end_date: 'end_date', expiration: 'end_date', expiry: 'end_date',
  monthly_rent: 'monthly_rent', base_rent: 'monthly_rent', rent: 'monthly_rent',
  annual_rent: 'annual_rent',
  sqft: 'square_footage', square_footage: 'square_footage', area: 'square_footage', sf: 'square_footage',
  lease_type: 'lease_type', type: 'lease_type',
  unit: 'unit_number', suite: 'unit_number', unit_number: 'unit_number',
  escalation: 'escalation_rate', escalation_rate: 'escalation_rate',
  property: 'property_name', property_name: 'property_name', building: 'property_name',
};

const EXPENSE_COLUMNS = {
  date: 'date', expense_date: 'date', invoice_date: 'date',
  category: 'category', type: 'category', expense_type: 'category',
  amount: 'amount', cost: 'amount', total: 'amount',
  vendor: 'vendor', supplier: 'vendor', vendor_name: 'vendor',
  description: 'description', note: 'description', notes: 'description', memo: 'description',
  classification: 'classification', recoverable: 'classification', class: 'classification',
  gl_code: 'gl_code', gl: 'gl_code', account: 'gl_code',
  property: 'property_name', property_name: 'property_name',
  month: 'month', period: 'month',
  fiscal_year: 'fiscal_year', year: 'fiscal_year',
};

const PROPERTY_COLUMNS = {
  name: 'name', property_name: 'name', property: 'name',
  address: 'address', street: 'address',
  city: 'city',
  state: 'state',
  zip: 'zip', postal: 'zip', zip_code: 'zip',
  property_type: 'property_type', type: 'property_type',
  total_sqft: 'total_sqft', sqft: 'total_sqft', square_footage: 'total_sqft', total_sf: 'total_sqft',
  year_built: 'year_built',
  status: 'status',
};

const REVENUE_COLUMNS = {
  property: 'property_name', property_name: 'property_name',
  tenant: 'tenant_name', tenant_name: 'tenant_name',
  type: 'type', revenue_type: 'type', category: 'type',
  amount: 'amount', total: 'amount',
  month: 'month', period: 'month',
  fiscal_year: 'fiscal_year', year: 'fiscal_year',
  date: 'date',
  notes: 'notes', description: 'notes',
};

/**
 * Parse lease data from CSV text.
 * @param {string} text - Raw CSV content
 * @returns {{ rows: object[], headers: string[], columnMap: object }}
 */
export function parseLeases(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, LEASE_COLUMNS);
      row[field] = raw[h];
    });
    // Type conversions
    row.monthly_rent = toNumber(row.monthly_rent);
    row.annual_rent = toNumber(row.annual_rent);
    row.square_footage = toNumber(row.square_footage);
    row.escalation_rate = toNumber(row.escalation_rate);
    row.start_date = toDate(row.start_date);
    row.end_date = toDate(row.end_date);
    // Derive monthly from annual if missing
    if (!row.monthly_rent && row.annual_rent) {
      row.monthly_rent = Math.round(row.annual_rent / 12);
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: LEASE_COLUMNS };
}

/**
 * Parse expense data from CSV text.
 * @param {string} text - Raw CSV content
 * @returns {{ rows: object[], headers: string[], columnMap: object }}
 */
export function parseExpenses(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, EXPENSE_COLUMNS);
      row[field] = raw[h];
    });
    // Type conversions
    row.amount = toNumber(row.amount);
    row.date = toDate(row.date);
    row.month = toNumber(row.month);
    row.fiscal_year = toNumber(row.fiscal_year);
    // Derive month/year from date if missing
    if (row.date && !row.month) {
      row.month = parseInt(row.date.slice(5, 7), 10);
    }
    if (row.date && !row.fiscal_year) {
      row.fiscal_year = parseInt(row.date.slice(0, 4), 10);
    }
    // Normalise classification
    if (row.classification) {
      const c = String(row.classification).toLowerCase();
      if (c.includes('recov') && !c.includes('non')) row.classification = 'recoverable';
      else if (c.includes('non') || c === 'no' || c === 'false') row.classification = 'non_recoverable';
      else if (c.includes('cond')) row.classification = 'conditional';
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: EXPENSE_COLUMNS };
}

/**
 * Parse property data from CSV text.
 * @param {string} text - Raw CSV content
 * @returns {{ rows: object[], headers: string[], columnMap: object }}
 */
export function parseProperties(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, PROPERTY_COLUMNS);
      row[field] = raw[h];
    });
    row.total_sqft = toNumber(row.total_sqft);
    row.year_built = toNumber(row.year_built);
    return row;
  });
  return { rows: mapped, headers, columnMap: PROPERTY_COLUMNS };
}

/**
 * Parse revenue data from CSV text.
 * @param {string} text - Raw CSV content
 * @returns {{ rows: object[], headers: string[], columnMap: object }}
 */
export function parseRevenue(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, REVENUE_COLUMNS);
      row[field] = raw[h];
    });
    row.amount = toNumber(row.amount);
    row.date = toDate(row.date);
    row.month = toNumber(row.month);
    row.fiscal_year = toNumber(row.fiscal_year);
    if (row.date && !row.month) {
      row.month = parseInt(row.date.slice(5, 7), 10);
    }
    if (row.date && !row.fiscal_year) {
      row.fiscal_year = parseInt(row.date.slice(0, 4), 10);
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: REVENUE_COLUMNS };
}

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
    .replace(/[()$%#*]/g, '')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

/** Try to parse a value as a number, stripping $, commas, spaces. */
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
  // MM/DD/YYYY or M/D/YYYY or MM-DD-YYYY
  const mdy = s.match(/^(\d{1,2})[/\-](\d{1,2})[/\-](\d{4})$/);
  if (mdy) return `${mdy[3]}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
  // DD-Mon-YYYY e.g. 01-Jan-2024
  const dMonY = s.match(/^(\d{1,2})[- ]([A-Za-z]{3})[- ](\d{4})$/);
  if (dMonY) {
    const months = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const m = months[dMonY[2].toLowerCase()];
    if (m) return `${dMonY[3]}-${String(m).padStart(2,'0')}-${dMonY[1].padStart(2,'0')}`;
  }
  // Attempt native parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

/** 
 * Resolve a raw header to a canonical field name using a column map.
 * Uses exact-match-first approach, then controlled prefix/suffix matching.
 * Avoids broad substring matches that cause incorrect field mapping.
 */
function resolveColumn(rawHeader, columnMap) {
  const norm = normaliseHeader(rawHeader);
  
  // 1. Exact match
  if (columnMap[norm]) return columnMap[norm];
  
  // 2. Match normalized header against each alias key where the key equals the full norm
  //    (catches minor punctuation/spacing differences already handled by normaliseHeader)
  for (const [key, canonical] of Object.entries(columnMap)) {
    if (norm === key) return canonical;
  }
  
  // 3. Controlled prefix/suffix: only match if the key starts or ends with the pattern
  //    AND the match is at a word boundary (separated by _).
  //    This prevents 'type' matching 'property_type' unintentionally.
  for (const [key, canonical] of Object.entries(columnMap)) {
    // Check if norm starts with key followed by _ (e.g. norm=start_date matches key=start_date)
    if (norm.startsWith(key + '_') || norm.endsWith('_' + key)) return canonical;
    // Check if key starts with norm followed by _ (e.g. norm=sqft matches key=sqft_available)
    if (key.startsWith(norm + '_') || key.endsWith('_' + norm)) return canonical;
  }
  
  return norm; // pass through normalised form as-is
}

// ─── Module-Specific Column Maps ──────────────────────────────────────
// Each key is an exact normalised alias, value is the canonical DB field name.
// IMPORTANT: Avoid overly short keys that cause cross-module collisions.

// ── PROPERTIES ────────────────────────────────────────────────────────
const PROPERTY_COLUMNS = {
  // Name
  name: 'name',
  property_name: 'name',
  property: 'name',
  building_name: 'name',
  asset_name: 'name',

  // Address
  address: 'address',
  street: 'address',
  street_address: 'address',
  location: 'address',
  full_address: 'address',

  // City / State / Zip
  city: 'city',
  state: 'state',
  province: 'state',
  region: 'state',
  zip: 'zip',
  zip_code: 'zip',
  postal_code: 'zip',
  postal: 'zip',

  // Property type
  property_type: 'property_type',
  asset_type: 'property_type',
  building_type: 'property_type',
  use_type: 'property_type',
  class: 'property_type',

  // Square footage
  total_sqft: 'total_sqft',
  total_sf: 'total_sqft',
  square_footage: 'total_sqft',
  square_feet: 'total_sqft',
  sqft: 'total_sqft',
  sf: 'total_sqft',
  rentable_sf: 'total_sqft',
  gla: 'total_sqft',
  gross_leasable_area: 'total_sqft',
  net_rentable_area: 'total_sqft',
  nra: 'total_sqft',

  // Year built
  year_built: 'year_built',
  built: 'year_built',
  construction_year: 'year_built',
  year_constructed: 'year_built',

  // Status
  status: 'status',
  asset_status: 'status',
  property_status: 'status',

  // Portfolio linkage
  portfolio_id: 'portfolio_id',
  portfolio: 'portfolio_id',
  portfolio_name: 'portfolio_id',
  fund: 'portfolio_id',

  // Financial metrics (optional enrichment columns)
  purchase_price: 'purchase_price',
  acquisition_price: 'purchase_price',
  cost_basis: 'purchase_price',
  market_value: 'market_value',
  appraised_value: 'market_value',
  current_value: 'market_value',
  noi: 'noi',
  net_operating_income: 'noi',
  cap_rate: 'cap_rate',
  capitalization_rate: 'cap_rate',

  // Units / floors
  total_units: 'total_units',
  units: 'total_units',
  unit_count: 'total_units',
  number_of_units: 'total_units',
  floors: 'floors',
  number_of_floors: 'floors',
  stories: 'floors',

  // Contact / manager
  manager: 'manager',
  property_manager: 'manager',
  contact: 'contact',
  contact_name: 'contact',
  owner: 'owner',
  ownership: 'owner',

  // Notes / description
  notes: 'notes',
  description: 'notes',
  comments: 'notes',
  remarks: 'notes',
};

// ── LEASES ────────────────────────────────────────────────────────────
const LEASE_COLUMNS = {
  // Tenant
  tenant_name: 'tenant_name',
  tenant: 'tenant_name',
  lessee: 'tenant_name',
  occupant: 'tenant_name',
  company_name: 'tenant_name',
  business_name: 'tenant_name',
  tenant_id: 'tenant_id',

  // Dates
  start_date: 'start_date',
  commencement_date: 'start_date',
  lease_start: 'start_date',
  lease_commencement: 'start_date',
  move_in_date: 'start_date',
  end_date: 'end_date',
  expiration_date: 'end_date',
  lease_end: 'end_date',
  lease_expiration: 'end_date',
  termination_date: 'end_date',
  maturity_date: 'end_date',

  // Lease term
  lease_term: 'lease_term_months',
  term: 'lease_term_months',
  term_months: 'lease_term_months',
  duration: 'lease_term_months',
  duration_months: 'lease_term_months',

  // Rent
  monthly_rent: 'monthly_rent',
  base_rent: 'monthly_rent',
  monthly_base_rent: 'monthly_rent',
  rent_per_month: 'monthly_rent',
  rent_amount: 'monthly_rent',
  current_rent: 'monthly_rent',
  annual_rent: 'annual_rent',
  annual_base_rent: 'annual_rent',
  yearly_rent: 'annual_rent',
  rent_per_year: 'annual_rent',

  // Per-SF rent
  rent_per_sf: 'rent_per_sf',
  rent_psf: 'rent_per_sf',
  base_rent_psf: 'rent_per_sf',
  annual_rent_psf: 'rent_per_sf',

  // Square footage
  square_footage: 'square_footage',
  square_feet: 'square_footage',
  leased_sf: 'square_footage',
  leased_sqft: 'square_footage',
  rentable_sf: 'square_footage',
  sqft: 'square_footage',
  sf: 'square_footage',
  area: 'square_footage',
  leased_area: 'square_footage',

  // Unit / Suite
  unit_number: 'unit_number',
  unit_id: 'unit_id',
  suite: 'unit_number',
  suite_number: 'unit_number',
  space: 'unit_number',
  space_id: 'unit_number',

  // Property
  property_name: 'property_name',
  property_id: 'property_id',
  building: 'property_name',
  building_name: 'property_name',

  // Lease type
  lease_type: 'lease_type',
  lease_structure: 'lease_type',
  structure: 'lease_type',

  // Escalation / bumps
  escalation_rate: 'escalation_rate',
  annual_escalation: 'escalation_rate',
  rent_escalation: 'escalation_rate',
  annual_bump: 'escalation_rate',
  cpi_adjustment: 'escalation_rate',

  // Financial details
  security_deposit: 'security_deposit',
  deposit: 'security_deposit',
  security: 'security_deposit',
  cam_charges: 'cam_amount',
  cam_amount: 'cam_amount',
  cam: 'cam_amount',
  nnn_charges: 'nnn_amount',
  nnn: 'nnn_amount',
  operating_expenses: 'nnn_amount',

  // Options
  renewal_options: 'renewal_options',
  renewal_option: 'renewal_options',
  option_to_renew: 'renewal_options',
  expansion_option: 'expansion_option',
  termination_option: 'termination_option',

  // Status
  status: 'status',
  lease_status: 'status',
  occupancy_status: 'status',

  // Notes
  notes: 'notes',
  comments: 'notes',
  remarks: 'notes',
  description: 'notes',
};

// ── TENANTS ───────────────────────────────────────────────────────────
const TENANT_COLUMNS = {
  name: 'name',
  tenant_name: 'name',
  company: 'company',
  company_name: 'company',
  business_name: 'company',
  dba: 'company',
  contact_name: 'contact_name',
  contact: 'contact_name',
  point_of_contact: 'contact_name',
  email: 'email',
  contact_email: 'email',
  email_address: 'email',
  phone: 'phone',
  contact_phone: 'phone',
  phone_number: 'phone',
  mobile: 'phone',
  industry: 'industry',
  business_type: 'industry',
  sector: 'industry',
  credit_rating: 'credit_rating',
  credit_score: 'credit_rating',
  status: 'status',
  tenant_status: 'status',
  notes: 'notes',
  comments: 'notes',
};

// ── BUILDINGS ─────────────────────────────────────────────────────────
const BUILDING_COLUMNS = {
  name: 'name',
  building_name: 'name',
  building: 'name',
  property_id: 'property_id',
  property: 'property_id',
  property_name: 'property_id',
  address: 'address',
  street: 'address',
  total_sqft: 'total_sqft',
  total_sf: 'total_sqft',
  square_footage: 'total_sqft',
  sqft: 'total_sqft',
  sf: 'total_sqft',
  floors: 'floors',
  total_floors: 'floors',
  stories: 'floors',
  year_built: 'year_built',
  built: 'year_built',
  year_constructed: 'year_built',
  status: 'status',
};

// ── UNITS ─────────────────────────────────────────────────────────────
const UNIT_COLUMNS = {
  unit_number: 'unit_number',
  unit_id: 'unit_number',
  unit: 'unit_number',
  suite: 'unit_number',
  suite_number: 'unit_number',
  space: 'unit_number',
  building_id: 'building_id',
  building: 'building_id',
  building_name: 'building_id',
  property_id: 'property_id',
  property: 'property_id',
  property_name: 'property_id',
  floor: 'floor',
  floor_number: 'floor',
  level: 'floor',
  square_footage: 'square_footage',
  square_feet: 'square_footage',
  sqft: 'square_footage',
  sf: 'square_footage',
  rentable_sf: 'square_footage',
  unit_type: 'unit_type',
  use_type: 'unit_type',
  space_type: 'unit_type',
  status: 'status',
  occupancy_status: 'status',
  tenant_name: 'tenant_name',
  tenant: 'tenant_name',
  occupant: 'tenant_name',
  monthly_rent: 'monthly_rent',
  asking_rent: 'monthly_rent',
};

// ── REVENUE ───────────────────────────────────────────────────────────
const REVENUE_COLUMNS = {
  property_name: 'property_name',
  property: 'property_name',
  property_id: 'property_id',
  tenant_name: 'tenant_name',
  tenant: 'tenant_name',
  revenue_type: 'type',
  income_type: 'type',
  type: 'type',
  category: 'type',
  amount: 'amount',
  total: 'amount',
  revenue: 'amount',
  income: 'amount',
  month: 'month',
  month_number: 'month',
  period: 'month',
  fiscal_year: 'fiscal_year',
  year: 'fiscal_year',
  fy: 'fiscal_year',
  date: 'date',
  revenue_date: 'date',
  transaction_date: 'date',
  notes: 'notes',
  description: 'notes',
  comments: 'notes',
};

// ── EXPENSES ──────────────────────────────────────────────────────────
const EXPENSE_COLUMNS = {
  date: 'date',
  expense_date: 'date',
  invoice_date: 'date',
  transaction_date: 'date',
  period_date: 'date',
  category: 'category',
  expense_category: 'category',
  expense_type: 'category',
  account_type: 'category',
  gl_category: 'category',
  amount: 'amount',
  expense_amount: 'amount',
  cost: 'amount',
  total_cost: 'amount',
  total_amount: 'amount',
  invoice_amount: 'amount',
  vendor: 'vendor',
  vendor_name: 'vendor',
  supplier: 'vendor',
  payee: 'vendor',
  contractor: 'vendor',
  description: 'description',
  note: 'description',
  notes: 'description',
  memo: 'description',
  details: 'description',
  classification: 'classification',
  recoverable: 'classification',
  recoverability: 'classification',
  cam_eligible: 'classification',
  gl_code: 'gl_code',
  gl_account: 'gl_code',
  account_code: 'gl_code',
  account_number: 'gl_code',
  cost_center: 'gl_code',
  property_name: 'property_name',
  property: 'property_name',
  property_id: 'property_id',
  month: 'month',
  month_number: 'month',
  fiscal_month: 'month',
  fiscal_year: 'fiscal_year',
  year: 'fiscal_year',
  fy: 'fiscal_year',
  invoice_number: 'invoice_number',
  invoice_no: 'invoice_number',
  reference: 'invoice_number',
};

// ── GL ACCOUNTS ───────────────────────────────────────────────────────
const GL_ACCOUNT_COLUMNS = {
  account_code: 'code',
  account_number: 'code',
  gl_code: 'code',
  gl_number: 'code',
  code: 'code',
  account_name: 'name',
  name: 'name',
  description: 'name',
  account_type: 'type',
  type: 'type',
  category: 'category',
  group: 'category',
  subtype: 'subtype',
  sub_type: 'subtype',
  parent_account: 'parent_code',
  parent_code: 'parent_code',
  parent: 'parent_code',
  normal_balance: 'normal_balance',
  balance_type: 'normal_balance',
  active: 'is_active',
  is_active: 'is_active',
  status: 'is_active',
  recoverable: 'is_recoverable',
  is_recoverable: 'is_recoverable',
  cam_eligible: 'is_recoverable',
  notes: 'notes',
  comments: 'notes',
};

// ─── Module-Specific Parsers ──────────────────────────────────────────

/**
 * Parse property data from CSV text.
 */
export function parseProperties(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, PROPERTY_COLUMNS);
      // Don't overwrite already-set fields with empty strings
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    row.total_sqft    = toNumber(row.total_sqft);
    row.year_built    = toNumber(row.year_built);
    row.total_units   = toNumber(row.total_units);
    row.floors        = toNumber(row.floors);
    row.purchase_price = toNumber(row.purchase_price) ?? undefined;
    row.market_value  = toNumber(row.market_value) ?? undefined;
    row.noi           = toNumber(row.noi) ?? undefined;
    row.cap_rate      = toNumber(row.cap_rate) ?? undefined;
    // Normalise property_type to lowercase
    if (row.property_type) {
      row.property_type = String(row.property_type).toLowerCase().trim();
    }
    // Normalise status
    if (row.status) {
      row.status = String(row.status).toLowerCase().trim();
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: PROPERTY_COLUMNS };
}

/**
 * Parse lease data from CSV text.
 */
export function parseLeases(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, LEASE_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });

    // Type conversions
    row.monthly_rent      = toNumber(row.monthly_rent);
    row.annual_rent       = toNumber(row.annual_rent);
    row.square_footage    = toNumber(row.square_footage);
    row.escalation_rate   = toNumber(row.escalation_rate);
    row.rent_per_sf       = toNumber(row.rent_per_sf);
    row.security_deposit  = toNumber(row.security_deposit);
    row.cam_amount        = toNumber(row.cam_amount);
    row.nnn_amount        = toNumber(row.nnn_amount);
    row.lease_term_months = toNumber(row.lease_term_months);

    row.start_date = toDate(row.start_date);
    row.end_date   = toDate(row.end_date);

    // Derive monthly_rent from annual if missing
    if (!row.monthly_rent && row.annual_rent) {
      row.monthly_rent = Math.round(row.annual_rent / 12);
    }
    // Derive annual_rent from monthly if missing
    if (!row.annual_rent && row.monthly_rent) {
      row.annual_rent = row.monthly_rent * 12;
    }
    // Derive rent_per_sf if missing but we have monthly_rent and square_footage
    if (!row.rent_per_sf && row.annual_rent && row.square_footage) {
      row.rent_per_sf = parseFloat((row.annual_rent / row.square_footage).toFixed(2));
    }
    // Derive lease_term_months from start/end dates if missing
    if (!row.lease_term_months && row.start_date && row.end_date) {
      const start = new Date(row.start_date);
      const end   = new Date(row.end_date);
      if (!isNaN(start) && !isNaN(end)) {
        const months = (end.getFullYear() - start.getFullYear()) * 12
          + (end.getMonth() - start.getMonth());
        if (months > 0) row.lease_term_months = months;
      }
    }

    // Normalise lease_type
    if (row.lease_type) {
      const lt = String(row.lease_type).toLowerCase().trim();
      if (lt.includes('nnn') || lt.includes('triple')) row.lease_type = 'nnn';
      else if (lt.includes('gross') || lt.includes('full service')) row.lease_type = 'gross';
      else if (lt.includes('modified')) row.lease_type = 'modified_gross';
      else if (lt.includes('nn') || lt.includes('double')) row.lease_type = 'nn';
      else if (lt.includes('net')) row.lease_type = 'net';
      else row.lease_type = lt;
    }

    // Normalise status
    if (row.status) {
      const s = String(row.status).toLowerCase().trim();
      if (s.includes('active') || s === 'current') row.status = 'active';
      else if (s.includes('expir') || s.includes('matured')) row.status = 'expired';
      else if (s.includes('vacant') || s.includes('empty') || s === 'available') row.status = 'vacant';
      else if (s.includes('pending') || s.includes('draft')) row.status = 'pending';
      else row.status = s;
    }

    return row;
  });
  return { rows: mapped, headers, columnMap: LEASE_COLUMNS };
}

/**
 * Parse tenant data from CSV text.
 */
export function parseTenants(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, TENANT_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    if (row.status) row.status = String(row.status).toLowerCase().trim();
    return row;
  });
  return { rows: mapped, headers, columnMap: TENANT_COLUMNS };
}

/**
 * Parse expense data from CSV text.
 */
export function parseExpenses(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, EXPENSE_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    row.amount      = toNumber(row.amount);
    row.date        = toDate(row.date);
    row.month       = toNumber(row.month);
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
      else if (c.includes('non') || c === 'no' || c === 'false' || c === '0') row.classification = 'non_recoverable';
      else if (c.includes('cond')) row.classification = 'conditional';
      else if (c === 'yes' || c === 'true' || c === '1') row.classification = 'recoverable';
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: EXPENSE_COLUMNS };
}

/**
 * Parse revenue data from CSV text.
 */
export function parseRevenue(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, REVENUE_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    row.amount      = toNumber(row.amount);
    row.date        = toDate(row.date);
    row.month       = toNumber(row.month);
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

/**
 * Parse building data from CSV text.
 */
export function parseBuildings(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, BUILDING_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    row.total_sqft  = toNumber(row.total_sqft);
    row.floors      = toNumber(row.floors);
    row.year_built  = toNumber(row.year_built);
    return row;
  });
  return { rows: mapped, headers, columnMap: BUILDING_COLUMNS };
}

/**
 * Parse unit data from CSV text.
 */
export function parseUnits(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, UNIT_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    row.square_footage = toNumber(row.square_footage);
    row.floor          = toNumber(row.floor);
    row.monthly_rent   = toNumber(row.monthly_rent);
    // Normalise status
    if (row.status) {
      const s = String(row.status).toLowerCase().trim();
      if (s.includes('vacant') || s === 'available' || s === 'empty') row.status = 'vacant';
      else if (s.includes('occup') || s === 'leased' || s === 'rented') row.status = 'occupied';
      else row.status = s;
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: UNIT_COLUMNS };
}

/**
 * Parse GL Account data from CSV text.
 */
export function parseGLAccounts(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      const field = resolveColumn(h, GL_ACCOUNT_COLUMNS);
      if (row[field] === undefined || (raw[h] && raw[h] !== '')) {
        row[field] = raw[h];
      }
    });
    // Normalise is_active
    if (row.is_active !== undefined) {
      const v = String(row.is_active).toLowerCase().trim();
      row.is_active = v === 'true' || v === 'yes' || v === '1' || v === 'active';
    }
    if (row.is_recoverable !== undefined) {
      const v = String(row.is_recoverable).toLowerCase().trim();
      row.is_recoverable = v === 'true' || v === 'yes' || v === '1';
    }
    return row;
  });
  return { rows: mapped, headers, columnMap: GL_ACCOUNT_COLUMNS };
}

/**
 * Generic fallback parser — normalises headers, passes values through.
 */
export function parseGeneric(text) {
  const { headers, rows } = parseCSV(text);
  const mapped = rows.map(raw => {
    const row = { _row: raw._row };
    headers.forEach(h => {
      row[normaliseHeader(h)] = raw[h];
    });
    return row;
  });
  return { rows: mapped, headers };
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL NORMALIZATION & CALCULATION ENGINE
// Applied to ALL rows regardless of source (CSV parser OR AI extraction).
// This is the single source of truth for all field calculations in the app.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run all type coercions, derivations, and business logic calculations
 * for a given moduleType on an array of raw rows.
 *
 * @param {string}   moduleType  — 'property' | 'lease' | 'tenant' | 'unit' | ...
 * @param {object[]} rows        — raw rows from any source (AI, CSV, Excel)
 * @returns {object[]}           — fully normalized rows with all derived fields
 */
export function normalizeAndCalculate(moduleType, rows) {
  return rows.map((rawRow, idx) => {
    const row = { ...rawRow };
    if (!row._row) row._row = idx + 1;

    switch (moduleType) {
      case 'lease':       return normalizeLease(row);
      case 'property':    return normalizeProperty(row);
      case 'expense':     return normalizeExpense(row);
      case 'revenue':     return normalizeRevenue(row);
      case 'unit':        return normalizeUnit(row);
      case 'building':    return normalizeBuilding(row);
      case 'tenant':      return normalizeTenant(row);
      case 'gl_account':
      case 'gl':          return normalizeGLAccount(row);
      default:            return row;
    }
  });
}

// ── Per-module normalizer functions ───────────────────────────────────────────

function normalizeLease(row) {
  // ── Type coerce all numeric fields ────────────────────────────────────────
  row.monthly_rent      = toNumber(row.monthly_rent ?? row.base_rent ?? row.monthly_base_rent);
  row.annual_rent       = toNumber(row.annual_rent  ?? row.annual_base_rent ?? row.yearly_rent);
  row.square_footage    = toNumber(row.square_footage ?? row.total_sf ?? row.leased_sf ?? row.sqft ?? row.sf ?? row.area);
  row.rent_per_sf       = toNumber(row.rent_per_sf  ?? row.rent_psf ?? row.annual_rent_psf);
  row.lease_term_months = toNumber(row.lease_term_months ?? row.term_months ?? row.lease_term ?? row.term);
  row.security_deposit  = toNumber(row.security_deposit ?? row.deposit);
  row.cam_amount        = toNumber(row.cam_amount   ?? row.cam_charges ?? row.cam);
  row.nnn_amount        = toNumber(row.nnn_amount   ?? row.nnn_charges ?? row.nnn ?? row.operating_expenses);
  row.escalation_rate   = toNumber(row.escalation_rate ?? row.annual_escalation ?? row.rent_escalation ?? row.escalation_value ?? row.escalation);
  row.ti_allowance      = toNumber(row.ti_allowance ?? row.tenant_improvement ?? row.ti);
  row.free_rent_months  = toNumber(row.free_rent_months ?? row.free_rent);

  // ── Date coerce ────────────────────────────────────────────────────────────
  row.start_date = toDate(row.start_date ?? row.commencement_date ?? row.lease_start ?? row.lease_commencement);
  row.end_date   = toDate(row.end_date   ?? row.expiration_date   ?? row.lease_end   ?? row.lease_expiration ?? row.termination_date);

  // ── DERIVED: monthly ↔ annual rent ────────────────────────────────────────
  if (!row.monthly_rent && row.annual_rent) {
    row.monthly_rent = Math.round((row.annual_rent / 12) * 100) / 100;
  }
  if (!row.annual_rent && row.monthly_rent) {
    row.annual_rent = Math.round(row.monthly_rent * 12 * 100) / 100;
  }

  // ── DERIVED: rent_per_sf (annual $/SF) ────────────────────────────────────
  if (!row.rent_per_sf && row.annual_rent && row.square_footage && row.square_footage > 0) {
    row.rent_per_sf = Math.round((row.annual_rent / row.square_footage) * 100) / 100;
  }
  // Back-derive annual_rent from rent_per_sf × SF if we still don't have it
  if (!row.annual_rent && row.rent_per_sf && row.square_footage) {
    row.annual_rent  = Math.round(row.rent_per_sf * row.square_footage * 100) / 100;
    row.monthly_rent = Math.round((row.annual_rent / 12) * 100) / 100;
  }

  // ── DERIVED: lease_term_months from start/end dates ───────────────────────
  if (!row.lease_term_months && row.start_date && row.end_date) {
    const s = new Date(row.start_date);
    const e = new Date(row.end_date);
    if (!isNaN(s) && !isNaN(e)) {
      const months = (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth());
      if (months > 0) row.lease_term_months = months;
    }
  }
  // Back-derive end_date from start + term if end_date missing
  if (!row.end_date && row.start_date && row.lease_term_months) {
    const s = new Date(row.start_date);
    if (!isNaN(s)) {
      s.setMonth(s.getMonth() + Math.round(row.lease_term_months));
      row.end_date = s.toISOString().slice(0, 10);
    }
  }

  // ── DERIVED: total_cam = cam_amount + nnn_amount (if applicable) ──────────
  if (row.cam_amount || row.nnn_amount) {
    row.total_cam = Math.round(((row.cam_amount ?? 0) + (row.nnn_amount ?? 0)) * 100) / 100;
  }

  // ── DERIVED: effective_gross_rent = monthly_rent + cam + nnn ─────────────
  if (row.monthly_rent) {
    const camMonthly = (row.cam_amount ?? 0) / 12;
    const nnnMonthly = (row.nnn_amount ?? 0) / 12;
    row.effective_rent = Math.round((row.monthly_rent + camMonthly + nnnMonthly) * 100) / 100;
  }

  // ── DERIVED: UI compatibility ─────────────────────────────────────────────
  if (row.cam_amount && !row.cam_per_month) {
    row.cam_per_month = Math.round((row.cam_amount / 12) * 100) / 100;
  }

  // ── Normalize lease_type ──────────────────────────────────────────────────
  if (row.lease_type) {
    const lt = String(row.lease_type).toLowerCase().trim();
    if (lt.includes('nnn') || lt.includes('triple'))       row.lease_type = 'nnn';
    else if (lt.includes('gross') || lt.includes('full'))  row.lease_type = 'gross';
    else if (lt.includes('modified'))                      row.lease_type = 'modified_gross';
    else if (lt === 'nn' || lt.includes('double'))         row.lease_type = 'nn';
    else if (lt.includes('net'))                           row.lease_type = 'net';
    else row.lease_type = lt;
  }

  // ── Normalize status ──────────────────────────────────────────────────────
  if (row.status) {
    const s = String(row.status).toLowerCase().trim();
    if (s.includes('active') || s === 'current')                      row.status = 'active';
    else if (s.includes('expir') || s.includes('mature'))             row.status = 'expired';
    else if (s.includes('vacant') || s === 'available')               row.status = 'vacant';
    else if (s.includes('pending') || s.includes('draft'))            row.status = 'pending';
    else row.status = s;
  }

  return row;
}

function normalizeProperty(row) {
  row.total_sqft     = toNumber(row.total_sqft  ?? row.total_sf ?? row.square_footage ?? row.sqft ?? row.sf ?? row.gla ?? row.nra);
  row.year_built     = toNumber(row.year_built  ?? row.built ?? row.construction_year);
  row.total_units    = toNumber(row.total_units ?? row.units ?? row.unit_count);
  row.floors         = toNumber(row.floors      ?? row.stories ?? row.number_of_floors);
  row.purchase_price = toNumber(row.purchase_price ?? row.acquisition_price ?? row.cost_basis) ?? undefined;
  row.market_value   = toNumber(row.market_value   ?? row.appraised_value   ?? row.current_value) ?? undefined;
  row.noi            = toNumber(row.noi            ?? row.net_operating_income) ?? undefined;
  row.cap_rate       = toNumber(row.cap_rate       ?? row.capitalization_rate) ?? undefined;

  // ── DERIVED: cap_rate = NOI / market_value × 100 ─────────────────────────
  if (!row.cap_rate && row.noi && row.market_value && row.market_value > 0) {
    row.cap_rate = Math.round((row.noi / row.market_value) * 10000) / 100; // 2 decimals
  }

  // ── DERIVED: noi from cap_rate and market_value ───────────────────────────
  if (!row.noi && row.cap_rate && row.market_value) {
    row.noi = Math.round((row.cap_rate / 100) * row.market_value);
  }

  // Normalize property_type
  if (row.property_type) {
    const pt = String(row.property_type).toLowerCase().trim();
    if (pt.includes('office'))     row.property_type = 'office';
    else if (pt.includes('retail') || pt.includes('shopping')) row.property_type = 'retail';
    else if (pt.includes('indus') || pt.includes('warehouse') || pt.includes('flex')) row.property_type = 'industrial';
    else if (pt.includes('mixed')) row.property_type = 'mixed_use';
    else if (pt.includes('multi') || pt.includes('apart') || pt.includes('resid')) row.property_type = 'multifamily';
    else if (pt.includes('hotel') || pt.includes('hospit')) row.property_type = 'hotel';
    else if (pt.includes('land')  || pt.includes('parcel')) row.property_type = 'land';
    else row.property_type = pt;
  }

  if (row.status) row.status = String(row.status).toLowerCase().trim();
  return row;
}

function normalizeExpense(row) {
  row.amount      = toNumber(row.amount ?? row.cost ?? row.total_cost ?? row.expense_amount ?? row.invoice_amount);
  row.date        = toDate(row.date  ?? row.expense_date ?? row.invoice_date ?? row.transaction_date);
  row.month       = toNumber(row.month ?? row.month_number);
  row.fiscal_year = toNumber(row.fiscal_year ?? row.year);

  // Derive month/year from date
  if (row.date && !row.month) row.month = parseInt(row.date.slice(5, 7), 10);
  if (row.date && !row.fiscal_year) row.fiscal_year = parseInt(row.date.slice(0, 4), 10);

  // Normalize classification
  if (row.classification) {
    const c = String(row.classification).toLowerCase();
    if (c === 'yes' || c === 'true' || c === '1' || (c.includes('recov') && !c.includes('non'))) {
      row.classification = 'recoverable';
    } else if (c === 'no' || c === 'false' || c === '0' || c.includes('non')) {
      row.classification = 'non_recoverable';
    } else if (c.includes('cond')) {
      row.classification = 'conditional';
    }
  }
  return row;
}

function normalizeRevenue(row) {
  row.amount      = toNumber(row.amount ?? row.revenue ?? row.income ?? row.total);
  row.date        = toDate(row.date ?? row.revenue_date ?? row.transaction_date);
  row.month       = toNumber(row.month ?? row.month_number);
  row.fiscal_year = toNumber(row.fiscal_year ?? row.year);

  if (row.date && !row.month) row.month = parseInt(row.date.slice(5, 7), 10);
  if (row.date && !row.fiscal_year) row.fiscal_year = parseInt(row.date.slice(0, 4), 10);

  // Normalize revenue type
  if (row.type) {
    const t = String(row.type).toLowerCase().trim();
    if (t.includes('base') || t.includes('rent'))          row.type = 'base_rent';
    else if (t.includes('cam') || t.includes('recov'))     row.type = 'cam_recovery';
    else if (t.includes('park'))                           row.type = 'parking';
    else if (t.includes('percent') || t.includes('overage')) row.type = 'percentage_rent';
    else row.type = t;
  }
  return row;
}

function normalizeUnit(row) {
  row.square_footage = toNumber(row.square_footage ?? row.sqft ?? row.sf ?? row.area ?? row.total_sqft);
  row.floor          = toNumber(row.floor ?? row.floor_number ?? row.level);
  row.monthly_rent   = toNumber(row.monthly_rent ?? row.asking_rent ?? row.rent);
  
  // UI Compatibility
  row.square_feet = row.square_footage;

  if (row.status) {
    const s = String(row.status).toLowerCase().trim();
    if (s.includes('vacant') || s === 'available' || s === 'empty') row.status = 'vacant';
    else if (s.includes('occup') || s === 'leased' || s === 'rented') row.status = 'occupied';
    else if (s.includes('renov') || s.includes('construction')) row.status = 'under_renovation';
    else row.status = s;
  }
  return row;
}

function normalizeBuilding(row) {
  row.total_sqft = toNumber(row.total_sqft ?? row.sqft ?? row.sf ?? row.square_footage);
  row.floors     = toNumber(row.floors     ?? row.stories ?? row.total_floors);
  row.year_built = toNumber(row.year_built ?? row.built   ?? row.construction_year);
  return row;
}

function normalizeTenant(row) {
  if (row.status) row.status = String(row.status).toLowerCase().trim();
  // Ensure name field is mapped correctly even if AI returns tenant_name
  if (!row.name && row.tenant_name) row.name = row.tenant_name;
  return row;
}

function normalizeGLAccount(row) {
  if (row.is_active !== undefined) {
    const v = String(row.is_active).toLowerCase().trim();
    row.is_active = v === 'true' || v === 'yes' || v === '1' || v === 'active';
  }
  if (row.is_recoverable !== undefined) {
    const v = String(row.is_recoverable).toLowerCase().trim();
    row.is_recoverable = v === 'true' || v === 'yes' || v === '1';
  }
  return row;
}


/**
 * Map of moduleType → parser function.
 * Used by documentExtractor.js to route CSV/Excel files to the right parser.
 */

export const PARSER_MAP = {
  property:   parseProperties,
  building:   parseBuildings,
  unit:       parseUnits,
  lease:      parseLeases,
  tenant:     parseTenants,
  revenue:    parseRevenue,
  expense:    parseExpenses,
  gl_account: parseGLAccounts,
  gl:         parseGLAccounts,
  invoice:    parseGeneric,
  vendor:     parseGeneric,
};

/**
 * Export template CSV strings for each module, so users know what headers to use.
 */
export const CSV_TEMPLATES = {
  property: 'Property Name,Address,City,State,Zip,Property Type,Total SQFT,Year Built,Status,Portfolio\n',
  lease: 'Tenant Name,Unit Number,Property Name,Start Date,End Date,Monthly Rent,Annual Rent,Square Footage,Lease Type,Security Deposit,CAM Amount,Escalation Rate,Status,Notes\n',
  tenant: 'Tenant Name,Company,Email,Phone,Industry,Status\n',
  building: 'Building Name,Property Name,Address,Total SQFT,Floors,Year Built,Status\n',
  unit: 'Unit Number,Building Name,Property Name,Floor,Square Footage,Unit Type,Status,Monthly Rent\n',
  expense: 'Date,Category,Amount,Vendor,Description,Classification,GL Code,Property Name,Fiscal Year,Month\n',
  revenue: 'Property Name,Tenant Name,Revenue Type,Amount,Date,Month,Fiscal Year,Notes\n',
  gl_account: 'Account Code,Account Name,Account Type,Category,Normal Balance,Is Active,Is Recoverable\n',
};

// @ts-nocheck
/**
 * Extraction Pipeline — Module Schemas
 *
 * Defines the expected fields for each CRE module type, including:
 * - Field type and validation constraints
 * - Document labels (what text to look for in rule-based extraction)
 * - Regex patterns for pattern matching
 * - Field groups for LLM extraction (small batches)
 * - Which fields are derived (computed, never extracted)
 */

import type { ModuleType } from "./types.ts";

// ── Field definition ─────────────────────────────────────────────────────────

export type FieldType = "string" | "number" | "date" | "boolean" | "enum";

export interface FieldDef {
  type: FieldType;
  required?: boolean;
  enumValues?: string[];
  /** Min/max for numbers */
  min?: number;
  max?: number;
  /** Document labels that precede this field's value */
  labels: string[];
  /** Regex patterns for direct extraction from text */
  patterns?: RegExp[];
  /** Table header aliases (lowercase) that map to this field */
  tableHeaders?: string[];
  /** This field is computed from others — never extract or send to LLM */
  derived?: boolean;
  /** Human-readable description for LLM prompt */
  description: string;
}

export type ModuleSchema = Record<string, FieldDef>;

/** Fields grouped for LLM extraction — each group is one LLM call */
export interface FieldGroup {
  name: string;
  fields: string[];
  hint: string; // contextual hint for the LLM
}

// ── Lease schema ─────────────────────────────────────────────────────────────

export const LEASE_SCHEMA: ModuleSchema = {
  tenant_name: {
    type: "string",
    required: true,
    labels: ["tenant", "lessee", "occupant", "tenant name", "lessee name"],
    tableHeaders: ["tenant", "tenant_name", "tenant name", "lessee", "company"],
    description: "Name of the tenant or company",
  },
  property_name: {
    type: "string",
    labels: ["property", "property name", "building", "building name", "premises"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    description: "Name of the property or building",
  },
  unit_number: {
    type: "string",
    labels: ["unit", "suite", "space", "unit number", "suite number", "space number"],
    tableHeaders: ["unit", "suite", "unit_number", "unit number", "space", "suite #"],
    patterns: [/(?:Suite|Unit|Space)\s+([\w\-]+)/i],
    description: "Unit, suite, or space identifier",
  },
  start_date: {
    type: "date",
    required: true,
    labels: ["start date", "commencement date", "lease start", "commence", "effective date", "begin date"],
    tableHeaders: ["start_date", "start date", "commencement", "commence", "start", "effective"],
    description: "Lease start date in YYYY-MM-DD",
  },
  end_date: {
    type: "date",
    required: true,
    labels: ["end date", "expiration date", "lease end", "termination date", "expiry", "expire date"],
    tableHeaders: ["end_date", "end date", "expiration", "expire", "end", "termination"],
    description: "Lease expiration date in YYYY-MM-DD",
  },
  monthly_rent: {
    type: "number",
    min: 0,
    labels: ["monthly rent", "base rent", "rent", "rent per month", "monthly base rent"],
    tableHeaders: ["monthly_rent", "monthly rent", "base rent", "rent", "monthly", "base_rent"],
    patterns: [
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*month|\/month|\/mo|monthly)/i,
      /(?:monthly|base)\s*rent[:\s]+\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    description: "Base rent per month in USD (plain number, no $ or commas)",
  },
  annual_rent: {
    type: "number",
    min: 0,
    derived: true,
    labels: [],
    description: "Annual rent (computed: monthly_rent × 12)",
  },
  rent_per_sf: {
    type: "number",
    min: 0,
    labels: ["rent per sf", "rent per square foot", "psf", "$/sf", "rent/sf"],
    tableHeaders: ["rent_per_sf", "rent/sf", "$/sf", "psf", "rent per sf", "annual psf"],
    description: "Annual rent per square foot",
  },
  square_footage: {
    type: "number",
    min: 0,
    labels: ["square footage", "rentable area", "leased area", "sq ft", "rsf", "usable area", "area"],
    tableHeaders: ["square_footage", "sqft", "sq ft", "sf", "rsf", "area", "square footage", "rentable sf"],
    patterns: [/([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bRSF\b)/i],
    description: "Leased area in square feet (plain number)",
  },
  lease_type: {
    type: "enum",
    enumValues: ["nnn", "gross", "modified_gross", "nn", "net"],
    labels: ["lease type", "type of lease"],
    tableHeaders: ["lease_type", "type", "lease type"],
    patterns: [
      /(?:triple[\s-]net|nnn\s+lease)/i,
      /(?:gross\s+lease|full[\s-]service)/i,
      /(?:modified[\s-]gross)/i,
    ],
    description: "One of: nnn, gross, modified_gross, nn, net",
  },
  security_deposit: {
    type: "number",
    min: 0,
    labels: ["security deposit", "deposit"],
    tableHeaders: ["security_deposit", "deposit", "security deposit"],
    description: "Security deposit in USD",
  },
  cam_amount: {
    type: "number",
    min: 0,
    labels: ["cam", "cam amount", "common area maintenance", "cam charges", "cam per year"],
    tableHeaders: ["cam", "cam_amount", "cam charges", "common area", "cam/yr"],
    description: "Annual CAM charges in USD",
  },
  escalation_rate: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["escalation", "annual increase", "rent increase", "escalation rate", "annual escalation"],
    tableHeaders: ["escalation", "escalation_rate", "increase", "annual increase", "esc rate"],
    patterns: [/(?:annual\s+)?(?:escalation|increase|adjustment)[:\s]+([\d.]+)\s*%/i],
    description: "Annual rent escalation as plain percentage (e.g., 3 for 3%)",
  },
  renewal_options: {
    type: "string",
    labels: ["renewal", "renewal options", "option to renew", "renewal option"],
    tableHeaders: ["renewal", "renewal_options", "options", "renewal options"],
    description: "Description of renewal options",
  },
  ti_allowance: {
    type: "number",
    min: 0,
    labels: ["tenant improvement", "ti allowance", "ti", "tenant improvement allowance", "build-out allowance"],
    tableHeaders: ["ti", "ti_allowance", "tenant improvement", "ti allowance"],
    description: "Tenant improvement allowance in USD",
  },
  free_rent_months: {
    type: "number",
    min: 0,
    max: 60,
    labels: ["free rent", "free rent months", "rent abatement", "rent-free period"],
    tableHeaders: ["free_rent", "free_rent_months", "free rent", "abatement"],
    description: "Number of free rent months",
  },
  lease_term_months: {
    type: "number",
    min: 0,
    derived: true,
    labels: [],
    description: "Lease term in months (computed from start/end dates)",
  },
  status: {
    type: "enum",
    enumValues: ["active", "expired", "pending", "vacant"],
    labels: ["status", "lease status"],
    tableHeaders: ["status", "lease status"],
    description: "One of: active, expired, pending, vacant",
  },
  notes: {
    type: "string",
    labels: [],
    description: "Additional notes or context",
  },
};

// ── Expense schema ───────────────────────────────────────────────────────────

export const EXPENSE_SCHEMA: ModuleSchema = {
  date: {
    type: "date",
    required: true,
    labels: ["date", "expense date", "invoice date", "transaction date", "posted date"],
    tableHeaders: ["date", "expense_date", "invoice date", "transaction date", "posted"],
    description: "Expense date in YYYY-MM-DD",
  },
  category: {
    type: "string",
    required: true,
    labels: ["category", "expense category", "type", "expense type", "account"],
    tableHeaders: ["category", "expense_category", "type", "expense type", "account"],
    description: "Expense category (e.g., maintenance, utilities, insurance)",
  },
  amount: {
    type: "number",
    required: true,
    min: 0,
    labels: ["amount", "total", "cost", "expense amount", "charge"],
    tableHeaders: ["amount", "total", "cost", "charge", "expense amount", "amt"],
    description: "Expense amount in USD (plain number)",
  },
  vendor: {
    type: "string",
    labels: ["vendor", "supplier", "payee", "vendor name", "paid to"],
    tableHeaders: ["vendor", "supplier", "payee", "vendor name", "paid to", "vendor_name"],
    description: "Vendor or supplier name",
  },
  description: {
    type: "string",
    labels: ["description", "memo", "detail", "line description", "notes"],
    tableHeaders: ["description", "memo", "detail", "notes", "line description"],
    description: "Description of the expense",
  },
  classification: {
    type: "enum",
    enumValues: ["recoverable", "non_recoverable", "conditional"],
    labels: ["classification", "recovery type", "recoverable"],
    tableHeaders: ["classification", "recovery", "recoverable", "recovery type"],
    description: "One of: recoverable, non_recoverable, conditional",
  },
  gl_code: {
    type: "string",
    labels: ["gl code", "account code", "gl account", "account number", "gl #"],
    tableHeaders: ["gl_code", "gl code", "account", "account code", "gl #", "gl", "acct"],
    description: "General ledger account code",
  },
  property_name: {
    type: "string",
    labels: ["property", "property name", "building"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    description: "Property name",
  },
  invoice_number: {
    type: "string",
    labels: ["invoice", "invoice number", "invoice #", "ref", "reference"],
    tableHeaders: ["invoice", "invoice_number", "invoice #", "inv #", "reference", "ref"],
    description: "Invoice or reference number",
  },
  fiscal_year: {
    type: "number",
    min: 1990,
    max: 2100,
    labels: ["fiscal year", "year", "fy"],
    tableHeaders: ["fiscal_year", "year", "fy", "fiscal year"],
    description: "4-digit fiscal year",
  },
  month: {
    type: "number",
    min: 1,
    max: 12,
    labels: ["month", "period"],
    tableHeaders: ["month", "period", "mo"],
    description: "Calendar month (1-12)",
  },
};

// ── Property schema ──────────────────────────────────────────────────────────

export const PROPERTY_SCHEMA: ModuleSchema = {
  name: {
    type: "string",
    required: true,
    labels: ["property name", "name", "building name", "asset name", "project name"],
    tableHeaders: ["name", "property_name", "property name", "building name", "property"],
    description: "Property or building name",
  },
  address: {
    type: "string",
    labels: ["address", "street address", "street", "location"],
    tableHeaders: ["address", "street_address", "street address", "street", "location"],
    description: "Street address",
  },
  city: {
    type: "string",
    labels: ["city", "municipality", "town"],
    tableHeaders: ["city", "municipality", "town"],
    description: "City name",
  },
  state: {
    type: "string",
    labels: ["state", "province", "region"],
    tableHeaders: ["state", "province", "region", "st"],
    description: "2-letter US state code",
  },
  zip: {
    type: "string",
    labels: ["zip", "zip code", "postal code", "zipcode"],
    tableHeaders: ["zip", "zip_code", "postal_code", "zip code", "zipcode"],
    description: "ZIP or postal code",
  },
  property_type: {
    type: "enum",
    enumValues: ["office", "retail", "industrial", "mixed_use", "multifamily", "hotel", "land", "other"],
    labels: ["property type", "type", "asset type", "asset class"],
    tableHeaders: ["property_type", "type", "asset type", "asset class"],
    description: "One of: office, retail, industrial, mixed_use, multifamily, hotel, land, other",
  },
  total_sqft: {
    type: "number",
    min: 0,
    labels: ["total sqft", "square footage", "total area", "rentable area", "gross area", "gla"],
    tableHeaders: ["total_sqft", "sqft", "square_footage", "total area", "sf", "gla"],
    patterns: [/([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bGLA\b)/i],
    description: "Total square footage (plain number)",
  },
  year_built: {
    type: "number",
    min: 1800,
    max: 2100,
    labels: ["year built", "construction year", "built", "constructed"],
    tableHeaders: ["year_built", "year built", "built", "constructed"],
    description: "4-digit year built",
  },
  total_units: {
    type: "number",
    min: 0,
    labels: ["total units", "number of units", "units", "unit count"],
    tableHeaders: ["total_units", "units", "unit count", "number of units"],
    description: "Number of units",
  },
  floors: {
    type: "number",
    min: 0,
    labels: ["floors", "stories", "number of floors", "levels"],
    tableHeaders: ["floors", "stories", "levels"],
    description: "Number of floors",
  },
  status: {
    type: "enum",
    enumValues: ["active", "inactive", "under_construction", "sold"],
    labels: ["status", "property status"],
    tableHeaders: ["status", "property status"],
    description: "One of: active, inactive, under_construction, sold",
  },
  purchase_price: {
    type: "number",
    min: 0,
    labels: ["purchase price", "acquisition price", "cost basis"],
    tableHeaders: ["purchase_price", "acquisition price", "cost basis"],
    description: "Purchase price in USD",
  },
  market_value: {
    type: "number",
    min: 0,
    labels: ["market value", "appraised value", "current value", "valuation"],
    tableHeaders: ["market_value", "appraised value", "current value", "valuation"],
    description: "Current market value in USD",
  },
  noi: {
    type: "number",
    labels: ["noi", "net operating income"],
    tableHeaders: ["noi", "net operating income"],
    description: "Annual net operating income in USD",
  },
  cap_rate: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["cap rate", "capitalization rate"],
    tableHeaders: ["cap_rate", "cap rate", "capitalization rate"],
    description: "Cap rate as plain number (5.5 for 5.5%)",
  },
  manager: {
    type: "string",
    labels: ["manager", "property manager", "management company"],
    tableHeaders: ["manager", "property_manager", "management"],
    description: "Property manager name",
  },
  owner: {
    type: "string",
    labels: ["owner", "ownership", "owner name", "landlord"],
    tableHeaders: ["owner", "ownership", "owner name", "landlord"],
    description: "Owner name or entity",
  },
  notes: {
    type: "string",
    labels: [],
    description: "Additional notes",
  },
};

// ── Revenue schema ───────────────────────────────────────────────────────────

export const REVENUE_SCHEMA: ModuleSchema = {
  property_name: {
    type: "string",
    labels: ["property", "property name", "building"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    description: "Property name",
  },
  tenant_name: {
    type: "string",
    labels: ["tenant", "tenant name", "payer"],
    tableHeaders: ["tenant", "tenant_name", "tenant name", "payer"],
    description: "Tenant name",
  },
  type: {
    type: "enum",
    enumValues: ["base_rent", "cam_recovery", "parking", "percentage_rent", "other"],
    labels: ["type", "revenue type", "income type"],
    tableHeaders: ["type", "revenue_type", "income type"],
    description: "One of: base_rent, cam_recovery, parking, percentage_rent, other",
  },
  amount: {
    type: "number",
    required: true,
    min: 0,
    labels: ["amount", "total", "revenue amount", "income"],
    tableHeaders: ["amount", "total", "revenue", "income", "amt"],
    description: "Revenue amount in USD",
  },
  date: {
    type: "date",
    labels: ["date", "revenue date", "period date"],
    tableHeaders: ["date", "revenue_date", "period date"],
    description: "Date in YYYY-MM-DD",
  },
  fiscal_year: {
    type: "number",
    min: 1990,
    max: 2100,
    labels: ["fiscal year", "year", "fy"],
    tableHeaders: ["fiscal_year", "year", "fy"],
    description: "4-digit fiscal year",
  },
  month: {
    type: "number",
    min: 1,
    max: 12,
    labels: ["month", "period"],
    tableHeaders: ["month", "period"],
    description: "Calendar month (1-12)",
  },
  notes: {
    type: "string",
    labels: [],
    description: "Additional notes",
  },
};

// ── Unit schema ──────────────────────────────────────────────────────────────

export const UNIT_SCHEMA: ModuleSchema = {
  unit_number: {
    type: "string",
    required: true,
    labels: ["unit", "suite", "space", "unit number"],
    tableHeaders: ["unit", "suite", "space", "unit_number", "unit number", "suite #"],
    description: "Unit or suite identifier",
  },
  floor: {
    type: "number",
    labels: ["floor", "level", "story"],
    tableHeaders: ["floor", "level", "story"],
    description: "Floor number",
  },
  square_footage: {
    type: "number",
    min: 0,
    labels: ["sqft", "square footage", "area", "sf"],
    tableHeaders: ["sqft", "sf", "square_footage", "area", "square footage"],
    description: "Rentable square footage",
  },
  unit_type: {
    type: "enum",
    enumValues: ["office", "retail", "industrial", "residential", "storage", "other"],
    labels: ["type", "unit type", "space type"],
    tableHeaders: ["type", "unit_type", "space type"],
    description: "One of: office, retail, industrial, residential, storage, other",
  },
  status: {
    type: "enum",
    enumValues: ["vacant", "occupied", "under_renovation"],
    labels: ["status", "occupancy"],
    tableHeaders: ["status", "occupancy"],
    description: "One of: vacant, occupied, under_renovation",
  },
  monthly_rent: {
    type: "number",
    min: 0,
    labels: ["rent", "monthly rent", "asking rent"],
    tableHeaders: ["rent", "monthly_rent", "monthly rent", "asking rent"],
    description: "Monthly rent in USD",
  },
  tenant_name: {
    type: "string",
    labels: ["tenant", "occupant"],
    tableHeaders: ["tenant", "tenant_name", "occupant"],
    description: "Current tenant name (if occupied)",
  },
};

// ── Tenant / Building / GL schemas (minimal) ─────────────────────────────────

export const TENANT_SCHEMA: ModuleSchema = {
  name: { type: "string", required: true, labels: ["name", "tenant name", "company name"], tableHeaders: ["name", "tenant", "company"], description: "Tenant or company name" },
  company: { type: "string", labels: ["company", "business", "entity"], tableHeaders: ["company", "business", "entity"], description: "Company name" },
  email: { type: "string", labels: ["email", "e-mail"], tableHeaders: ["email", "e-mail"], description: "Email address" },
  phone: { type: "string", labels: ["phone", "telephone", "tel"], tableHeaders: ["phone", "telephone", "tel"], description: "Phone number" },
  contact_name: { type: "string", labels: ["contact", "contact name", "primary contact"], tableHeaders: ["contact", "contact_name", "primary contact"], description: "Primary contact person" },
  industry: { type: "string", labels: ["industry", "sector"], tableHeaders: ["industry", "sector"], description: "Business industry" },
  credit_rating: { type: "string", labels: ["credit", "credit rating", "rating"], tableHeaders: ["credit", "credit_rating", "rating"], description: "Credit rating" },
  status: { type: "enum", enumValues: ["active", "inactive"], labels: ["status"], tableHeaders: ["status"], description: "active or inactive" },
};

export const BUILDING_SCHEMA: ModuleSchema = {
  name: { type: "string", required: true, labels: ["building name", "name"], tableHeaders: ["name", "building", "building name"], description: "Building name" },
  address: { type: "string", labels: ["address", "street"], tableHeaders: ["address", "street"], description: "Street address" },
  total_sqft: { type: "number", min: 0, labels: ["sqft", "total sqft", "area"], tableHeaders: ["sqft", "total_sqft", "area", "sf"], description: "Total square footage" },
  floors: { type: "number", min: 0, labels: ["floors", "stories"], tableHeaders: ["floors", "stories"], description: "Number of floors" },
  year_built: { type: "number", min: 1800, max: 2100, labels: ["year built", "built"], tableHeaders: ["year_built", "built"], description: "Year built" },
  status: { type: "string", labels: ["status"], tableHeaders: ["status"], description: "Building status" },
};

export const GL_ACCOUNT_SCHEMA: ModuleSchema = {
  code: { type: "string", required: true, labels: ["code", "account code", "gl code", "account number"], tableHeaders: ["code", "account", "gl_code", "account code", "gl #"], description: "GL account code" },
  name: { type: "string", required: true, labels: ["name", "account name", "description"], tableHeaders: ["name", "account_name", "description"], description: "Account name" },
  type: { type: "enum", enumValues: ["income", "expense", "asset", "liability", "equity"], labels: ["type", "account type"], tableHeaders: ["type", "account_type"], description: "Account type" },
  category: { type: "string", labels: ["category", "group"], tableHeaders: ["category", "group"], description: "Account category" },
  normal_balance: { type: "enum", enumValues: ["debit", "credit"], labels: ["normal balance", "balance type"], tableHeaders: ["normal_balance", "balance"], description: "debit or credit" },
  is_active: { type: "boolean", labels: ["active", "is active"], tableHeaders: ["active", "is_active"], description: "true if active" },
  is_recoverable: { type: "boolean", labels: ["recoverable", "cam recoverable"], tableHeaders: ["recoverable", "is_recoverable", "cam"], description: "true if CAM-recoverable" },
};

// ── Schema registry ──────────────────────────────────────────────────────────

const SCHEMA_MAP: Record<ModuleType, ModuleSchema> = {
  lease: LEASE_SCHEMA,
  expense: EXPENSE_SCHEMA,
  property: PROPERTY_SCHEMA,
  revenue: REVENUE_SCHEMA,
  unit: UNIT_SCHEMA,
  tenant: TENANT_SCHEMA,
  building: BUILDING_SCHEMA,
  gl_account: GL_ACCOUNT_SCHEMA,
};

function normalizeModuleType(moduleType: string): ModuleType {
  const aliases: Record<string, ModuleType> = {
    leases: "lease",
    lease: "lease",
    expenses: "expense",
    invoices: "expense",
    expense: "expense",
    properties: "property",
    property: "property",
    revenue: "revenue",
    revenues: "revenue",
    buildings: "building",
    building: "building",
    units: "unit",
    unit: "unit",
    tenants: "tenant",
    tenant: "tenant",
    gl_accounts: "gl_account",
    gl_account: "gl_account",
    cam: "expense",
    budgets: "expense",
    documents: "lease",
  };

  return aliases[moduleType] ?? (moduleType as ModuleType);
}

export function getSchema(moduleType: ModuleType): ModuleSchema {
  return SCHEMA_MAP[normalizeModuleType(moduleType as string)] ?? PROPERTY_SCHEMA;
}

// ── Field groups for LLM extraction ──────────────────────────────────────────
// Each group is one LLM call — keeps prompts focused and reduces hallucination

const LEASE_GROUPS: FieldGroup[] = [
  { name: "parties", fields: ["tenant_name", "property_name", "unit_number"], hint: "Identify the tenant, property, and unit/suite." },
  { name: "dates", fields: ["start_date", "end_date"], hint: "Find lease commencement and expiration dates." },
  { name: "financial", fields: ["monthly_rent", "rent_per_sf", "security_deposit", "cam_amount", "escalation_rate"], hint: "Extract rent amounts, deposits, CAM charges, and escalation rates." },
  { name: "terms", fields: ["square_footage", "lease_type", "renewal_options", "ti_allowance", "free_rent_months", "status"], hint: "Find space size, lease type, renewal terms, and TI allowance." },
];

const EXPENSE_GROUPS: FieldGroup[] = [
  { name: "transaction", fields: ["date", "amount", "vendor", "invoice_number"], hint: "Find the expense date, amount, vendor, and invoice number." },
  { name: "classification", fields: ["category", "classification", "gl_code"], hint: "Identify expense category, recoverability, and GL code." },
  { name: "context", fields: ["property_name", "description", "fiscal_year", "month"], hint: "Find property context, description, and time period." },
];

const PROPERTY_GROUPS: FieldGroup[] = [
  { name: "identity", fields: ["name", "address", "city", "state", "zip", "property_type"], hint: "Find the property name, address, and type." },
  { name: "physical", fields: ["total_sqft", "year_built", "total_units", "floors", "status"], hint: "Find physical characteristics: size, age, units, floors." },
  { name: "financial", fields: ["purchase_price", "market_value", "noi", "cap_rate"], hint: "Find financial metrics: price, value, NOI, cap rate." },
  { name: "management", fields: ["manager", "owner"], hint: "Find manager and owner names." },
];

const REVENUE_GROUPS: FieldGroup[] = [
  { name: "record", fields: ["property_name", "tenant_name", "type", "amount", "date", "fiscal_year", "month"], hint: "Find revenue details: property, tenant, type, amount, date." },
];

const SIMPLE_GROUP: FieldGroup[] = [
  { name: "all", fields: [], hint: "Extract all available fields." }, // fields filled dynamically
];

const GROUP_MAP: Record<ModuleType, FieldGroup[]> = {
  lease: LEASE_GROUPS,
  expense: EXPENSE_GROUPS,
  property: PROPERTY_GROUPS,
  revenue: REVENUE_GROUPS,
  unit: SIMPLE_GROUP,
  tenant: SIMPLE_GROUP,
  building: SIMPLE_GROUP,
  gl_account: SIMPLE_GROUP,
};

export function getFieldGroups(moduleType: ModuleType): FieldGroup[] {
  const normalizedModuleType = normalizeModuleType(moduleType as string);
  const groups = GROUP_MAP[normalizedModuleType] ?? SIMPLE_GROUP;

  // For simple groups, populate fields from schema
  if (groups === SIMPLE_GROUP || (groups.length === 1 && groups[0].fields.length === 0)) {
    const schema = getSchema(normalizedModuleType);
    const allFields = Object.keys(schema).filter((f) => !schema[f].derived);
    return [{ name: "all", fields: allFields, hint: `Extract all ${normalizedModuleType} fields.` }];
  }

  return groups;
}

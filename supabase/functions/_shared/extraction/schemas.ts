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
    labels: ["property", "property name", "building", "building name"],
    tableHeaders: ["property", "property_name", "property name", "building"],
    description: "Name of the property or building",
  },
  property_address: {
    type: "string",
    required: true,
    labels: ["property address", "premises", "premises address", "address", "location", "street address"],
    tableHeaders: ["property_address", "property address", "premises", "address", "location", "street address"],
    patterns: [
      /(?:premises|property\s+address|premises\s+address|street\s+address|address)[:\s]+([^\n]{4,180})/i,
    ],
    description: "Street address or premises description for the leased property",
  },
  landlord_name: {
    type: "string",
    required: true,
    labels: ["landlord", "lessor", "owner", "landlord name", "lessor name"],
    tableHeaders: ["landlord", "landlord_name", "landlord name", "lessor", "owner"],
    patterns: [/(?:landlord\s+name|lessor\s+name|landlord|lessor|owner)\s*[:\-]\s*([^\n]{2,120})/i],
    description: "Name of the landlord, lessor, or property owner",
  },
  assignor_name: {
    type: "string",
    labels: ["assignor", "original tenant", "current tenant", "seller", "transferor"],
    tableHeaders: ["assignor", "assignor_name", "original tenant", "transferor"],
    patterns: [/(?:assignor|original tenant|transferor)[:\s]+([^\n]{2,120})/i],
    description: "For lease assignments, the party assigning or transferring the lease",
  },
  assignee_name: {
    type: "string",
    labels: ["assignee", "new tenant", "successor tenant", "buyer", "transferee"],
    tableHeaders: ["assignee", "assignee_name", "new tenant", "transferee"],
    patterns: [/(?:assignee|new tenant|transferee)[:\s]+([^\n]{2,120})/i],
    description: "For lease assignments, the party receiving or assuming the lease",
  },
  assignment_effective_date: {
    type: "date",
    labels: ["assignment effective date", "effective date", "date of assignment", "assignment date"],
    tableHeaders: ["assignment_effective_date", "effective date", "assignment date"],
    patterns: [
      /(?:assignment\s+effective\s+date|date\s+of\s+assignment|assignment\s+date)[:\s]+([A-Za-z]+\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/i,
    ],
    description: "For lease assignments, the assignment effective date in YYYY-MM-DD",
  },
  landlord_consent: {
    type: "boolean",
    labels: ["landlord consent", "consent", "consent required", "landlord approval"],
    tableHeaders: ["landlord_consent", "consent", "landlord approval"],
    patterns: [/(?:landlord\s+consent|landlord\s+approval|consent)[:\s]+(yes|no|true|false|required|received|granted)/i],
    description: "Whether landlord consent or approval is stated for the assignment",
  },
  assumption_scope: {
    type: "string",
    labels: ["assumption", "assumption scope", "assumes", "obligations assumed", "scope of assumption"],
    tableHeaders: ["assumption_scope", "assumption", "obligations assumed"],
    description: "Assignment assumption language or obligations assumed by the assignee",
  },
  assignee_notice_address: {
    type: "string",
    labels: ["assignee notice address", "notice address", "address for notices", "assignee address"],
    tableHeaders: ["assignee_notice_address", "notice address", "assignee address"],
    description: "Notice address for the assignee or new tenant",
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
      /(?:monthly\s+rent|base\s+rent|minimum\s+rent)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /(?:monthly|base)\s*rent[:\s]+\$?\s*([\d,]+(?:\.\d{2})?)/i,
    ],
    description: "Base rent per month in USD (plain number, no $ or commas)",
  },
  annual_rent: {
    type: "number",
    min: 0,
    labels: ["annual rent", "yearly rent", "annual base rent", "base annual rent", "rent per year", "base rent additional year", "additional year base rent"],
    tableHeaders: ["annual_rent", "annual rent", "yearly rent", "annual base rent"],
    patterns: [
      /(?:annual|yearly|base\s+annual)\s+rent[:\s]+\$?\s*([\d,]+(?:\.\d{2})?)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s*year|\/year|\/yr|annually)/i,
    ],
    description: "Annual rent in USD. Can be extracted or computed from monthly rent.",
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
    labels: ["square footage", "rentable area", "leased area", "premises rentable square feet", "rentable square feet", "sq ft", "rsf", "usable area", "area"],
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
  late_fee_amount: {
    type: "number",
    min: 0,
    labels: ["late fee", "late charge"],
    tableHeaders: ["late_fee", "late fee", "late charge"],
    patterns: [/(?:late\s+fee|late\s+charge)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Explicit late fee amount in USD, if stated in the lease",
  },
  returned_payment_fee_amount: {
    type: "number",
    min: 0,
    labels: ["returned payment fee", "returned check fee", "dishonored payment fee"],
    tableHeaders: ["returned_payment_fee", "returned payment fee", "returned check fee"],
    patterns: [/(?:returned\s+payment\s+fee|returned\s+check\s+fee|dishonored\s+payment)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Explicit returned payment / bounced payment fee in USD",
  },
  application_fee_amount: {
    type: "number",
    min: 0,
    labels: ["application fee"],
    tableHeaders: ["application_fee", "application fee"],
    patterns: [/(?:application\s+fee)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Application fee amount in USD, if stated",
  },
  administrative_fee_amount: {
    type: "number",
    min: 0,
    labels: ["administrative fee", "admin fee"],
    tableHeaders: ["administrative_fee", "administrative fee", "admin fee"],
    patterns: [/(?:administrative\s+fee|admin\s+fee)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Administrative or admin fee amount in USD, if stated",
  },
  pet_fee_amount: {
    type: "number",
    min: 0,
    labels: ["pet fee"],
    tableHeaders: ["pet_fee", "pet fee"],
    patterns: [/(?:pet\s+fee)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "One-time pet fee amount in USD, if stated",
  },
  pet_rent_amount: {
    type: "number",
    min: 0,
    labels: ["pet rent"],
    tableHeaders: ["pet_rent", "pet rent"],
    patterns: [/(?:pet\s+rent)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Recurring pet rent amount in USD, if stated",
  },
  parking_fee_amount: {
    type: "number",
    min: 0,
    labels: ["parking fee", "garage fee", "parking charge"],
    tableHeaders: ["parking_fee", "parking fee", "garage fee"],
    patterns: [/(?:parking\s+fee|garage\s+fee|parking\s+charge)[^\n$]{0,80}\$?\s*([\d,]+(?:\.\d{2})?)/i],
    description: "Recurring parking or garage fee amount in USD, if stated",
  },
  cam_amount: {
    type: "number",
    min: 0,
    labels: ["cam", "cam amount", "common area maintenance", "cam charges", "cam per year"],
    tableHeaders: ["cam", "cam_amount", "cam charges", "common area", "cam/yr"],
    description: "Annual CAM charges in USD",
  },
  utility_reimbursement_amount: {
    type: "number",
    min: 0,
    labels: ["utility reimbursement", "utility reimbursement amount", "utility charge"],
    tableHeaders: ["utility_reimbursement_amount", "utility reimbursement", "utility charge"],
    patterns: [
      /(?:utility\s+reimbursement|utility\s+charge)[^\n$]{0,40}\$\s*([\d,]+(?:\.\d{2})?)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+month|monthly)?[^\n]{0,60}(?:utility\s+reimbursement|utility\s+charge)/i,
    ],
    description: "Explicit utility reimbursement or utility charge amount in USD, if stated",
  },
  water_sewer_reimbursement_amount: {
    type: "number",
    min: 0,
    labels: ["water/sewer reimbursement", "water sewer reimbursement", "water/sewer charge", "water sewer charge"],
    tableHeaders: ["water_sewer_reimbursement_amount", "water/sewer reimbursement", "water sewer reimbursement", "water/sewer charge"],
    patterns: [
      /(?:water\s*\/?\s*sewer\s+(?:reimbursement|charge))[^\n$]{0,40}\$\s*([\d,]+(?:\.\d{2})?)/i,
      /\$\s*([\d,]+(?:\.\d{2})?)\s*(?:per\s+month|monthly)?[^\n]{0,80}(?:water\s*\/?\s*sewer\s+(?:reimbursement|charge))/i,
    ],
    description: "Explicit recurring water/sewer reimbursement amount in USD, if stated",
  },
  electric_responsibility: {
    type: "string",
    labels: ["electric responsibility", "electric utility", "electric"],
    tableHeaders: ["electric_responsibility", "electric responsibility"],
    patterns: [/((?:tenant|landlord)\s+must\s+pay\s+electric[^.\n]{0,120})/i],
    description: "Clause describing who is responsible for electric service",
  },
  water_sewer_responsibility: {
    type: "string",
    labels: ["water/sewer responsibility", "water sewer responsibility", "water/sewer utility"],
    tableHeaders: ["water_sewer_responsibility", "water/sewer responsibility"],
    patterns: [/((?:tenant|landlord)[^.\n]{0,80}(?:water\s*\/?\s*sewer)[^.\n]{0,140})/i],
    description: "Clause describing who is responsible for water and sewer charges",
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
    labels: ["lease term months", "term months", "lease term", "term"],
    tableHeaders: ["lease_term_months", "term months", "lease term", "term"],
    patterns: [
      /(?:lease\s+term\s+months|term\s+months)[:\s]+(\d{1,3})/i,
      /(?:lease\s+term|term)[:\s]+(\d{1,3})\s*(?:months|mos?\.?)/i,
    ],
    description: "Lease term in months. Can be extracted or computed from start/end dates.",
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
  property_id_code: {
    type: "string",
    labels: ["property id", "property code", "property number", "asset id"],
    tableHeaders: ["property id", "property_id", "property_id_code", "property code", "asset id"],
    description: "Property identifier or code from the source document",
  },
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
    enumValues: ["office", "retail", "industrial", "mixed_use", "multifamily", "single_family", "hotel", "land", "other"],
    labels: ["property type", "type", "asset type", "asset class"],
    tableHeaders: ["property_type", "type", "asset type", "asset class"],
    description: "One of: office, retail, industrial, mixed_use, multifamily, hotel, land, other",
  },
  structure_type: {
    type: "enum",
    enumValues: ["single", "multi"],
    labels: ["structure type", "structure", "building structure", "single tenant", "multi tenant"],
    tableHeaders: ["structure_type", "structure", "building structure"],
    description: "Whether the property is single-building/single-tenant or multi-building/multi-tenant when stated",
  },
  total_sqft: {
    type: "number",
    min: 0,
    labels: ["total sqft", "square footage", "total area", "rentable area", "gross area", "gla"],
    tableHeaders: ["total_sqft", "sqft", "square_footage", "total area", "sf", "gla"],
    patterns: [/([\d,]+)\s*(?:square\s*feet|sq\.?\s*ft\.?|\bSF\b|\bGLA\b)/i],
    description: "Total square footage (plain number)",
  },
  leased_sf: {
    type: "number",
    min: 0,
    labels: ["leased sf", "leased square footage", "occupied sf", "occupied square feet"],
    tableHeaders: ["leased_sf", "leased sf", "occupied sf", "leased square footage"],
    description: "Leased or occupied square footage when provided",
  },
  total_buildings: {
    type: "number",
    min: 0,
    labels: ["total buildings", "number of buildings", "buildings", "building count"],
    tableHeaders: ["total_buildings", "buildings", "building count", "number of buildings"],
    description: "Number of buildings on the property",
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
  occupancy_pct: {
    type: "number",
    min: 0,
    max: 100,
    labels: ["occupancy", "occupancy percent", "occupancy pct", "occupied percentage"],
    tableHeaders: ["occupancy_pct", "occupancy", "occupancy percent", "occupancy pct"],
    description: "Occupancy percentage as a plain number (90 for 90%)",
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
    enumValues: ["active", "inactive", "under_construction", "under_renovation", "sold"],
    labels: ["status", "property status", "renovation status"],
    tableHeaders: ["status", "property status"],
    description: "One of: active, inactive, under_construction, under_renovation, sold",
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
    labels: ["manager", "manager name", "property manager", "management company"],
    tableHeaders: ["manager", "manager name", "manager_name", "property_manager", "management"],
    description: "Property manager name",
  },
  owner: {
    type: "string",
    labels: ["owner", "ownership", "owner name", "owner entity", "landlord"],
    tableHeaders: ["owner", "ownership", "owner name", "owner entity", "landlord"],
    description: "Owner name or entity",
  },
  contact: {
    type: "string",
    labels: ["contact", "property contact"],
    tableHeaders: ["contact", "property contact"],
    description: "Property contact phone/email or contact summary",
  },
  phone: {
    type: "string",
    labels: ["phone", "telephone"],
    tableHeaders: ["phone", "telephone", "phone number"],
    description: "Property manager or owner phone number",
  },
  email: {
    type: "string",
    labels: ["email", "email address"],
    tableHeaders: ["email", "email address"],
    description: "Property manager or owner email address",
  },
  acquired_date: {
    type: "date",
    labels: ["acquired date", "acquisition date", "purchase date"],
    tableHeaders: ["acquired date", "acquired_date", "acquisition date", "purchase date"],
    description: "Date the property was acquired",
  },
  parcel_tax_id: {
    type: "string",
    labels: ["parcel id", "tax id", "parcel / tax id", "parcel number"],
    tableHeaders: ["parcel / tax id", "parcel tax id", "parcel_tax_id", "parcel id", "tax id"],
    description: "Parcel or tax identifier",
  },
  parking_spaces: {
    type: "number",
    min: 0,
    labels: ["parking spaces", "parking count", "parking"],
    tableHeaders: ["parking spaces", "parking", "parking count"],
    description: "Number of parking spaces",
  },
  amenities: {
    type: "string",
    labels: ["amenities", "features"],
    tableHeaders: ["amenities", "features"],
    description: "Property amenities or features",
  },
  insurance_policy: {
    type: "string",
    labels: ["insurance policy", "policy number", "insurance"],
    tableHeaders: ["insurance policy", "insurance_policy", "policy number", "insurance"],
    description: "Insurance policy identifier",
  },
  notes: {
    type: "string",
    labels: ["notes", "comments"],
    tableHeaders: ["notes", "comments"],
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
  property_id: {
    type: "string",
    labels: ["property uuid", "parent property uuid"],
    tableHeaders: ["property uuid", "property_uuid", "parent property uuid"],
    description: "Existing parent property UUID when present",
  },
  property_id_code: {
    type: "string",
    labels: ["property id", "property code", "parent property code"],
    tableHeaders: ["property id", "property_id", "property_id_code", "property code", "parent property id", "asset id"],
    description: "Business identifier/code for the parent property",
  },
  property_name: {
    type: "string",
    labels: ["property", "property name", "parent property", "site"],
    tableHeaders: ["property", "property_name", "property name", "parent property", "parent property name", "site"],
    description: "Name of the parent property",
  },
  building_id: {
    type: "string",
    labels: ["building uuid", "parent building uuid"],
    tableHeaders: ["building uuid", "building_uuid", "parent building uuid"],
    description: "Existing parent building UUID when present",
  },
  building_id_code: {
    type: "string",
    labels: ["building id", "building code", "parent building code"],
    tableHeaders: ["building id", "building_id", "building_id_code", "building code", "parent building id"],
    description: "Business identifier/code for the parent building",
  },
  building_name: {
    type: "string",
    labels: ["building", "building name", "parent building"],
    tableHeaders: ["building", "building_name", "building name", "parent building", "parent building name"],
    description: "Name of the parent building",
  },
  unit_id_code: {
    type: "string",
    labels: ["unit id", "unit code"],
    tableHeaders: ["unit id", "unit_id", "unit_id_code", "unit code"],
    description: "Business identifier/code for the unit",
  },
  unit_number: {
    type: "string",
    required: true,
    labels: ["unit", "suite", "space", "unit number", "unit no"],
    tableHeaders: ["unit", "suite", "space", "unit_number", "unit number", "unit no", "unit no.", "unit #", "suite #"],
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
    tableHeaders: ["sqft", "sq ft", "sf", "square_footage", "area", "square footage", "square feet"],
    description: "Rentable square footage",
  },
  bedroom_bathroom: {
    type: "string",
    labels: ["bed bath", "bed/bath", "beds baths"],
    tableHeaders: ["bed/bath", "bed bath", "beds/baths", "bedroom_bathroom"],
    description: "Bedroom/bathroom description",
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
    enumValues: ["vacant", "occupied", "notice", "under_renovation"],
    labels: ["status", "occupancy"],
    tableHeaders: ["status", "occupancy", "lease status", "occupancy status"],
    description: "One of: vacant, occupied, under_renovation",
  },
  monthly_rent: {
    type: "number",
    min: 0,
    labels: ["rent", "monthly rent", "asking rent", "market rent"],
    tableHeaders: ["rent", "monthly_rent", "monthly rent", "asking rent", "market rent"],
    description: "Monthly rent in USD",
  },
  tenant_name: {
    type: "string",
    labels: ["tenant", "occupant"],
    tableHeaders: ["tenant", "tenant_name", "occupant"],
    description: "Current tenant name (if occupied)",
  },
  lease_start: {
    type: "date",
    labels: ["lease start", "start date"],
    tableHeaders: ["lease start", "lease_start", "start date"],
    description: "Lease start date",
  },
  lease_end: {
    type: "date",
    labels: ["lease end", "end date"],
    tableHeaders: ["lease end", "lease_end", "end date"],
    description: "Lease end date",
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
  property_id: { type: "string", labels: ["property uuid", "parent property uuid"], tableHeaders: ["property uuid", "property_uuid", "parent property uuid"], description: "Existing parent property UUID when present" },
  property_id_code: { type: "string", labels: ["property id", "property code", "parent property code"], tableHeaders: ["property id", "property_id_code", "property code", "parent property id", "asset id"], description: "Business identifier/code for the parent property" },
  property_name: { type: "string", labels: ["property", "property name", "parent property", "site"], tableHeaders: ["property", "property_name", "property name", "parent property", "parent property name", "site"], description: "Name of the parent property the building belongs to" },
  building_id_code: { type: "string", labels: ["building id", "building code"], tableHeaders: ["building id", "building_id", "building_id_code", "building code"], description: "Business identifier/code for the building" },
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
  { name: "parties", fields: ["tenant_name", "landlord_name", "property_name", "property_address", "unit_number"], hint: "Identify the tenant, landlord, property name, property address/premises, and unit/suite." },
  { name: "assignment", fields: ["assignor_name", "assignee_name", "assignment_effective_date", "landlord_consent", "assumption_scope", "assignee_notice_address"], hint: "For assignments, identify assignor, assignee, effective date, consent, assumption language, and notice address." },
  { name: "dates", fields: ["start_date", "end_date"], hint: "Find lease commencement and expiration dates." },
  { name: "financial", fields: ["monthly_rent", "annual_rent", "rent_per_sf", "security_deposit", "cam_amount", "escalation_rate"], hint: "Extract monthly rent, annual rent, deposits, CAM charges, and escalation rates." },
  { name: "terms", fields: ["square_footage", "lease_type", "lease_term_months", "renewal_options", "ti_allowance", "free_rent_months", "status"], hint: "Find space size, lease type, term months, renewal terms, and TI allowance." },
];

const EXPENSE_GROUPS: FieldGroup[] = [
  { name: "transaction", fields: ["date", "amount", "vendor", "invoice_number"], hint: "Find the expense date, amount, vendor, and invoice number." },
  { name: "classification", fields: ["category", "classification", "gl_code"], hint: "Identify expense category, recoverability, and GL code." },
  { name: "context", fields: ["property_name", "description", "fiscal_year", "month"], hint: "Find property context, description, and time period." },
];

const PROPERTY_GROUPS: FieldGroup[] = [
  { name: "identity", fields: ["property_id_code", "name", "address", "city", "state", "zip", "property_type", "structure_type"], hint: "Find the property identifier, name, address, type, and structure." },
  { name: "physical", fields: ["total_sqft", "leased_sf", "total_buildings", "year_built", "total_units", "occupancy_pct", "floors", "status", "parking_spaces", "amenities"], hint: "Find physical characteristics: size, leased/occupied area, building count, age, units, occupancy, floors, parking, and amenities." },
  { name: "financial", fields: ["purchase_price", "market_value", "noi", "cap_rate"], hint: "Find financial metrics: price, value, NOI, cap rate." },
  { name: "management", fields: ["manager", "owner", "contact", "phone", "email", "acquired_date", "parcel_tax_id", "insurance_policy", "notes"], hint: "Find manager, owner, contact details, phone, email, acquisition date, parcel/tax ID, insurance policy, and notes." },
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

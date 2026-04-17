// @ts-nocheck
/**
 * Extraction Pipeline — Step 1: Rule-Based Extraction
 *
 * Pure regex / pattern matching against Docling output.
 * This runs FIRST and is the most reliable (no AI hallucination).
 *
 * Extracts from:
 *   1. Docling key-value fields (highest priority — already parsed by Docling)
 *   2. Text blocks via regex patterns defined in schemas
 *   3. Label-value patterns ("Label: value" or "Label  value")
 *
 * Returns: partial records with only the fields that matched.
 */

import type {
  DoclingOutput,
  DoclingField,
  ExtractedField,
  ExtractedRecord,
  StepResult,
  ModuleType,
} from "./types.ts";
import { getSchema, type ModuleSchema, type FieldDef } from "./schemas.ts";

// ── Value parsers ────────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08", sep: "09",
  oct: "10", nov: "11", dec: "12",
};

/** Parse a date string into YYYY-MM-DD or return null */
export function parseDate(s: string): string | null {
  if (!s) return null;
  s = s.trim().replace(/\s+/g, " ");

  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or M/D/YYYY
  const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (us) return `${us[3]}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;

  // MM/DD/YY
  const usShort = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2})$/);
  if (usShort) {
    const yr = parseInt(usShort[3]) > 50 ? `19${usShort[3]}` : `20${usShort[3]}`;
    return `${yr}-${usShort[1].padStart(2, "0")}-${usShort[2].padStart(2, "0")}`;
  }

  // "January 1, 2025" or "January 1 2025"
  const longMDY = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longMDY) {
    const m = MONTHS[longMDY[1].toLowerCase()];
    if (m) return `${longMDY[3]}-${m}-${longMDY[2].padStart(2, "0")}`;
  }

  // "1 January 2025"
  const longDMY = s.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (longDMY) {
    const m = MONTHS[longDMY[2].toLowerCase()];
    if (m) return `${longDMY[3]}-${m}-${longDMY[1].padStart(2, "0")}`;
  }

  // Just a year → first day of year
  if (/^\d{4}$/.test(s)) return `${s}-01-01`;

  return null;
}

/** Strip currency symbols and commas, return number or null */
export function parseMoney(s: string): number | null {
  if (!s) return null;
  let cleaned = s.replace(/[$€£,\s]/g, "").replace(/\/month.*$/i, "").replace(/\/yr.*$/i, "").trim();

  // Handle accounting-style negatives: (12500) → -12500
  const accounting = cleaned.match(/^\(([0-9.]+)\)$/);
  if (accounting) return -parseFloat(accounting[1]);

  // Handle leading minus: -12500
  const isNegative = cleaned.startsWith("-");
  if (isNegative) cleaned = cleaned.slice(1);

  // Handle "$1.2M" or "$500K"
  const multiplier = cleaned.match(/([\d.]+)\s*([MmKk])$/);
  if (multiplier) {
    const base = parseFloat(multiplier[1]);
    const mult = /[Mm]/.test(multiplier[2]) ? 1_000_000 : 1_000;
    if (isNaN(base)) return null;
    return isNegative ? -(base * mult) : base * mult;
  }

  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return isNegative ? -n : n;
}

/** Parse a percentage value: "3%" → 3, "350 bps" → 3.5 */
export function parsePercent(s: string): number | null {
  if (!s) return null;
  const pct = s.match(/([\d.]+)\s*%/);
  if (pct) return parseFloat(pct[1]);
  const bps = s.match(/([\d.]+)\s*(?:bps|basis\s*points?)/i);
  if (bps) return parseFloat(bps[1]) / 100;
  return null;
}

/** Parse enum: match against allowed values (case-insensitive, fuzzy) */
export function parseEnum(s: string, allowed: string[]): string | null {
  if (!s) return null;
  const lower = s.toLowerCase().trim();

  // Exact match
  const exact = allowed.find((v) => v === lower);
  if (exact) return exact;

  // Contains match
  const partial = allowed.find((v) => lower.includes(v) || v.includes(lower));
  if (partial) return partial;

  // Special mappings
  const ENUM_ALIASES: Record<string, string> = {
    "triple net": "nnn", "triple-net": "nnn",
    "full service": "gross", "full-service": "gross",
    "modified gross": "modified_gross", "modified-gross": "modified_gross",
    "double net": "nn", "double-net": "nn",
    "non recoverable": "non_recoverable", "non-recoverable": "non_recoverable",
    "not recoverable": "non_recoverable",
  };
  return ENUM_ALIASES[lower] ?? null;
}

/** Coerce raw string to the correct type based on FieldDef */
export function coerceValue(raw: string, fieldDef: FieldDef): unknown {
  if (!raw || raw.trim() === "") return null;
  const trimmed = raw.trim();

  switch (fieldDef.type) {
    case "string":
      return trimmed;
    case "number": {
      const n = parseMoney(trimmed);
      if (n === null) return null;
      if (fieldDef.min !== undefined && n < fieldDef.min) return null;
      if (fieldDef.max !== undefined && n > fieldDef.max) return null;
      return n;
    }
    case "date": {
      const parsed = parseDate(trimmed);
      // Preserve lease date phrases like "January 31st of each year" so the
      // row-aware validator can infer the concrete year from start_date.
      if (parsed) return parsed;
      if (/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(trimmed)) {
        return trimmed;
      }
      return null;
    }
    case "boolean": {
      const b = trimmed.toLowerCase();
      if (["true", "yes", "y", "1", "granted", "received", "approved"].includes(b)) return true;
      if (["false", "no", "n", "0", "denied", "not granted", "not approved"].includes(b)) return false;
      if (/\b(consents?|consented|approval|approved|grants?|granted)\b/i.test(trimmed)) return true;
      if (/\b(does not consent|not approved|denied|withheld)\b/i.test(trimmed)) return false;
      return null;
    }
    case "enum":
      return parseEnum(trimmed, fieldDef.enumValues ?? []);
    default:
      return trimmed;
  }
}

const CANONICAL_LEASE_FIELD_ALIASES: Record<string, string> = {
  tenant: "tenant_name",
  tenant_name: "tenant_name",
  tenant_legal_name: "tenant_name",
  tenant_company: "tenant_name",
  tenant_entity: "tenant_name",
  lessee: "tenant_name",
  lessee_name: "tenant_name",
  occupant: "tenant_name",
  customer: "tenant_name",

  landlord: "landlord_name",
  landlord_name: "landlord_name",
  landlord_legal_name: "landlord_name",
  lessor: "landlord_name",
  lessor_name: "landlord_name",
  owner: "landlord_name",
  owner_name: "landlord_name",

  property: "property_name",
  property_name: "property_name",
  project_name: "property_name",
  building_name: "property_name",
  shopping_center: "property_name",
  center_name: "property_name",

  property_address: "property_address",
  property_location: "property_address",
  street_address: "property_address",
  premises: "property_address",
  premises_address: "property_address",
  premises_location: "property_address",
  leased_premises: "property_address",
  leased_premises_address: "property_address",
  building_address: "property_address",
  suite_address: "property_address",

  unit: "unit_number",
  unit_number: "unit_number",
  suite: "unit_number",
  suite_number: "unit_number",
  suite_no: "unit_number",
  space: "unit_number",
  space_number: "unit_number",
  premises_suite: "unit_number",

  start_date: "start_date",
  lease_start: "start_date",
  lease_start_date: "start_date",
  commencement: "start_date",
  commencement_date: "start_date",
  lease_commencement_date: "start_date",
  possession_date: "start_date",
  rent_commencement_date: "start_date",

  end_date: "end_date",
  lease_end: "end_date",
  lease_end_date: "end_date",
  expiration: "end_date",
  expiration_date: "end_date",
  expiry: "end_date",
  expiry_date: "end_date",
  lease_expiration: "end_date",
  lease_expiration_date: "end_date",
  termination_date: "end_date",

  monthly_rent: "monthly_rent",
  rent: "monthly_rent",
  base_rent: "monthly_rent",
  monthly_base_rent: "monthly_rent",
  minimum_rent: "monthly_rent",
  fixed_minimum_rent: "monthly_rent",
  rent_per_month: "monthly_rent",
  monthly_payment: "monthly_rent",

  annual_rent: "annual_rent",
  yearly_rent: "annual_rent",
  annual_base_rent: "annual_rent",
  base_annual_rent: "annual_rent",
  annual_minimum_rent: "annual_rent",
  rent_per_year: "annual_rent",
  base_rent_additional_year: "annual_rent",
  additional_year_base_rent: "annual_rent",

  rent_per_sf: "rent_per_sf",
  rent_per_square_foot: "rent_per_sf",
  rent_psf: "rent_per_sf",
  psf: "rent_per_sf",
  annual_psf: "rent_per_sf",

  square_footage: "square_footage",
  square_feet: "square_footage",
  sqft: "square_footage",
  sq_ft: "square_footage",
  sf: "square_footage",
  rsf: "square_footage",
  leased_area: "square_footage",
  rentable_area: "square_footage",
  rentable_square_feet: "square_footage",
  premises_rentable_square_feet: "square_footage",
  premises_area: "square_footage",

  lease_type: "lease_type",
  type_of_lease: "lease_type",
  lease_structure: "lease_type",
  rent_type: "lease_type",

  security_deposit: "security_deposit",
  deposit: "security_deposit",
  assignee_security_deposit_amount: "security_deposit",

  cam: "cam_amount",
  cam_amount: "cam_amount",
  cam_charges: "cam_amount",
  common_area_maintenance: "cam_amount",
  common_area_maintenance_amount: "cam_amount",

  escalation: "escalation_rate",
  escalation_rate: "escalation_rate",
  rent_increase: "escalation_rate",
  annual_increase: "escalation_rate",
  annual_escalation: "escalation_rate",
  rent_increase_percentage: "escalation_rate",

  renewal: "renewal_options",
  renewal_option: "renewal_options",
  renewal_options: "renewal_options",
  option_to_renew: "renewal_options",

  ti: "ti_allowance",
  ti_allowance: "ti_allowance",
  tenant_improvement: "ti_allowance",
  tenant_improvement_allowance: "ti_allowance",
  build_out_allowance: "ti_allowance",

  free_rent: "free_rent_months",
  free_rent_months: "free_rent_months",
  rent_abatement: "free_rent_months",

  lease_term: "lease_term_months",
  term: "lease_term_months",
  initial_term: "lease_term_months",
  lease_term_months: "lease_term_months",
  term_months: "lease_term_months",

  status: "status",
  lease_status: "status",

  assignor: "assignor_name",
  assignor_name: "assignor_name",
  original_tenant: "assignor_name",
  transferor: "assignor_name",

  assignee: "assignee_name",
  assignee_name: "assignee_name",
  new_tenant: "assignee_name",
  transferee: "assignee_name",

  assignment_date: "assignment_effective_date",
  date_of_assignment: "assignment_effective_date",
  assignment_effective_date: "assignment_effective_date",

  landlord_consent: "landlord_consent",
  landlord_approval: "landlord_consent",
  consent: "landlord_consent",

  assumption: "assumption_scope",
  assumption_scope: "assumption_scope",
  obligations_assumed: "assumption_scope",

  assignee_notice_address: "assignee_notice_address",
  assignee_address: "assignee_notice_address",
  notice_address: "assignee_notice_address",
  address_for_notices: "assignee_notice_address",
};

function coerceFieldValue(fieldName: string, raw: string, fieldDef: FieldDef): unknown {
  if (["tenant_name", "landlord_name", "assignor_name", "assignee_name"].includes(fieldName)) {
    raw = cleanPartyName(raw);
  }
  if (fieldName === "property_address") {
    raw = cleanPropertyAddress(raw);
  }
  if (fieldName === "property_name" && looksLikeAddressOrPremisesClause(raw)) {
    return null;
  }
  if (["tenant_name", "landlord_name", "assignor_name", "assignee_name"].includes(fieldName) && looksLikeClauseNotName(raw)) {
    return null;
  }
  if (fieldName === "property_address" && looksLikeNoticeClause(raw)) {
    return null;
  }
  if (fieldName === "monthly_rent" && /\b(?:annual|yearly|per\s+year|\/yr|annually)\b/i.test(String(raw))) {
    return null;
  }
  if (fieldName === "annual_rent" && /\b(?:monthly|per\s+month|\/mo)\b/i.test(String(raw))) {
    return null;
  }
  if (fieldName === "lease_term_months") {
    const inferred = inferTermMonths(raw);
    if (inferred != null) return inferred;
  }
  return coerceValue(raw, fieldDef);
}

function cleanPartyName(raw: unknown): string {
  let text = String(raw ?? "").trim();
  if (!text) return "";

  // Gemini/OCR can combine adjacent contact/address text into the tenant name.
  // Keep the legal entity portion and leave contact person/phone/address as
  // custom fields.
  text = text
    .replace(/\s+-\s+\d{3}[-.\s]\d{3}[-.\s]\d{4}.*$/i, "")
    .replace(/\s+\d{3}[-.\s]\d{3}[-.\s]\d{4}.*$/i, "")
    .replace(/\s+\d{3,6}\s+[A-Za-z0-9 .#-]+(?:Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b.*$/i, "")
    .replace(/\b(?:contact|phone|telephone|tel|address)\b\s*:.*$/i, "")
    .trim();

  const entityMatch = text.match(/^(.+?\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.))\b/i);
  if (entityMatch) return entityMatch[1].trim().replace(/[,\s]+$/, "");

  return text.replace(/[,\s]+$/, "");
}

function cleanPropertyAddress(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/^(?:of\s+)?(?:landlord|tenant|premises|property)\s*:?\s*/i, "")
    .replace(/^the\s+buildings?\s+of\s+which\s+the\s+premises\s+are\s+a\s+part\s+is\s+located\s+at\s+/i, "")
    .replace(/^located\s+at\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeAddressOrPremisesClause(raw: unknown): boolean {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  if (/\b(?:road|rd|street|st|avenue|ave|lane|ln|drive|dr|boulevard|blvd|suite|knoxville|tn|[A-Z]{2}\s+\d{5})\b/i.test(text)) {
    return true;
  }
  return /\b(?:premises|buildings?\s+of\s+which|located\s+at|part\s+is\s+located)\b/i.test(text);
}

function looksLikeClauseNotName(raw: unknown): boolean {
  const text = String(raw ?? "").trim();
  if (!text) return false;
  if (text.length > 90) return true;
  return /\b(hereby|effective as of|terms? and conditions|under the lease|transfers? and assigns?|assumes?|obligations?|contained in said lease)\b/i.test(text);
}

function looksLikeNoticeClause(raw: unknown): boolean {
  const text = String(raw ?? "").trim();
  return /\b(for\s+assignee|notice|notices|purposes\s+under\s+the\s+lease)\b/i.test(text);
}

function normalizedConfidence(value: unknown, fallback: number): number {
  const confidence = typeof value === "number" ? value : Number(value);
  return Number.isFinite(confidence) && confidence > 0 ? confidence : fallback;
}

function inferTermMonths(raw: unknown): number | null {
  const text = String(raw ?? "").toLowerCase().trim();
  if (!text) return null;
  if (/year\s*to\s*year|year-to-year|annual|one\s+year|1\s+year/.test(text)) return 12;
  const months = text.match(/(\d{1,3})\s*(?:months?|mos?\.?)/);
  if (months) return Number(months[1]);
  const years = text.match(/(\d{1,2})\s*(?:years?|yrs?\.?)/);
  if (years) return Number(years[1]) * 12;
  return null;
}

// ── Step 1a: Extract from Docling key-value fields ───────────────────────────

function extractFromDoclingFields(
  fields: DoclingField[],
  schema: ModuleSchema,
): Record<string, ExtractedField> {
  const result: Record<string, ExtractedField> = {};

  for (const docField of fields) {
    const directFieldName = CANONICAL_LEASE_FIELD_ALIASES[normalizeMatchKey(docField.key)];
    if (directFieldName && schema[directFieldName] && !schema[directFieldName].derived) {
      const value = coerceFieldValue(directFieldName, docField.value, schema[directFieldName]);
      if (value !== null && value !== undefined) {
        const existing = result[directFieldName];
        const newConf = normalizedConfidence(docField.confidence, 0.92);
        if (!existing || newConf > existing.confidence) {
          result[directFieldName] = {
            value,
            source: "rule",
            confidence: newConf,
            sourceText: `${docField.key}: ${docField.value}`,
          };
        }
      }
      continue;
    }

    // Find which schema field this Docling field maps to
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef.derived) continue;

      const isMatch = fieldDef.labels.some((label) =>
        fieldKeyMatchesLabel(docField.key, label, fieldName, fieldDef),
      );

      if (isMatch) {
        const value = coerceFieldValue(fieldName, docField.value, fieldDef);
        if (value !== null && value !== undefined) {
          // Only overwrite if higher confidence
          const existing = result[fieldName];
          const newConf = normalizedConfidence(docField.confidence, 0.90);
          if (!existing || newConf > existing.confidence) {
            result[fieldName] = {
              value,
              source: "rule",
              confidence: newConf,
              sourceText: `${docField.key}: ${docField.value}`,
            };
          }
        }
        break; // one Docling field → one schema field
      }
    }
  }

  return result;
}

function normalizeMatchKey(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[#%]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fieldKeyMatchesLabel(
  rawKey: string,
  rawLabel: string,
  fieldName: string,
  fieldDef: FieldDef,
): boolean {
  const key = normalizeMatchKey(rawKey);
  const label = normalizeMatchKey(rawLabel);
  if (!key || !label) return false;

  if (fieldDef.type === "date" && /_(day|month|year)$/.test(key)) {
    return false;
  }

  if (fieldName === "property_address" && /(rentable|square|sq_ft|feet|area|sf)/.test(key)) {
    return false;
  }

  if (fieldName === "monthly_rent" && /(annual|year|yearly|additional_year)/.test(key)) {
    return false;
  }

  if (fieldName === "ti_allowance" && !/(^|_)ti($|_)|tenant_improvement|allowance|build_out/.test(key)) {
    return false;
  }

  if (key === label) return true;
  if (key.startsWith(`${label}_`) || key.endsWith(`_${label}`)) return true;
  if (label.length >= 5 && key.includes(`_${label}_`)) return true;

  // Very short labels like "ti", "sf", or "cam" are too dangerous for
  // substring matching; "effective" contains "ti" and should never map to TI.
  return false;
}

// ── Step 1b: Extract via regex patterns from text ────────────────────────────

function extractViaPatterns(
  text: string,
  schema: ModuleSchema,
): Record<string, ExtractedField> {
  const result: Record<string, ExtractedField> = {};

  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (fieldDef.derived || result[fieldName]) continue;

    // Try explicit patterns first
    if (fieldDef.patterns) {
      for (const pattern of fieldDef.patterns) {
        const match = text.match(pattern);
        if (match) {
          const raw = match[1] ?? match[0];
          const value = coerceValue(raw, fieldDef);
          if (value !== null) {
            result[fieldName] = {
              value,
              source: "rule",
              confidence: 0.92,
              sourceText: match[0],
            };
            break;
          }
        }
      }
    }
  }

  return result;
}

// ── Step 1c: Extract via label-value matching ("Label: value") ───────────────

function extractViaLabels(
  text: string,
  schema: ModuleSchema,
): Record<string, ExtractedField> {
  const result: Record<string, ExtractedField> = {};
  const allLabels = Object.values(schema)
    .flatMap((fieldDef) => fieldDef.labels ?? [])
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const nextLabelLookahead = allLabels.length > 0
    ? `(?=\\s+(?:${allLabels.join("|")})\\s*(?::|-|\\t| {2,})|\\n|$)`
    : "(?=\\n|$)";

  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (fieldDef.derived || result[fieldName]) continue;
    if (fieldDef.labels.length === 0) continue;

    const labelsBySpecificity = [...fieldDef.labels].sort((a, b) => b.length - a.length);
    for (const label of labelsBySpecificity) {
      // Match "Label: value", "Label - value", or table-like "Label  value".
      // Do not treat normal prose like "Landlord and Tenant..." as a field.
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(
        `\\b${escaped}\\b\\s*(?::|-|\\t| {2,})\\s*([^\\n]{1,200}?)${nextLabelLookahead}`,
        "i",
      );
      const match = text.match(re);

      if (match) {
        const rawValue = match[1].trim().replace(/[,;.]$/, "");
        const value = coerceValue(rawValue, fieldDef);
        if (value !== null) {
          result[fieldName] = {
            value,
            source: "rule",
            confidence: 0.88,
            sourceText: match[0].trim(),
          };
          break;
        }
      }
    }
  }

  return result;
}

// ── Step 1d: Lease-type inference from document content ──────────────────────

function inferLeaseType(text: string): ExtractedField | null {
  if (/triple[\s-]net|nnn\s+lease/i.test(text)) {
    return { value: "nnn", source: "rule", confidence: 0.90, sourceText: "document mentions triple net / NNN" };
  }
  if (/gross\s+lease|full[\s-]service/i.test(text)) {
    return { value: "gross", source: "rule", confidence: 0.90, sourceText: "document mentions gross / full-service" };
  }
  if (/modified[\s-]gross/i.test(text)) {
    return { value: "modified_gross", source: "rule", confidence: 0.90, sourceText: "document mentions modified gross" };
  }
  if (/double[\s-]net|\bnn\b\s+lease/i.test(text)) {
    return { value: "nn", source: "rule", confidence: 0.85, sourceText: "document mentions double net / NN" };
  }
  if (/tenant\s+shall\s+pay.*taxes.*insurance.*maintenance/i.test(text)) {
    return { value: "nnn", source: "rule", confidence: 0.75, sourceText: "inferred NNN from tenant expense responsibility clause" };
  }
  if (/landlord\s+shall\s+be\s+responsible\s+for\s+all\s+operating/i.test(text)) {
    return { value: "gross", source: "rule", confidence: 0.75, sourceText: "inferred gross from landlord expense responsibility clause" };
  }
  return null;
}

// ── Main: Rule-based extraction ──────────────────────────────────────────────

/**
 * Step 1 of the extraction pipeline.
 *
 * Extracts fields using deterministic patterns — no AI involved.
 * Produces a single record (for single-document extraction like lease abstracts)
 * or no records if nothing matched.
 */
export function extractRuleBased(
  docling: DoclingOutput,
  moduleType: ModuleType,
): StepResult {
  const schema = getSchema(moduleType);
  const warnings: string[] = [];
  const fullText = docling.full_text ?? docling.text_blocks.map((b) => b.text).join("\n");

  if (fullText.length < 10) {
    return { records: [], warnings: ["Text too short for rule-based extraction"] };
  }

  // Run all three sub-steps
  const fromFields = extractFromDoclingFields(docling.fields ?? [], schema);
  const fromPatterns = extractViaPatterns(fullText, schema);
  const fromLabels = extractViaLabels(fullText, schema);

  // Merge: Docling fields > patterns > labels (by confidence)
  const merged: Record<string, ExtractedField> = {};

  for (const source of [fromLabels, fromPatterns, fromFields]) {
    for (const [key, field] of Object.entries(source)) {
      if (!merged[key] || field.confidence > merged[key].confidence) {
        merged[key] = field;
      }
    }
  }

  // Special lease-type inference
  if ((moduleType === "lease" || moduleType === "leases") && !merged.lease_type) {
    const inferred = inferLeaseType(fullText);
    if (inferred) merged.lease_type = inferred;
  }

  // Only create a record if we found meaningful data
  const fieldCount = Object.keys(merged).length;
  if (fieldCount === 0) {
    warnings.push("Rule-based extraction found no matching fields");
    return { records: [], warnings };
  }

  const record: ExtractedRecord = { fields: merged, rowIndex: 0 };
  return { records: [record], warnings };
}

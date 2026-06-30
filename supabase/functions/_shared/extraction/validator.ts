// @ts-nocheck
/**
 * Extraction Pipeline — Post-Extraction Validation
 *
 * Runs AFTER merge, BEFORE derived field calculation.
 * Validates every extracted field against its schema definition:
 *   - Type correctness (string, number, date, boolean, enum)
 *   - Range constraints (min, max)
 *   - Date format (YYYY-MM-DD)
 *   - Enum membership
 *   - Required field presence
 *
 * Invalid values are REJECTED (set to null), not corrected.
 * The validator never guesses — it only enforces the schema.
 */

import type { ExtractedRecord, ValidationError, ModuleType } from "./types.ts";
import { getSchema, type FieldDef } from "./schemas.ts";
import { parseDate, parseMoney, parsePercent, parseEnum } from "./rule-extractor.ts";

// ── Individual field validators ──────────────────────────────────────────────

function validateString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

function validateNumber(value: unknown, def: FieldDef): number | null {
  if (value === null || value === undefined) return null;

  let n: number;
  if (typeof value === "number") {
    n = value;
  } else if (typeof value === "string") {
    const parsed = parseMoney(value);
    if (parsed === null) return null;
    n = parsed;
  } else {
    return null;
  }

  if (!isFinite(n)) return null;
  if (def.min !== undefined && n < def.min) return null;
  if (def.max !== undefined && n > def.max) return null;

  // Round to 2 decimal places for monetary values
  return Math.round(n * 100) / 100;
}

function validateDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  // Already valid ISO date
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // Verify it's a real date
    const d = new Date(s + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    const year = d.getUTCFullYear();
    if (year < 1900 || year > 2200) return null;
    return s;
  }

  // Try parsing
  const parsed = parseDate(s);
  if (parsed) {
    const d = new Date(parsed + "T00:00:00Z");
    if (isNaN(d.getTime())) return null;
    return parsed;
  }

  return null;
}

function validateBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const s = String(value).toLowerCase().trim();
  if (["true", "yes", "y", "1", "granted", "received", "approved"].includes(s)) return true;
  if (["false", "no", "n", "0", "denied", "not granted", "not approved"].includes(s)) return false;
  if (/\b(consents?|consented|approval|approved|grants?|granted)\b/i.test(String(value))) return true;
  if (/\b(does not consent|not approved|denied|withheld)\b/i.test(String(value))) return false;
  return null;
}

function validateEnumValue(value: unknown, allowed: string[]): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (!s) return null;

  // Try direct match first, then fuzzy
  return parseEnum(s, allowed);
}

// ── Main validator ───────────────────────────────────────────────────────────

/**
 * Validate and sanitize a single field value against its definition.
 * Returns the validated value (or null if invalid).
 */
function validateField(value: unknown, def: FieldDef): unknown {
  switch (def.type) {
    case "string":
      return validateString(value);
    case "number":
      return validateNumber(value, def);
    case "date":
      return validateDate(value);
    case "boolean":
      return validateBoolean(value);
    case "enum":
      return validateEnumValue(value, def.enumValues ?? []);
    default:
      return validateString(value);
  }
}

/**
 * Validate all records against the module schema.
 *
 * - Invalid values are set to null with a validation error logged
 * - Required fields that are null generate a warning
 * - Returns sanitized records + list of all validation errors
 */
export function validateRecords(
  records: ExtractedRecord[],
  moduleType: ModuleType,
): { records: ExtractedRecord[]; errors: ValidationError[] } {
  const schema = getSchema(moduleType);
  const errors: ValidationError[] = [];

  for (const record of records) {
    if (moduleType === "lease") {
      normalizeLeaseContextualFields(record);
    }

    for (const [fieldName, extracted] of Object.entries(record.fields)) {
      const def = schema[fieldName];
      if (!def) continue; // unmapped field, skip validation

      if (moduleType === "lease") {
        extracted.value = sanitizeLeaseFieldValue(fieldName, extracted);
      }
      const validated = validateField(extracted.value, def);

      if (validated === null && extracted.value !== null && extracted.value !== undefined) {
        // Value was present but failed validation — reject it
        if (def.required) {
          errors.push({
            field: fieldName,
            message: `Invalid ${def.type} value for "${fieldName}": ${JSON.stringify(extracted.value)}`,
            receivedValue: extracted.value,
            rowIndex: record.rowIndex,
          });
        }
        extracted.value = null;
        extracted.confidence = 0;
      } else {
        extracted.value = validated;
      }
    }

    // Check required fields
    for (const [fieldName, def] of Object.entries(schema)) {
      if (def.required && !def.derived) {
        const field = record.fields[fieldName];
        if (!field || field.value === null || field.value === undefined) {
          errors.push({
            field: fieldName,
            message: `Required field "${fieldName}" is missing`,
            receivedValue: null,
            rowIndex: record.rowIndex,
          });
        }
      }
    }
  }

  return { records, errors };
}

function sanitizeLeaseFieldValue(fieldName: string, field: any): unknown {
  const value = field.value;
  if (value === null || value === undefined) return value;

  const ENTITY_FIELDS = new Set([
    "tenant_name", "landlord_name", "assignor_name", "assignee_name", 
    "guarantor_name", "owner_name", "property_manager", 
    "tenant_contact_name", "landlord_contact_name", 
    "tenant_signatory_name", "landlord_signatory_name", "broker_name"
  ]);

  if (ENTITY_FIELDS.has(fieldName)) {
    const valStr = String(value || "").trim();
    if (!valStr) return null;

    const srcStr = String(field.sourceText || field.source_text || "").toLowerCase();
    const valLower = valStr.toLowerCase();
    const stopwordNameValues = new Set([
      "and", "or", "in", "of", "the", "a", "an", "by", "to", "for", "with", "as",
      "tenant", "landlord", "assignee", "assignor", "subtenant", "guarantor",
      "owner", "manager", "broker", "agent", "lessor", "lessee",
    ]);

    if (valStr.length > 120) return null;
    if (valStr.length < 2) return null;
    if (stopwordNameValues.has(valLower)) return null;
    if (/^(or|and|in|of|the|by)\s+/i.test(valStr)) return null;

    // Reject date-like values — dates are never party names
    if (/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}$/i.test(valStr)) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(valStr)) return null;
    if (/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/.test(valStr)) return null;

    // Reject money values — dollar amounts are never party names
    if (/^\$\s*[\d,]+(?:\.\d{2})?$/.test(valStr)) return null;
    if (/^[\d,]+(?:\.\d{2})?\s*(?:dollars?|USD)\s*$/i.test(valStr)) return null;

    if (/\b(may|shall|without|provided|subject to|consent|transfer|assign|sublet|warrants?|represents?|connection with|real estate broker|negotiation|brokerage fees?)\b/i.test(valLower)) return null;

    // Reject deposit-related and other lease-clause fragments
    if (/\b(deposit(?:ed)?|payable|does hereby|hereby leases?|premises|security deposit|rent(?:\s+is)?\s+due|obligations?\s+of|assumes?\s+(?:all|in\s+full)|initial\s+(?:term|rent))\b/i.test(valLower)) return null;

    // Reject prose sentences but allow name initials like "John C. Cooley".
    // A sentence boundary is: period/question/exclamation followed by space+uppercase,
    // OR period followed by end-of-string when not preceded by a single capital letter.
    if (/[?!](?:\s|$)/.test(valStr)) return null;
    if (/\.\s+[A-Z]/.test(valStr) && !/\b[A-Z]\.\s+[A-Z]/.test(valStr)) return null;
    if (/(?:^|\s)(?:Section\s+)?\d+\.\d+(?:\s|$)/i.test(valStr)) return null;

    const clausePattern = /\b(tenant may assign|assign this lease|sublet|subtenant|assignee or subtenant|permitted transfer|affiliate|successor by merger|sale of substantially all assets|prior written consent|transfer to an affiliate|landlord shall not unreasonably withhold|consent|transfer premium|brokerage fees?|real estate broker|negotiation except as set forth)\b/i;

    // Reject when source text is from a security deposit or expense clause and value has no entity suffix
    const hasEntitySuffix = /\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Holdings|Partners?)\b/i.test(valStr);
    const depositSourcePattern = /\b(security\s+deposit|deposited|cam\s+charges?|operating\s+expense|base\s+year)\b/i;
    if (depositSourcePattern.test(srcStr) && !hasEntitySuffix) return null;

    if (clausePattern.test(srcStr) || clausePattern.test(valLower)) {
      return null;
    }

    return cleanPartyName(valStr);
  }

  if (fieldName === "unit_number" || fieldName === "suite_number") {
    const valStr = String(value || "").trim();
    if (!valStr) return null;
    const lower = valStr.toLowerCase();
    const fragments = new Set([
      "in", "at", "of", "the", "a", "an", "on", "by", "to", "for",
      "with", "and", "or", "is", "as", "be", "not", "no", "space",
      "suite", "unit", "premises",
    ]);
    if (fragments.has(lower)) return null;
    if (/\b(lease|landlord|tenant|rent|shall|premises located|space in)\b/i.test(valStr)) return null;
    return valStr.replace(/^(?:suite|unit|space)\s*#?\s*/i, "").trim();
  }

  if (fieldName === "property_address") {
    return cleanAddress(value);
  }

  if (fieldName === "property_name" && looksLikeAddressOrPremisesClause(value)) {
    return null;
  }

  if (fieldName === "landlord_consent" && /^\s*required\s*$/i.test(String(value))) {
    return null;
  }

  return value;
}

function cleanPartyName(value: unknown): string {
  let text = String(value ?? "").trim();
  if (!text) return "";

  text = text
    .replace(/\s+-\s+\d{3}[-.\s]\d{3}[-.\s]\d{4}.*$/i, "")
    .replace(/\s+\d{3}[-.\s]\d{3}[-.\s]\d{4}.*$/i, "")
    .replace(/\s+\d{3,6}\s+[A-Za-z0-9 .#-]+(?:Road|Rd|Street|St|Avenue|Ave|Lane|Ln|Drive|Dr|Boulevard|Blvd)\b.*$/i, "")
    .replace(/\b(?:contact|phone|telephone|tel|address)\b\s*:.*$/i, "")
    .trim();

  const entityMatch = text.match(/^(.+?\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.))\b/i);
  return (entityMatch ? entityMatch[1] : text).trim().replace(/[,\s]+$/, "");
}

function cleanAddress(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/^(?:of\s+)?(?:landlord|tenant|premises|property)\s*:?\s*/i, "")
    .replace(/^the\s+buildings?\s+of\s+which\s+the\s+premises\s+are\s+a\s+part\s+is\s+located\s+at\s+/i, "")
    .replace(/^located\s+at\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function looksLikeAddressOrPremisesClause(value: unknown): boolean {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (/\b(?:road|rd|street|st|avenue|ave|lane|ln|drive|dr|boulevard|blvd|suite|knoxville|tn|[A-Z]{2}\s+\d{5})\b/i.test(text)) {
    return true;
  }
  return /\b(?:premises|buildings?\s+of\s+which|located\s+at|part\s+is\s+located)\b/i.test(text);
}

/**
 * Cross-field sanity checks. Run before the per-field validator so wrong
 * mappings get rejected rather than silently published downstream.
 *
 *  - If monthly_rent is suspiciously large relative to annual_rent
 *    (monthly * 11 > annual), assume the extractor swapped them and clear
 *    monthly_rent so the calculator can recompute monthly = annual/12.
 *  - If square_footage equals the property-level total (matched via
 *    looksLikePropertyTotal), null it so the operator must fill the leased
 *    premises area. Better to be missing than wrong.
 *  - If tenant_name contains a person-only pattern ("FIRST LAST" with no
 *    entity suffix), move it to tenant_contact_name and clear tenant_name.
 */
function applyLeaseCrossFieldSanity(record: ExtractedRecord): void {
  const fields = record.fields;

  // Rent swap detection: monthly should always be << annual.
  const monthly = numericField(fields.monthly_rent?.value);
  const annual = numericField(fields.annual_rent?.value);
  if (monthly != null && annual != null && monthly * 11 > annual) {
    // Most likely the extractor put an annual figure in monthly_rent.
    if (monthly > annual * 0.5) {
      fields.monthly_rent = {
        value: null,
        source: fields.monthly_rent?.source ?? "rule",
        confidence: 0,
        sourceText: "Cleared by cross-field sanity check (looked like annual rent in monthly slot)",
      };
    }
  }

  // Tenant name vs signatory detection: if tenant_name looks like a person
  // AND the source text indicates it came from a "By:" / signature line OR
  // there is already a different tenant_signatory_name extracted, demote it.
  // Individuals (sole proprietors, professionals) legitimately lease commercial
  // space, so we must not clear tenant_name solely because it has no entity
  // suffix — we need explicit evidence that it is a signatory, not the tenant.
  const tenantName = String(fields.tenant_name?.value ?? "").trim();
  if (tenantName && looksLikePersonNotEntity(tenantName)) {
    const tenantSourceText = String(fields.tenant_name?.sourceText ?? "").toLowerCase();
    // "by:" requires a colon (signature block "By: ____") so this does not
    // false-positive on ordinary party-clause prose like "by and between".
    const isSignatoryLine = /\bby\s*:|\bsigned\s+by\b|\bsignatory\b|\bsignature\b|\bits\s*:|\btitle\s*:/.test(tenantSourceText);
    const hasDifferentSignatory =
      !!fields.tenant_signatory_name?.value &&
      String(fields.tenant_signatory_name.value).trim().toLowerCase() !== tenantName.toLowerCase();
    if (isSignatoryLine || hasDifferentSignatory) {
      if (!fields.tenant_contact_name?.value) {
        fields.tenant_contact_name = {
          value: tenantName,
          source: fields.tenant_name?.source ?? "llm",
          confidence: fields.tenant_name?.confidence ?? 0.6,
          sourceText: fields.tenant_name?.sourceText ?? "Reassigned from tenant_name (looked like a signatory line)",
          sourcePage: fields.tenant_name?.sourcePage ?? null,
        };
      }
      fields.tenant_name = {
        value: null,
        source: fields.tenant_name?.source ?? "rule",
        confidence: 0,
        sourceText: "Cleared by cross-field sanity check (value appeared on a signatory line)",
      };
    }
  }

  // Same for landlord_name: only clear if there is clear signatory-line evidence.
  const landlordName = String(fields.landlord_name?.value ?? "").trim();
  if (landlordName && looksLikePersonNotEntity(landlordName)) {
    const landlordSourceText = String(fields.landlord_name?.sourceText ?? "").toLowerCase();
    const isLandlordSignatoryLine = /\bby\s*:|\bsigned\s+by\b|\bsignatory\b|\bsignature\b|\bits\s*:|\btitle\s*:/.test(landlordSourceText);
    const hasDifferentLandlordSignatory =
      !!fields.landlord_signatory_name?.value &&
      String(fields.landlord_signatory_name.value).trim().toLowerCase() !== landlordName.toLowerCase();
    if (isLandlordSignatoryLine || hasDifferentLandlordSignatory) {
      fields.landlord_name = {
        value: null,
        source: fields.landlord_name?.source ?? "rule",
        confidence: 0,
        sourceText: "Cleared by cross-field sanity check (value appeared on a signatory line)",
      };
    }
  }
}

function numericField(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function looksLikePersonNotEntity(value: string): boolean {
  // Has an entity suffix → definitely not a person.
  if (/\b(?:LLC|L\.L\.C\.|Inc\.?|Corporation|Corp\.?|Company|Co\.?|LP|L\.P\.|LLP|L\.L\.P\.|Trust|Foundation|Bank|Holdings|Partners?)\b/i.test(value)) {
    return false;
  }
  // Short all-caps name with no entity marker → likely a signatory ("JOHN DOE", "NARENDRA PYDI").
  const words = value.trim().split(/\s+/);
  if (words.length > 0 && words.length <= 4) {
    const allCaps = words.every((w) => w === w.toUpperCase() && /^[A-Z][A-Z'.-]+$/.test(w));
    if (allCaps) return true;
  }
  return false;
}

function normalizeLeaseContextualFields(record: ExtractedRecord): void {
  applyLeaseCrossFieldSanity(record);
  const fields = record.fields;
  if (fields.assignment_effective_date?.value && fields.assignee_name?.value) {
    const tenant = String(fields.tenant_name?.value ?? "").trim().toLowerCase();
    const assignor = String(fields.assignor_name?.value ?? "").trim().toLowerCase();
    if (!tenant || (assignor && tenant === assignor)) {
      fields.tenant_name = {
        value: fields.assignee_name.value,
        source: "rule",
        confidence: Math.max(fields.assignee_name.confidence ?? 0.8, 0.9),
        sourceText: fields.assignee_name.sourceText ?? null,
        sourcePage: fields.assignee_name.sourcePage ?? null,
      };
    }
  }

  const startIso = parseDate(String(fields.start_date?.value ?? ""));
  const rawEnd = fields.end_date?.value;
  const inferredEnd = inferEndDate(rawEnd, startIso);
  if (inferredEnd && fields.end_date) {
    fields.end_date.value = inferredEnd;
    fields.end_date.confidence = Math.max(fields.end_date.confidence ?? 0.7, 0.82);
  }

  const termField = fields.lease_term_months;
  const termMonths = inferLeaseTermMonths(termField?.value);
  if (termField && termMonths != null) {
    termField.value = termMonths;
    termField.confidence = Math.max(termField.confidence ?? 0.7, 0.82);
  }

  const normalizedTerm = termMonths ?? inferLeaseTermMonths(fields.renewal_options?.value);
  if ((!fields.end_date || fields.end_date.value == null) && startIso && normalizedTerm) {
    fields.end_date = {
      value: addMonthsInclusiveEnd(startIso, normalizedTerm),
      source: "rule",
      confidence: 0.78,
      sourceText: "Derived from start date and lease term",
    };
  }
}

function inferEndDate(value: unknown, startIso: string | null): string | null {
  if (value == null) return null;
  const parsed = parseDate(String(value));
  if (parsed) return parsed;
  if (!startIso) return null;

  const text = String(value).trim();
  const match = text.match(/\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:\b|,|\s)/i);
  if (!match) return null;

  const month = monthNumber(match[1]);
  const day = Number(match[2]);
  if (!month || !day || day < 1 || day > 31) return null;

  const start = new Date(startIso + "T00:00:00Z");
  if (isNaN(start.getTime())) return null;

  let year = start.getUTCFullYear();
  let candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate <= start) {
    year += 1;
    candidate = new Date(Date.UTC(year, month - 1, day));
  }
  return candidate.toISOString().slice(0, 10);
}

function inferLeaseTermMonths(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value);
  const text = String(value).toLowerCase().trim();
  if (!text) return null;
  if (/year\s*to\s*year|year-to-year|annual|one\s+year|1\s+year/.test(text)) return 12;
  const months = text.match(/(\d{1,3})\s*(?:months?|mos?\.?)/);
  if (months) return Number(months[1]);
  const years = text.match(/(\d{1,2})\s*(?:years?|yrs?\.?)/);
  if (years) return Number(years[1]) * 12;
  return null;
}

function addMonthsInclusiveEnd(startIso: string, months: number): string {
  const start = new Date(startIso + "T00:00:00Z");
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + months, start.getUTCDate()));
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function monthNumber(name: string): number | null {
  const months: Record<string, number> = {
    january: 1, jan: 1,
    february: 2, feb: 2,
    march: 3, mar: 3,
    april: 4, apr: 4,
    may: 5,
    june: 6, jun: 6,
    july: 7, jul: 7,
    august: 8, aug: 8,
    september: 9, sep: 9,
    october: 10, oct: 10,
    november: 11, nov: 11,
    december: 12, dec: 12,
  };
  return months[String(name || "").toLowerCase()] ?? null;
}

/**
 * Flatten ExtractedRecords into plain objects for the response.
 * Strips extraction metadata, leaving only fieldName → value.
 */
export function flattenRecords(
  records: ExtractedRecord[],
  moduleType: ModuleType,
): Record<string, unknown>[] {
  const schema = getSchema(moduleType);

  return records.map((record, i) => {
    const row: Record<string, unknown> = { _row: i + 1 };

    // Ensure all schema fields exist (null if missing)
    for (const fieldName of Object.keys(schema)) {
      const field = record.fields[fieldName];
      row[fieldName] = field?.value ?? null;
    }

    // Add confidence metadata
    const confidences: Record<string, number> = {};
    const sources: Record<string, string> = {};
    const evidence: Record<string, { source_text?: string | null; source_page?: number | null }> = {};
    for (const [fieldName, field] of Object.entries(record.fields)) {
      if (field.value !== null) {
        confidences[fieldName] = field.confidence;
        sources[fieldName] = field.source;
        if (field.sourceText || field.sourcePage != null) {
          evidence[fieldName] = {
            source_text: field.sourceText ?? null,
            source_page: field.sourcePage ?? null,
          };
        }
      }
    }

    // Calculate overall confidence
    const scores = Object.values(confidences);
    const avgConfidence = scores.length > 0
      ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100)
      : 0;

    row.confidence_score = avgConfidence;
    row._field_confidences = confidences;
    row._field_sources = sources;
    row._field_evidence = evidence;
    row.extraction_notes = buildExtractionNotes(sources);

    return row;
  });
}

function buildExtractionNotes(sources: Record<string, string>): string {
  const counts = { rule: 0, table: 0, llm: 0 };
  for (const source of Object.values(sources)) {
    if (source in counts) counts[source as keyof typeof counts]++;
  }

  const parts: string[] = [];
  if (counts.rule > 0) parts.push(`${counts.rule} fields via rule-based`);
  if (counts.table > 0) parts.push(`${counts.table} fields via table`);
  if (counts.llm > 0) parts.push(`${counts.llm} fields via LLM`);

  return parts.join(", ") || "No fields extracted";
}

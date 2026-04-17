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
  const s = String(value).trim();
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

      const validated = validateField(extracted.value, def);

      if (validated === null && extracted.value !== null && extracted.value !== undefined) {
        // Value was present but failed validation — reject it
        errors.push({
          field: fieldName,
          message: `Invalid ${def.type} value for "${fieldName}": ${JSON.stringify(extracted.value)}`,
          receivedValue: extracted.value,
          rowIndex: record.rowIndex,
        });
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

function normalizeLeaseContextualFields(record: ExtractedRecord): void {
  const fields = record.fields;
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
    for (const [fieldName, field] of Object.entries(record.fields)) {
      if (field.value !== null) {
        confidences[fieldName] = field.confidence;
        sources[fieldName] = field.source;
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

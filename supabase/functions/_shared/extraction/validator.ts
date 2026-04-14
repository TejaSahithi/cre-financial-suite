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
    if (year < 1900 || year > 2100) return null;
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
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
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

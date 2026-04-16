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
    case "date":
      return parseDate(trimmed);
    case "boolean": {
      const b = trimmed.toLowerCase();
      if (["true", "yes", "y", "1"].includes(b)) return true;
      if (["false", "no", "n", "0"].includes(b)) return false;
      return null;
    }
    case "enum":
      return parseEnum(trimmed, fieldDef.enumValues ?? []);
    default:
      return trimmed;
  }
}

// ── Step 1a: Extract from Docling key-value fields ───────────────────────────

function extractFromDoclingFields(
  fields: DoclingField[],
  schema: ModuleSchema,
): Record<string, ExtractedField> {
  const result: Record<string, ExtractedField> = {};

  for (const docField of fields) {
    const keyLower = docField.key.toLowerCase().trim();

    // Find which schema field this Docling field maps to
    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef.derived) continue;

      const isMatch = fieldDef.labels.some(
        (label) => keyLower === label || keyLower.includes(label) || label.includes(keyLower),
      );

      if (isMatch) {
        const value = coerceValue(docField.value, fieldDef);
        if (value !== null && value !== undefined) {
          // Only overwrite if higher confidence
          const existing = result[fieldName];
          const newConf = docField.confidence ?? 0.90;
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

  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    if (fieldDef.derived || result[fieldName]) continue;
    if (fieldDef.labels.length === 0) continue;

    for (const label of fieldDef.labels) {
      // Match "Label: value" or "Label  value" on the same line
      const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`${escaped}[:\\s]\\s*([^\\n]{1,200})`, "i");
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

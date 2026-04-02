// @ts-nocheck
/**
 * Unified Normalization Layer
 *
 * Converts extracted data from ANY source (CSV rows, Docling PDF output,
 * plain-text key-value pairs) into the canonical row format expected by
 * the existing module parsers (parseLeases, parseExpenses, etc.).
 *
 * The normalizer does NOT validate — it only reshapes data into the
 * standard column-name format so the existing parsers can handle it.
 *
 * After normalization the rows are passed to:
 *   parseLeases / parseExpenses / parseProperties / parseRevenues
 * which apply type coercion, date normalization, and currency stripping.
 * Then validate-data → store-data → compute engines run unchanged.
 */

import type { ModuleType } from "./file-detector.ts";

// ---------------------------------------------------------------------------
// Docling output types (mirrors parse-pdf-docling)
// ---------------------------------------------------------------------------

interface DoclingField {
  key: string;
  value: string;
  confidence?: number;
  page?: number;
}

interface DoclingTable {
  table_index: number;
  headers: string[];
  rows: string[][];
  markdown?: string;
}

interface DoclingTextBlock {
  block_index: number;
  type: string;
  text: string;
  page?: number;
}

interface DoclingOutput {
  text_blocks?: DoclingTextBlock[];
  tables?: DoclingTable[];
  fields?: DoclingField[];
  full_text?: string;
  page_count?: number;
  model_version?: string;
  raw_response?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Canonical row type — what the module parsers expect
// ---------------------------------------------------------------------------

export type CanonicalRow = Record<string, string | null>;

// ---------------------------------------------------------------------------
// Field alias maps per module
// Docling may return keys like "tenant name", "monthly rent", etc.
// We map them to the exact column names the parsers recognise.
// ---------------------------------------------------------------------------

const LEASE_FIELD_ALIASES: Record<string, string> = {
  // tenant
  "tenant": "tenant_name",
  "tenant name": "tenant_name",
  "lessee": "tenant_name",
  "lessee name": "tenant_name",
  // dates
  "start": "start_date",
  "lease start": "start_date",
  "commencement": "start_date",
  "commencement date": "start_date",
  "end": "end_date",
  "lease end": "end_date",
  "expiration": "end_date",
  "expiration date": "end_date",
  "term end": "end_date",
  // rent
  "rent": "monthly_rent",
  "base rent": "monthly_rent",
  "monthly base rent": "monthly_rent",
  "monthly rent": "monthly_rent",
  // area
  "area": "square_footage",
  "sqft": "square_footage",
  "sq ft": "square_footage",
  "rentable sf": "square_footage",
  "rentable square footage": "square_footage",
  // escalation
  "escalation": "escalation_rate",
  "annual escalation": "escalation_rate",
  "escalation rate": "escalation_rate",
  "escalation pct": "escalation_rate",
  "escalation type": "escalation_type",
  // lease type
  "type": "lease_type",
  "lease type": "lease_type",
};

const EXPENSE_FIELD_ALIASES: Record<string, string> = {
  "expense category": "category",
  "expense type": "category",
  "type": "category",
  "expense amount": "amount",
  "cost": "amount",
  "total": "amount",
  "expense date": "date",
  "transaction date": "date",
  "vendor name": "vendor",
  "supplier": "vendor",
  "payee": "vendor",
  "gl code": "gl_code",
  "account code": "gl_code",
  "fiscal year": "fiscal_year",
  "year": "fiscal_year",
  "property name": "property_id",
  "property": "property_id",
  "expense classification": "classification",
  "recovery type": "classification",
};

const PROPERTY_FIELD_ALIASES: Record<string, string> = {
  "property name": "name",
  "property": "name",
  "building name": "name",
  "street address": "address",
  "street": "address",
  "location": "address",
  "municipality": "city",
  "town": "city",
  "province": "state",
  "region": "state",
  "zip": "zip_code",
  "postal code": "zip_code",
  "zipcode": "zip_code",
  "sqft": "square_footage",
  "sq ft": "square_footage",
  "area": "square_footage",
  "total area": "square_footage",
  "asset type": "property_type",
  "type": "property_type",
  "year built": "year_built",
  "construction year": "year_built",
  "unit count": "number_of_units",
  "total units": "number_of_units",
};

const REVENUE_FIELD_ALIASES: Record<string, string> = {
  "income type": "revenue_type",
  "type": "revenue_type",
  "category": "revenue_type",
  "revenue amount": "amount",
  "income": "amount",
  "total": "amount",
  "revenue date": "period",
  "transaction date": "period",
  "date": "period",
  "property name": "property_id",
  "property": "property_id",
  "fiscal year": "fiscal_year",
  "year": "fiscal_year",
  "description": "notes",
  "memo": "notes",
};

const MODULE_ALIASES: Record<ModuleType, Record<string, string>> = {
  leases: LEASE_FIELD_ALIASES,
  expenses: EXPENSE_FIELD_ALIASES,
  properties: PROPERTY_FIELD_ALIASES,
  revenue: REVENUE_FIELD_ALIASES,
  cam: EXPENSE_FIELD_ALIASES,     // CAM uses expense-like structure
  budgets: REVENUE_FIELD_ALIASES, // Budget uses revenue-like structure
  unknown: {},
};

// ---------------------------------------------------------------------------
// Alias resolution helper
// ---------------------------------------------------------------------------

function resolveAlias(key: string, aliases: Record<string, string>): string {
  const lower = key.toLowerCase().trim();
  return aliases[lower] ?? lower;
}

// ---------------------------------------------------------------------------
// 1. Normalize Docling fields array → canonical rows
// ---------------------------------------------------------------------------

/**
 * Converts Docling's key-value fields into a single canonical row.
 * Multiple fields from the same document become one row.
 */
function normalizeDoclingFields(
  fields: DoclingField[],
  moduleType: ModuleType,
): CanonicalRow[] {
  if (!fields || fields.length === 0) return [];

  const aliases = MODULE_ALIASES[moduleType] ?? {};
  const row: CanonicalRow = {};

  for (const field of fields) {
    const canonicalKey = resolveAlias(field.key, aliases);
    const value = field.value?.trim() || null;
    // Higher confidence wins if the same key appears multiple times
    if (!(canonicalKey in row) || (field.confidence ?? 0) > 0.5) {
      row[canonicalKey] = value;
    }
  }

  return Object.keys(row).length > 0 ? [row] : [];
}

// ---------------------------------------------------------------------------
// 2. Normalize Docling tables → canonical rows
// ---------------------------------------------------------------------------

/**
 * Converts Docling table rows into canonical rows.
 * Each table row becomes one canonical row.
 * Handles two table shapes:
 *   a) "Field | Value" (2-column key-value table) → single row
 *   b) Multi-column data table → one row per data row
 */
function normalizeDoclingTable(
  table: DoclingTable,
  moduleType: ModuleType,
): CanonicalRow[] {
  const aliases = MODULE_ALIASES[moduleType] ?? {};
  const { headers, rows } = table;

  if (!rows || rows.length === 0) return [];

  // Shape (a): 2-column "Field | Value" table
  if (
    headers.length === 2 &&
    (headers[0].toLowerCase().includes("field") ||
      headers[0].toLowerCase().includes("key") ||
      headers[0].toLowerCase().includes("name"))
  ) {
    const row: CanonicalRow = {};
    for (const dataRow of rows) {
      if (dataRow.length >= 2) {
        const key = resolveAlias(dataRow[0], aliases);
        row[key] = dataRow[1]?.trim() || null;
      }
    }
    return Object.keys(row).length > 0 ? [row] : [];
  }

  // Shape (b): standard data table — one row per data row
  const canonicalHeaders = headers.map(h => resolveAlias(h, aliases));
  return rows.map(dataRow => {
    const row: CanonicalRow = {};
    canonicalHeaders.forEach((header, i) => {
      row[header] = dataRow[i]?.trim() || null;
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// 3. Normalize plain text (key: value lines) → canonical rows
// ---------------------------------------------------------------------------

/**
 * Parses plain text with "Key: Value" or "Key = Value" patterns.
 * Used as a fallback for semi-structured text files.
 */
function normalizeTextContent(
  text: string,
  moduleType: ModuleType,
): CanonicalRow[] {
  if (!text?.trim()) return [];

  const aliases = MODULE_ALIASES[moduleType] ?? {};
  const row: CanonicalRow = {};

  // Match "Key: Value" or "Key = Value" patterns
  const linePattern = /^([^:=\n]{2,40})\s*[:=]\s*(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(text)) !== null) {
    const key = resolveAlias(match[1].trim(), aliases);
    const value = match[2].trim() || null;
    if (key && value) {
      row[key] = value;
    }
  }

  return Object.keys(row).length > 0 ? [row] : [];
}

// ---------------------------------------------------------------------------
// 4. Main normalization entry point
// ---------------------------------------------------------------------------

export interface NormalizationResult {
  rows: CanonicalRow[];
  source: "docling_fields" | "docling_tables" | "text_fallback" | "passthrough";
  rowCount: number;
  warnings: string[];
}

/**
 * Normalizes extracted data from any source into canonical rows.
 *
 * @param input  - The raw extracted data
 * @param moduleType - Target module (leases, expenses, etc.)
 */
export function normalizeExtractedData(
  input: {
    /** Docling output (for PDF files) */
    doclingOutput?: DoclingOutput;
    /** Pre-parsed CSV rows (for CSV/Excel — already in row format) */
    csvRows?: Array<Record<string, string | null>>;
    /** Raw text content (for plain-text fallback) */
    textContent?: string;
  },
  moduleType: ModuleType,
): NormalizationResult {
  const warnings: string[] = [];

  // ── CSV/Excel rows: already in the right shape, pass through ─────────────
  if (input.csvRows && input.csvRows.length > 0) {
    return {
      rows: input.csvRows as CanonicalRow[],
      source: "passthrough",
      rowCount: input.csvRows.length,
      warnings,
    };
  }

  // ── PDF via Docling ───────────────────────────────────────────────────────
  if (input.doclingOutput) {
    const doc = input.doclingOutput;
    let rows: CanonicalRow[] = [];

    // Priority 1: structured fields (highest confidence)
    if (doc.fields && doc.fields.length > 0) {
      rows = normalizeDoclingFields(doc.fields, moduleType);
      if (rows.length > 0) {
        return { rows, source: "docling_fields", rowCount: rows.length, warnings };
      }
    }

    // Priority 2: tables
    if (doc.tables && doc.tables.length > 0) {
      for (const table of doc.tables) {
        const tableRows = normalizeDoclingTable(table, moduleType);
        rows.push(...tableRows);
      }
      if (rows.length > 0) {
        return { rows, source: "docling_tables", rowCount: rows.length, warnings };
      }
    }

    // Priority 3: full text fallback
    if (doc.full_text) {
      rows = normalizeTextContent(doc.full_text, moduleType);
      if (rows.length > 0) {
        warnings.push("Data extracted from unstructured text — review carefully");
        return { rows, source: "text_fallback", rowCount: rows.length, warnings };
      }
    }

    warnings.push("Docling output contained no extractable data");
    return { rows: [], source: "docling_fields", rowCount: 0, warnings };
  }

  // ── Plain text fallback ───────────────────────────────────────────────────
  if (input.textContent) {
    const rows = normalizeTextContent(input.textContent, moduleType);
    if (rows.length > 0) {
      warnings.push("Data extracted from plain text — review carefully");
      return { rows, source: "text_fallback", rowCount: rows.length, warnings };
    }
  }

  return { rows: [], source: "passthrough", rowCount: 0, warnings: ["No extractable data found"] };
}

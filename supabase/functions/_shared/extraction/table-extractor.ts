// @ts-nocheck
/**
 * Extraction Pipeline — Step 2: Table-Based Extraction
 *
 * Extracts structured data from Docling tables.
 * This is the primary source for multi-record documents (rent rolls, expense logs).
 *
 * Flow:
 *   1. Map table headers → schema fields (using tableHeaders aliases)
 *   2. For each row, coerce values to the correct type
 *   3. Return one ExtractedRecord per table row
 *
 * Tables are ideal for multi-row documents. Rule-based extraction (Step 1)
 * handles single-record documents (lease abstracts, property profiles).
 */

import type {
  DoclingTable,
  ExtractedField,
  ExtractedRecord,
  StepResult,
  ModuleType,
} from "./types.ts";
import { getSchema, type ModuleSchema, type FieldDef } from "./schemas.ts";
import { coerceValue } from "./rule-extractor.ts";

// ── Header matching ──────────────────────────────────────────────────────────

interface HeaderMapping {
  columnIndex: number;
  fieldName: string;
  fieldDef: FieldDef;
}

/**
 * Build a mapping from table column indices → schema fields.
 * Uses the `tableHeaders` aliases defined in each FieldDef.
 */
function mapHeaders(headers: string[], schema: ModuleSchema): HeaderMapping[] {
  const mappings: HeaderMapping[] = [];
  const usedFields = new Set<string>();

  for (let i = 0; i < headers.length; i++) {
    const headerLower = headers[i].toLowerCase().trim();
    if (!headerLower) continue;

    for (const [fieldName, fieldDef] of Object.entries(schema)) {
      if (fieldDef.derived || usedFields.has(fieldName)) continue;
      if (!fieldDef.tableHeaders) continue;

      const isMatch = fieldDef.tableHeaders.some((alias) => {
        const aliasLower = alias.toLowerCase();
        return (
          headerLower === aliasLower ||
          headerLower.replace(/[_\s-]/g, "") === aliasLower.replace(/[_\s-]/g, "")
        );
      });

      if (isMatch) {
        mappings.push({ columnIndex: i, fieldName, fieldDef });
        usedFields.add(fieldName);
        break;
      }
    }
  }

  return mappings;
}

/**
 * Score how well a table's headers match a given module schema.
 * Returns 0-1 indicating match quality.
 */
function scoreTableMatch(headers: string[], schema: ModuleSchema): number {
  const mappings = mapHeaders(headers, schema);
  if (mappings.length === 0) return 0;

  // Count how many required fields are covered
  const requiredFields = Object.entries(schema)
    .filter(([, def]) => def.required && !def.derived)
    .map(([name]) => name);

  const coveredRequired = requiredFields.filter((f) =>
    mappings.some((m) => m.fieldName === f),
  ).length;

  const requiredRatio = requiredFields.length > 0
    ? coveredRequired / requiredFields.length
    : 0.5;

  const coverageRatio = mappings.length / Math.max(headers.length, 1);

  return requiredRatio * 0.6 + coverageRatio * 0.4;
}

// ── Row extraction ───────────────────────────────────────────────────────────

function extractRow(
  row: string[],
  mappings: HeaderMapping[],
  rowIndex: number,
): ExtractedRecord | null {
  const fields: Record<string, ExtractedField> = {};
  let hasValue = false;

  for (const mapping of mappings) {
    const raw = row[mapping.columnIndex];
    if (raw === undefined || raw === null || raw.trim() === "") continue;

    const value = coerceValue(raw.trim(), mapping.fieldDef);
    if (value !== null && value !== undefined) {
      fields[mapping.fieldName] = {
        value,
        source: "table",
        confidence: 0.85,
        sourceText: raw.trim(),
      };
      hasValue = true;
    }
  }

  return hasValue ? { fields, rowIndex } : null;
}

function mergePropertyRecords(records: ExtractedRecord[]): ExtractedRecord[] {
  const byCode = new Map<string, ExtractedRecord>();
  const passthrough: ExtractedRecord[] = [];

  for (const record of records) {
    const codeValue = record.fields?.property_id_code?.value;
    const code = String(codeValue ?? "").trim();
    if (!code) {
      passthrough.push(record);
      continue;
    }

    const existing = byCode.get(code);
    if (!existing) {
      byCode.set(code, { ...record, fields: { ...record.fields } });
      continue;
    }

    for (const [fieldName, field] of Object.entries(record.fields ?? {})) {
      const current = existing.fields[fieldName];
      const currentBlank = current?.value === null ||
        current?.value === undefined ||
        String(current?.value ?? "").trim() === "";
      if (!current || currentBlank || (field.confidence ?? 0) > (current.confidence ?? 0)) {
        existing.fields[fieldName] = field;
      }
    }
  }

  return [...byCode.values(), ...passthrough].map((record, index) => ({
    ...record,
    rowIndex: index,
  }));
}

// ── Main: Table-based extraction ─────────────────────────────────────────────

/**
 * Step 2 of the extraction pipeline.
 *
 * Scans all Docling tables for the best-matching table, then extracts
 * one record per data row using deterministic type coercion.
 */
export function extractFromTables(
  tables: DoclingTable[],
  moduleType: ModuleType,
): StepResult {
  const schema = getSchema(moduleType);
  const warnings: string[] = [];

  if (!tables || tables.length === 0) {
    return { records: [], warnings: ["No tables found in document"] };
  }

  // Score each table and pick the best match
  const scored = tables
    .filter((t) => t.headers.length > 0 && t.rows.length > 0)
    .map((table) => ({
      table,
      score: scoreTableMatch(table.headers, schema),
      mappings: mapHeaders(table.headers, schema),
    }))
    .filter((s) => s.score > 0.1) // minimum 10% match
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    warnings.push("No tables matched the module schema");
    return { records: [], warnings };
  }

  // Use the best-matching table (or merge multiple if scores are close)
  const allRecords: ExtractedRecord[] = [];
  const processedTables = moduleType === "property"
    ? scored.filter((s) =>
      s.mappings.some((mapping) => mapping.fieldName === "property_id_code") ||
      s.score >= scored[0].score * 0.8
    )
    : scored.filter((s) => s.score >= scored[0].score * 0.8);

  for (const { table, mappings, score } of processedTables) {
    if (mappings.length === 0) continue;

    warnings.push(
      `Table ${table.table_index}: matched ${mappings.length}/${table.headers.length} columns (score: ${score.toFixed(2)})`,
    );

    for (let i = 0; i < table.rows.length; i++) {
      const record = extractRow(table.rows[i], mappings, allRecords.length);
      if (record) allRecords.push(record);
    }
  }

  if (allRecords.length === 0) {
    warnings.push("Tables matched but no valid data rows extracted");
  }

  const records = moduleType === "property"
    ? mergePropertyRecords(allRecords)
    : allRecords;

  if (moduleType === "property" && records.length !== allRecords.length) {
    warnings.push(
      `Merged ${allRecords.length} property table rows into ${records.length} records by Property ID`,
    );
  }

  return { records, warnings };
}

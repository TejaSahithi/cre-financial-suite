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

const LEASE_FIELD_ALIASES: Record<string, string> = {
  landlord_management_company: "landlord_name",
  landlord_management: "landlord_name",
  apartment_community: "property_name",
  premises_location: "property_address",
  lease_start_date: "start_date",
  lease_end_date: "end_date",
  tenant_1: "tenant_name",
  tenant_2: "tenant_name",
  late_fee: "late_fee_amount",
  returned_payment_fee: "returned_payment_fee_amount",
  application_fee: "application_fee_amount",
  administrative_fee: "administrative_fee_amount",
  pet_fee: "pet_fee_amount",
  pet_rent: "pet_rent_amount",
  parking_fee: "parking_fee_amount",
  water_sewer_reimbursement_charge: "water_sewer_reimbursement_amount",
  monthly_water_sewer_reimbursement_charge: "water_sewer_reimbursement_amount",
  utility_reimbursement_charge: "utility_reimbursement_amount",
};

function normalizeToken(value: string): string {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[#%]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildFieldAliasMap(
  schema: ModuleSchema,
  manualAliases: Record<string, string> = {},
): Map<string, string> {
  const aliasMap = new Map<string, string>();

  for (const [fieldName, fieldDef] of Object.entries(schema)) {
    aliasMap.set(normalizeToken(fieldName), fieldName);
    for (const label of fieldDef.labels ?? []) {
      aliasMap.set(normalizeToken(label), fieldName);
    }
    for (const header of fieldDef.tableHeaders ?? []) {
      aliasMap.set(normalizeToken(header), fieldName);
    }
  }

  for (const [alias, fieldName] of Object.entries(manualAliases)) {
    aliasMap.set(normalizeToken(alias), fieldName);
  }

  return aliasMap;
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

function mergeRecordField(
  target: Record<string, ExtractedField>,
  fieldName: string,
  incoming: ExtractedField,
) {
  const existing = target[fieldName];
  if (!existing || (incoming.confidence ?? 0) >= (existing.confidence ?? 0)) {
    target[fieldName] = incoming;
  }
}

function mergeSingleRecordRows(records: ExtractedRecord[]): ExtractedRecord[] {
  if (records.length === 0) return [];

  const fields: Record<string, ExtractedField> = {};
  for (const record of records) {
    for (const [fieldName, field] of Object.entries(record.fields ?? {})) {
      mergeRecordField(fields, fieldName, field);
    }
  }

  return Object.keys(fields).length > 0 ? [{ fields, rowIndex: 0 }] : [];
}

function isLikelyLeaseAuxiliaryTable(table: DoclingTable): boolean {
  const headerText = table.headers.map(normalizeToken).join(" ");
  if (/^landlord_authorized_agent tenant$/.test(headerText)) return true;
  if (/^area condition notes tenant_initials$/.test(headerText)) return true;

  const firstColumn = [table.headers[0], ...table.rows.map((row) => row[0])]
    .map((value) => normalizeToken(value))
    .filter(Boolean)
    .join(" ");

  if (/(^| )(signature|name|date)( |$)/.test(firstColumn) && table.rows.length <= 4) {
    return true;
  }
  if (/(^| )(area|condition|tenant_initials|notes)( |$)/.test(firstColumn) && table.rows.length >= 4) {
    return true;
  }

  return false;
}

function isGenericLeaseKeyValueTable(table: DoclingTable): boolean {
  const headerA = normalizeToken(table.headers[0] ?? "");
  const headerB = normalizeToken(table.headers[1] ?? "");
  const normalizedHeaders = [headerA, headerB].filter(Boolean);

  if (normalizedHeaders.length !== 2) return false;
  if (table.rows.length === 0) return false;
  if (Math.max(...table.rows.map((row) => row.length), 0) > 2) return false;
  if (isLikelyLeaseAuxiliaryTable(table)) return false;

  const genericPairs = new Set([
    "item",
    "details_amount",
    "details",
    "amount",
    "value",
    "description",
  ]);

  return normalizedHeaders.some((header) => genericPairs.has(header)) ||
    table.rows.some((row) => {
      const key = normalizeToken(row[0] ?? "");
      return key in LEASE_FIELD_ALIASES;
    });
}

function resolveLeaseFieldName(label: string, aliasMap: Map<string, string>): string | null {
  const normalized = normalizeToken(label);
  if (!normalized) return null;
  if (aliasMap.has(normalized)) return aliasMap.get(normalized)!;

  const withoutTrailingOrdinal = normalized.replace(/_\d+$/, "");
  if (aliasMap.has(withoutTrailingOrdinal)) return aliasMap.get(withoutTrailingOrdinal)!;

  return null;
}

function extractLeaseKeyValueTables(
  tables: DoclingTable[],
  schema: ModuleSchema,
): StepResult {
  const warnings: string[] = [];
  const aliasMap = buildFieldAliasMap(schema, LEASE_FIELD_ALIASES);
  const fields: Record<string, ExtractedField> = {};

  for (const table of tables) {
    if (!isGenericLeaseKeyValueTable(table)) continue;

    let matchedRows = 0;
    for (const row of table.rows) {
      if (!Array.isArray(row) || row.length < 2) continue;

      const rawKey = String(row[0] ?? "").trim();
      const rawValue = row.slice(1).join(" ").trim();
      if (!rawKey || !rawValue) continue;
      if (/^(?:n\/a|na|none)$/i.test(rawValue)) continue;

      const fieldName = resolveLeaseFieldName(rawKey, aliasMap);
      if (!fieldName) continue;

      const fieldDef = schema[fieldName];
      if (!fieldDef) continue;

      const value = coerceValue(rawValue, fieldDef);
      if (value === null || value === undefined || String(value).trim() === "") continue;

      mergeRecordField(fields, fieldName, {
        value,
        source: "table",
        confidence: 0.9,
        sourceText: `${rawKey}: ${rawValue}`,
      });
      matchedRows += 1;
    }

    if (matchedRows > 0) {
      warnings.push(`Table ${table.table_index}: merged ${matchedRows} lease key/value rows`);
    }
  }

  return Object.keys(fields).length > 0
    ? { records: [{ fields, rowIndex: 0 }], warnings }
    : { records: [], warnings };
}

function extractLeaseStructuredTables(
  tables: DoclingTable[],
  schema: ModuleSchema,
): StepResult {
  const warnings: string[] = [];

  const scored = tables
    .filter((table) => table.headers.length > 0 && table.rows.length > 0)
    .filter((table) => !isGenericLeaseKeyValueTable(table) && !isLikelyLeaseAuxiliaryTable(table))
    .map((table) => ({
      table,
      score: scoreTableMatch(table.headers, schema),
      mappings: mapHeaders(table.headers, schema),
    }))
    .filter((entry) => entry.mappings.length >= 2 && entry.score >= 0.45)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { records: [], warnings };
  }

  const bestScore = scored[0].score;
  const allRecords: ExtractedRecord[] = [];
  for (const { table, mappings, score } of scored.filter((entry) => entry.score >= Math.max(0.45, bestScore * 0.8))) {
    warnings.push(
      `Table ${table.table_index}: matched ${mappings.length}/${table.headers.length} lease columns (score: ${score.toFixed(2)})`,
    );

    for (let i = 0; i < table.rows.length; i++) {
      const record = extractRow(table.rows[i], mappings, allRecords.length);
      if (record) allRecords.push(record);
    }
  }

  return {
    records: mergeSingleRecordRows(allRecords),
    warnings,
  };
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

  if (moduleType === "lease") {
    const keyValueResult = extractLeaseKeyValueTables(tables, schema);
    const structuredResult = extractLeaseStructuredTables(tables, schema);
    const mergedRecords = mergeSingleRecordRows([
      ...keyValueResult.records,
      ...structuredResult.records,
    ]);

    return {
      records: mergedRecords,
      warnings: [...keyValueResult.warnings, ...structuredResult.warnings],
    };
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

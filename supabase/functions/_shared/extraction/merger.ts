// @ts-nocheck
/**
 * Extraction Pipeline — Result Merger
 *
 * Merges results from the three extraction steps with strict priority:
 *   rule (0.95) > table (0.85) > llm (0.70)
 *
 * For each field in each record:
 *   - If multiple sources provide a value, the highest-confidence one wins
 *   - Ties broken by source priority (rule > table > llm)
 *
 * For multi-row documents:
 *   - Table records are the primary row structure
 *   - Rule-based fields (single record) are broadcast to all table rows
 *     (e.g., property_name extracted from header applies to every lease row)
 *   - LLM fields are matched by row index
 */

import type { ExtractedField, ExtractedRecord, StepResult, ModuleType } from "./types.ts";
import { getSchema } from "./schemas.ts";
import { evaluateCandidateForField } from "./candidate-decision.ts";

/** Priority order for tie-breaking */
const SOURCE_PRIORITY: Record<string, number> = {
  rule: 3,
  table: 2,
  llm: 1,
};

/**
 * Merge extraction results from all three steps.
 *
 * @param ruleResult    Step 1 output (0 or 1 records typically)
 * @param tableResult   Step 2 output (0 to N records)
 * @param llmResult     Step 3 output (0 to N records)
 * @param moduleType    Module for schema reference
 * @returns Merged records with best-confidence field selection
 */
export function mergeResults(
  ruleResult: StepResult,
  tableResult: StepResult,
  llmResult: StepResult,
  moduleType: ModuleType,
): { records: ExtractedRecord[]; warnings: string[] } {
  const schema = getSchema(moduleType);
  const warnings: string[] = [];

  // Determine the primary record set (most rows)
  const tableCt = tableResult.records.length;
  const ruleCt = ruleResult.records.length;
  const llmCt = llmResult.records.length;
  const totalRows = Math.max(tableCt, ruleCt, llmCt, 1);

  // If table has multiple rows, it defines the row structure
  const isMultiRow = tableCt > 1;

  const merged: ExtractedRecord[] = [];

  for (let i = 0; i < totalRows; i++) {
    const fields: Record<string, ExtractedField> = {};

    // Layer 1: Start with LLM fields (lowest priority, overwritten by higher)
    const llmRecord = llmResult.records[i];
    if (llmRecord) {
      for (const [key, field] of Object.entries(llmRecord.fields)) {
        fields[key] = field;
      }
    }

    // Layer 2: Table fields (overwrite LLM)
    const tableRecord = tableResult.records[i];
    if (tableRecord) {
      for (const [key, field] of Object.entries(tableRecord.fields)) {
        mergeField(fields, key, field, moduleType, schema);
      }
    }

    // Layer 3: Rule-based fields (highest priority)
    // For multi-row: broadcast rule fields to all rows (e.g., property_name from header)
    // For single-row: direct merge
    if (isMultiRow) {
      // Broadcast rule fields that are "document-level" (not row-specific)
      const ruleRecord = ruleResult.records[0]; // rule-based usually yields 1 record
      if (ruleRecord) {
        for (const [key, field] of Object.entries(ruleRecord.fields)) {
          // Only broadcast if the table row doesn't already have this field
          if (!fields[key]) {
            fields[key] = { ...field };
          }
        }
      }
    } else {
      const ruleRecord = ruleResult.records[i] ?? ruleResult.records[0];
      if (ruleRecord) {
        for (const [key, field] of Object.entries(ruleRecord.fields)) {
          mergeField(fields, key, field, moduleType, schema);
        }
      }
    }

    // Only include records that have at least one field
    if (Object.keys(fields).length > 0) {
      merged.push({ fields, rowIndex: i });
    }
  }

  if (merged.length === 0) {
    warnings.push("Merge produced no records");
  }

  return { records: merged, warnings };
}

/**
 * Merge a single field into the record, keeping the higher-confidence value.
 * Domain-aware (Release 1): a candidate whose source text is hard-rejected
 * for this field (wrong clause domain, or an explicit exclusion pattern) is
 * dropped regardless of confidence — see candidate-decision.ts. A
 * "needs_review" candidate is still merged (preserving pre-Release-1
 * behavior) but flagged via evidenceDecision for the audit trail.
 */
function mergeField(
  target: Record<string, ExtractedField>,
  key: string,
  incoming: ExtractedField,
  moduleType: ModuleType,
  schema: ReturnType<typeof getSchema>,
): void {
  const existing = target[key];
  const fieldDef = schema[key];

  let incomingToMerge = incoming;
  if (fieldDef) {
    const result = evaluateCandidateForField({
      field: fieldDef,
      fieldKey: key,
      moduleType,
      value: incoming.value,
      sourceText: incoming.sourceText ?? null,
      confidence: incoming.confidence,
      sourceType: incoming.source,
    });
    if (result.decision === "reject") {
      // Hard veto — this candidate never overwrites, never merges, and
      // never becomes `existing` for future comparisons.
      return;
    }
    if (result.decision === "needs_review") {
      incomingToMerge = { ...incoming, evidenceDecision: "needs_review" };
    }
  }

  if (!existing) {
    target[key] = incomingToMerge;
    return;
  }

  // Higher confidence wins
  if (incomingToMerge.confidence > existing.confidence) {
    target[key] = incomingToMerge;
    return;
  }

  // Equal confidence — use source priority
  if (
    incomingToMerge.confidence === existing.confidence &&
    (SOURCE_PRIORITY[incomingToMerge.source] ?? 0) > (SOURCE_PRIORITY[existing.source] ?? 0)
  ) {
    target[key] = incomingToMerge;
  }
}

/**
 * Identify which fields are still missing after Steps 1 and 2.
 * These are the fields that should be sent to the LLM in Step 3.
 */
export function findMissingFields(
  ruleResult: StepResult,
  tableResult: StepResult,
  moduleType: ModuleType,
): string[] {
  const schema = getSchema(moduleType);
  const allExtractableFields = Object.entries(schema)
    .filter(([, def]) => !def.derived)
    .map(([name]) => name);

  // Collect all fields found so far
  const found = new Set<string>();

  for (const record of ruleResult.records) {
    for (const key of Object.keys(record.fields)) found.add(key);
  }
  for (const record of tableResult.records) {
    for (const key of Object.keys(record.fields)) found.add(key);
  }

  return allExtractableFields.filter((f) => !found.has(f));
}

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

import type { CandidateDecisionRecord, ExtractedField, ExtractedRecord, StepResult, ModuleType } from "./types.ts";
import { getSchema } from "./schemas.ts";
import { CANDIDATE_DECISION_VERSION, evaluateCandidateForField } from "./candidate-decision.ts";

/** Priority order for tie-breaking */
const SOURCE_PRIORITY: Record<string, number> = {
  rule: 3,
  table: 2,
  llm: 1,
};

/**
 * A candidate mergeField() hard-rejected (evaluateCandidateForField's
 * "reject" decision) -- previously dropped with no record anywhere. Shape
 * mirrors openai-fact-ledger/fact-field-mapper.ts's rejectedCandidates so
 * both reconciliation paths produce lineage in the same form.
 */
export interface RejectedMergeCandidate {
  field_key: string;
  candidate_value: unknown;
  candidate_source: string;
  decision: "reject";
  reason: string;
  source_page: number | null;
  source_text: string | null;
}

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
): { records: ExtractedRecord[]; warnings: string[]; rejectedCandidates: RejectedMergeCandidate[] } {
  const schema = getSchema(moduleType);
  const warnings: string[] = [];
  const rejectedCandidates: RejectedMergeCandidate[] = [];

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
        mergeField(fields, key, field, moduleType, schema, rejectedCandidates);
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
          mergeField(fields, key, field, moduleType, schema, rejectedCandidates);
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

  return { records: merged, warnings, rejectedCandidates };
}

const HIGH_RISK_CONFLICT_FIELDS = new Set([
  "cam_amount",
  "cam_cap_type",
  "cam_cap_pct",
  "admin_fee_pct",
  "management_fee_basis",
  "gross_up_enabled",
  "gross_up_threshold",
  "base_year",
  "expense_stop",
  "responsibility_taxes",
  "responsibility_insurance",
  "responsibility_utilities",
  "responsibility_repairs",
  "tenant_pro_rata_share",
  "hvac_responsibility",
  "tenant_insurance_required",
  "general_liability_min",
  "property_insurance_responsibility",
  "waiver_of_subrogation",
  "additional_insureds_required",
  "security_deposit",
  "escalation_rate",
  "escalation_type",
  "escalation_timing",
  "renewal_options",
  "renewal_type",
  "renewal_notice_months",
  "option_exercise_deadline",
  "termination_notice_months",
  "early_termination_option",
  "assignment_provisions",
  "default_cure_period",
  "commencement_date",
  "expiration_date",
  "rent_commencement_date",
]);

function stableString(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return `[${value.map(stableString).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}:${stableString(v)}`).join(",")}}`;
  }
  return String(value).trim().toLowerCase().replace(/[$,\s]+/g, " ");
}

function candidateIdFor(fieldKey: string, field: ExtractedField): string {
  const raw = `${fieldKey}|${field.source}|${stableString(field.value)}|${String(field.sourceText ?? "").slice(0, 160)}|${field.sourcePage ?? ""}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return `${fieldKey}:${field.source}:${Math.abs(hash).toString(36)}`;
}

function toCandidate(fieldKey: string, field: ExtractedField) {
  return {
    candidateId: candidateIdFor(fieldKey, field),
    fieldKey,
    rawValue: field.value ?? null,
    normalizedValue: field.value ?? null,
    source: field.source,
    confidence: field.confidence ?? 0,
    clauseCategory: null,
    evidenceIds: [],
    validationErrors: [],
    sourceText: field.sourceText ?? null,
    sourcePage: field.sourcePage ?? null,
    createdAt: new Date(0).toISOString(),
  };
}

function mergeCandidateLists(fieldKey: string, existing: ExtractedField | null | undefined, incoming: ExtractedField) {
  const byId = new Map<string, any>();
  for (const candidate of [...((existing as any)?.candidates ?? [])]) {
    if (candidate?.candidateId) byId.set(candidate.candidateId, candidate);
  }
  if (existing) {
    const existingCandidate = toCandidate(fieldKey, existing);
    byId.set(existingCandidate.candidateId, existingCandidate);
  }
  const incomingCandidate = toCandidate(fieldKey, incoming);
  byId.set(incomingCandidate.candidateId, incomingCandidate);
  return [...byId.values()];
}

function candidateHasEvidence(field: ExtractedField): boolean {
  return Boolean(field.sourceText && String(field.sourceText).trim()) || field.sourcePage != null;
}

function isStrongCandidate(field: ExtractedField): boolean {
  return field.value !== null && field.value !== undefined && String(field.value).trim() !== "" && (field.confidence ?? 0) >= 0.7 && candidateHasEvidence(field);
}

function valuesDisagree(left: unknown, right: unknown): boolean {
  const a = stableString(left);
  const b = stableString(right);
  return Boolean(a && b && a !== b);
}

function shouldFlagConflict(fieldKey: string, existing: ExtractedField, incoming: ExtractedField): boolean {
  return HIGH_RISK_CONFLICT_FIELDS.has(fieldKey) && isStrongCandidate(existing) && isStrongCandidate(incoming) && valuesDisagree(existing.value, incoming.value);
}

function sourcePriority(field: ExtractedField): number {
  return SOURCE_PRIORITY[field.source] ?? 0;
}

function selectPreferred(existing: ExtractedField, incoming: ExtractedField): ExtractedField {
  if ((incoming.confidence ?? 0) > (existing.confidence ?? 0)) return incoming;
  if ((incoming.confidence ?? 0) === (existing.confidence ?? 0) && sourcePriority(incoming) > sourcePriority(existing)) return incoming;
  return existing;
}

function decisionIdFor(fieldKey: string, candidateIds: string[], status: CandidateDecisionRecord["status"]): string {
  const raw = `${fieldKey}|${status}|${candidateIds.join("|")}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return `${fieldKey}:decision:${Math.abs(hash).toString(36)}`;
}

function buildCandidateDecisionRecord(args: {
  fieldKey: string;
  status: CandidateDecisionRecord["status"];
  selectedCandidateId: string | null;
  conflictCandidateIds?: string[];
  candidates: any[];
  reasonCodes?: string[];
}): CandidateDecisionRecord {
  const scores: Record<string, number> = {};
  const reasons: Record<string, any[]> = {};
  for (const candidate of args.candidates) {
    if (!candidate?.candidateId) continue;
    scores[candidate.candidateId] = Number(candidate.confidence ?? 0);
    reasons[candidate.candidateId] = Array.isArray(candidate.validationErrors) && candidate.validationErrors.length
      ? candidate.validationErrors
      : [];
  }
  if (args.reasonCodes?.length && args.selectedCandidateId) reasons[args.selectedCandidateId] = [...new Set([...(reasons[args.selectedCandidateId] ?? []), ...args.reasonCodes])];
  const ids = args.conflictCandidateIds ?? args.candidates.map((candidate) => candidate?.candidateId).filter(Boolean);
  return {
    decisionId: decisionIdFor(args.fieldKey, ids, args.status),
    extractionRunId: "legacy_hybrid_runtime",
    fieldKey: args.fieldKey,
    status: args.status,
    selectedCandidateId: args.selectedCandidateId,
    conflictCandidateIds: ids,
    scores,
    reasons,
    policyVersion: CANDIDATE_DECISION_VERSION,
    createdAt: new Date(0).toISOString(),
  };
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
  rejectedCandidates: RejectedMergeCandidate[],
): void {
  const existing = target[key];
  const fieldDef = schema[key];

  let incomingToMerge = incoming;
  let evaluationReasonCodes: string[] = [];
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
    evaluationReasonCodes = result.reasonCodes ?? [];
    if (result.decision === "reject") {
      rejectedCandidates.push({
        field_key: key,
        candidate_value: incoming.value,
        candidate_source: incoming.source,
        decision: "reject",
        reason: result.reasons.join("; ") || "domain_mismatch",
        source_page: incoming.sourcePage ?? null,
        source_text: incoming.sourceText ?? null,
      });
      return;
    }
    if (result.decision === "needs_review") {
      incomingToMerge = { ...incoming, evidenceDecision: "needs_review", extractionStatus: "needs_review" };
    }
  }

  if (!existing) {
    const candidate = toCandidate(key, incomingToMerge);
    target[key] = {
      ...incomingToMerge,
      canonicalStatus: incomingToMerge.extractionStatus === "needs_review" ? "manual_review" : "extracted",
      resolutionState: incomingToMerge.extractionStatus === "needs_review" ? "unresolved" : "authoritative",
      requiresReview: incomingToMerge.extractionStatus === "needs_review",
      candidates: [candidate],
      conflictCandidateIds: [],
      conflictCandidates: [],
      selectedCandidateId: candidate.candidateId,
      decision: buildCandidateDecisionRecord({ fieldKey: key, status: incomingToMerge.extractionStatus === "needs_review" ? "manual_review" : "selected", selectedCandidateId: candidate.candidateId, candidates: [candidate], reasonCodes: evaluationReasonCodes }),
    } as any;
    return;
  }

  const candidates = mergeCandidateLists(key, existing, incomingToMerge);
  const preferred = selectPreferred(existing, incomingToMerge);

  if (shouldFlagConflict(key, existing, incomingToMerge)) {
    const selectedCandidate = toCandidate(key, preferred);
    const conflictCandidateIds = candidates.map((candidate) => candidate.candidateId).filter(Boolean);
    target[key] = {
      ...preferred,
      extractionStatus: "conflict",
      canonicalStatus: "conflict",
      resolutionState: selectedCandidate?.candidateId ? "provisional" : "unresolved",
      requiresReview: true,
      evidenceDecision: "needs_review",
      candidates,
      conflictCandidateIds,
      conflictCandidates: conflictCandidateIds,
      selectedCandidateId: selectedCandidate?.candidateId ?? null,
      decision: buildCandidateDecisionRecord({ fieldKey: key, status: "conflict", selectedCandidateId: selectedCandidate?.candidateId ?? null, conflictCandidateIds, candidates, reasonCodes: ["CROSS_FIELD_CONFLICT"] }),
    } as any;
    return;
  }

  const selectedCandidateId = (preferred as any).selectedCandidateId ?? toCandidate(key, preferred).candidateId;
  const manualReview = (preferred as any).extractionStatus === "needs_review" || (preferred as any).evidenceDecision === "needs_review";
  target[key] = {
    ...preferred,
    candidates,
    conflictCandidateIds: [],
    conflictCandidates: [],
    selectedCandidateId,
    canonicalStatus: manualReview ? "manual_review" : "extracted",
    resolutionState: manualReview ? "unresolved" : "authoritative",
    requiresReview: manualReview,
    decision: buildCandidateDecisionRecord({ fieldKey: key, status: manualReview ? "manual_review" : "selected", selectedCandidateId, candidates, reasonCodes: evaluationReasonCodes }),
  } as any;
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

// @ts-nocheck

import { callLLMStructured } from "../../llm.ts";
import { callLLMStructuredWithProvenance } from "../provenance/transport/openai.ts";
import { getSchema, LEASE_SCHEMA_VERSION, type FieldDef } from "../schemas.ts";
import type {
  DoclingOutput,
  ExtractedField,
  ExtractedRecord,
  ExtractionPipelineResult,
  ModuleType,
  ValidationError,
} from "../types.ts";
import { flattenRecords } from "../validator.ts";
import { computeDerivedFields } from "../calculator.ts";
import { snapshotFieldMap } from "../pipeline.ts";
import { EXTRACTION_CONTRACT_VERSION } from "../contract-version.ts";
import { createDocumentItem } from "../lease-workflow.ts";
import { isLeaseModuleType } from "../lease-module.ts";
import {
  buildCompactLeaseDocument,
  compactDocumentEvidenceMap,
  type CompactLeaseDocument,
} from "./compact-document.ts";
import {
  buildWholeDocumentJsonSchema,
  buildWholeDocumentSystemPrompt,
  WHOLE_DOCUMENT_SCHEMA_NAME,
  WHOLE_DOCUMENT_SCHEMA_VERSION,
  type WholeDocumentExtractionResponse,
  type WholeDocumentDynamicFinding,
  type WholeDocumentExpenseRuleCandidate,
  type WholeDocumentFieldResult,
} from "./whole-document-schema.ts";

export interface RunWholeDocumentLlmArgs {
  document: DoclingOutput | Record<string, unknown>;
  moduleType: ModuleType;
  deadlineAt?: number;
  provenance?: {
    supabaseAdmin: any;
    context: import("../provenance/types.ts").ProvenanceContext;
  };
}

function maxWholeDocumentPromptChars(): number {
  const configured = Number(Deno.env.get("LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS"));
  return Number.isFinite(configured) && configured >= 50_000
    ? Math.floor(configured)
    : 400_000;
}

function maxWholeDocumentOutputTokens(): number {
  const configured = Number(
    Deno.env.get("LEASE_WHOLE_DOCUMENT_LLM_MAX_OUTPUT_TOKENS") ??
    Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS"),
  );
  return Number.isFinite(configured) && configured >= 4_096
    ? Math.floor(configured)
    : 16_384;
}

function failureResult(
  startedAt: number,
  message: string,
  diagnostics: Record<string, unknown>,
): ExtractionPipelineResult {
  return {
    rows: [],
    method: "fallback",
    warnings: [message],
    validationErrors: [],
    metadata: {
      ruleFieldsExtracted: 0,
      tableFieldsExtracted: 0,
      llmFieldsExtracted: 0,
      totalRecords: 0,
      avgConfidence: 0,
      chunksProcessed: 1,
      processingTimeMs: Date.now() - startedAt,
      extractionDebug: {
        extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
        openai_fact_ledger: {
          extraction_mode: "whole_document_llm_v2",
          architecture: "llm_direct_schema",
          authoritative: true,
          typescript_field_mapping_used: false,
          llm_call_count: 1,
          facts_extracted_count: 0,
          facts_mapped_count: 0,
          facts_unmapped_count: 0,
          ...diagnostics,
        },
      },
    } as any,
  };
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

function normalizeEnumToken(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function coerceNumberValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const wordMatch = raw.toLowerCase().match(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)\b/);
  if (wordMatch && /percent|per\s*cent|%/i.test(raw)) return NUMBER_WORDS[wordMatch[1]];
  const parenNegative = /^\s*\(/.test(raw) && /\)\s*$/.test(raw);
  const match = raw.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  if (!Number.isFinite(parsed)) return null;
  return parenNegative ? -Math.abs(parsed) : parsed;
}

function coerceBooleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (["true", "yes", "y", "required", "applicable", "included", "present"].includes(raw)) return true;
  if (["false", "no", "n", "not_required", "not required", "not_applicable", "not applicable", "none", "absent"].includes(raw)) return false;
  return null;
}

function coerceDateValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const slash = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (slash) {
    const year = slash[3].length === 2 ? Number(`20${slash[3]}`) : Number(slash[3]);
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    return isoDateIfReal(year, month, day);
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return isoDateIfReal(parsed.getUTCFullYear(), parsed.getUTCMonth() + 1, parsed.getUTCDate());
}

function isoDateIfReal(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
  return parsed.toISOString().slice(0, 10);
}

function validateTypedValue(
  value: unknown,
  def: FieldDef,
): { valid: true; value: unknown } | { valid: false; reason: string } {
  if (value == null || value === "") return { valid: false, reason: "value is null or empty" };

  if (def.type === "string") {
    if (typeof value === "string" && value.trim()) return { valid: true, value: value.trim() };
    if (typeof value === "number" || typeof value === "boolean") return { valid: true, value: String(value) };
    return { valid: false, reason: "expected a non-empty string" };
  }
  if (def.type === "number") {
    const numeric = coerceNumberValue(value);
    if (numeric == null) return { valid: false, reason: "expected a finite number" };
    if (def.min != null && numeric < def.min) return { valid: false, reason: `number is below minimum ${def.min}` };
    if (def.max != null && numeric > def.max) return { valid: false, reason: `number is above maximum ${def.max}` };
    return { valid: true, value: numeric };
  }
  if (def.type === "boolean") {
    const booleanValue = coerceBooleanValue(value);
    return booleanValue == null
      ? { valid: false, reason: "expected a boolean" }
      : { valid: true, value: booleanValue };
  }
  if (def.type === "enum") {
    if (typeof value !== "string") return { valid: false, reason: `expected one of: ${(def.enumValues ?? []).join(", ")}` };
    const exact = (def.enumValues ?? []).find((candidate) => candidate === value.trim());
    if (exact) return { valid: true, value: exact };
    const normalized = normalizeEnumToken(value);
    const normalizedMatch = (def.enumValues ?? []).find((candidate) => normalizeEnumToken(candidate) === normalized);
    return normalizedMatch
      ? { valid: true, value: normalizedMatch }
      : { valid: false, reason: `expected one of: ${(def.enumValues ?? []).join(", ")}` };
  }
  if (def.type === "date") {
    const iso = coerceDateValue(value);
    if (!iso) return { valid: false, reason: "expected an ISO date (YYYY-MM-DD)" };
    return { valid: true, value: iso };
  }
  return { valid: false, reason: `unsupported field type ${String((def as any).type)}` };
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function findQuoteInEvidenceMap(
  quote: string,
  evidenceMap: Map<string, { text: string; page: number | null }>,
): { id: string; page: number | null } | null {
  if (!quote) return null;
  for (const [id, node] of evidenceMap.entries()) {
    if (normalizeEvidenceText(node.text).includes(quote)) {
      return { id, page: node.page ?? null };
    }
  }
  return null;
}

function verifyEvidence(
  result: WholeDocumentFieldResult,
  compact: CompactLeaseDocument,
): {
  quoteVerified: boolean;
  nodeIdsValid: boolean;
  sourcePage: number | null;
  evidenceErrors: string[];
  recoveredNodeId?: string | null;
  quoteRecoveredFromUncitedNode?: boolean;
} {
  const evidenceMap = compactDocumentEvidenceMap(compact);
  const nodeIds = Array.isArray(result.sourceNodeIds) ? result.sourceNodeIds : [];
  const validNodes = nodeIds.map((id) => evidenceMap.get(id)).filter(Boolean) as Array<{ text: string; page: number | null }>;
  const nodeIdsValid = nodeIds.length > 0 && validNodes.length === nodeIds.length;
  const quote = normalizeEvidenceText(String(result.sourceQuote ?? ""));
  const quoteVerifiedInCitedNodes = !!quote && validNodes.some((node) => normalizeEvidenceText(node.text).includes(quote));
  const recoveredQuoteNode = quoteVerifiedInCitedNodes ? null : findQuoteInEvidenceMap(quote, evidenceMap);
  const quoteVerified = quoteVerifiedInCitedNodes || Boolean(recoveredQuoteNode);
  const evidenceErrors: string[] = [];
  if (!nodeIdsValid) evidenceErrors.push("one or more sourceNodeIds do not exist in the compact document");
  if (!quoteVerified) evidenceErrors.push("sourceQuote was not found verbatim in the compact document");
  return {
    quoteVerified,
    nodeIdsValid,
    sourcePage: validNodes.find((node) => node.page != null)?.page ?? recoveredQuoteNode?.page ?? null,
    evidenceErrors,
    recoveredNodeId: recoveredQuoteNode?.id ?? null,
    quoteRecoveredFromUncitedNode: Boolean(recoveredQuoteNode),
  };
}

function extractedFieldFromResult(
  result: WholeDocumentFieldResult,
  typedValue: unknown,
  evidence: ReturnType<typeof verifyEvidence>,
): ExtractedField {
  const uncertainStatus = result.status === "ambiguous" || result.status === "conflicting" || result.status === "illegible";
  const requiresReview = uncertainStatus || !evidence.quoteVerified || !evidence.nodeIdsValid;
  const extractionStatus =
    result.status === "conflicting" ? "conflict"
      : requiresReview ? "needs_review"
      : "extracted";
  return {
    value: typedValue,
    source: "llm",
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    sourceText: result.sourceQuote ?? undefined,
    sourcePage: evidence.sourcePage,
    extractionStatus,
    canonicalStatus:
      result.status === "conflicting" ? "conflict"
        : requiresReview ? "manual_review"
        : "extracted",
    resolutionState: requiresReview ? "provisional" : "authoritative",
    requiresReview,
    wholeDocumentEvidence: {
      source_node_ids: result.sourceNodeIds,
      quote_verified: evidence.quoteVerified,
      node_ids_valid: evidence.nodeIdsValid,
      uncertainty_reason: result.uncertaintyReason,
      evidence_errors: evidence.evidenceErrors,
    },
  } as ExtractedField;
}

function uncertainFieldFromResult(
  result: WholeDocumentFieldResult,
  evidence: ReturnType<typeof verifyEvidence>,
  compact: CompactLeaseDocument,
): ExtractedField {
  const verifiedAlternatives = (Array.isArray(result.alternatives) ? result.alternatives : []).map(
    (alternative, index) => ({
      alternative,
      index,
      evidence: verifyEvidence(alternative as any, compact),
    }),
  );
  const conflictCandidates = verifiedAlternatives
    .filter(({ evidence: alternativeEvidence }) => alternativeEvidence.nodeIdsValid && alternativeEvidence.quoteVerified)
    .map(({ alternative, index, evidence: alternativeEvidence }) => ({
      candidateId: `whole-document:${result.fieldKey}:alternative:${index}`,
      fieldKey: result.fieldKey,
      rawValue: alternative.value,
      normalizedValue: alternative.value,
      source: "llm",
      confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
      clauseCategory: null,
      evidenceIds: alternative.sourceNodeIds ?? [],
      validationErrors: [],
      sourceText: alternative.sourceQuote ?? null,
      sourcePage: alternativeEvidence.sourcePage,
      createdAt: new Date().toISOString(),
    }));
  const isConflict = result.status === "conflicting";
  return {
    value: null,
    source: "llm",
    confidence: Math.max(0, Math.min(1, Number(result.confidence) || 0)),
    sourceText: result.sourceQuote ?? undefined,
    sourcePage: evidence.sourcePage,
    extractionStatus: isConflict ? "conflict" : "needs_review",
    canonicalStatus: isConflict ? "conflict" : "manual_review",
    resolutionState: "unresolved",
    requiresReview: true,
    conflictCandidates,
    conflictCandidateIds: conflictCandidates.map((candidate) => candidate.candidateId),
    wholeDocumentEvidence: {
      source_node_ids: result.sourceNodeIds,
      quote_verified: evidence.quoteVerified,
      node_ids_valid: evidence.nodeIdsValid,
      uncertainty_reason: result.uncertaintyReason,
      evidence_errors: evidence.evidenceErrors,
      alternatives: result.alternatives ?? [],
      rejected_alternative_count: verifiedAlternatives.length - conflictCandidates.length,
    },
  } as ExtractedField;
}

const DYNAMIC_BUSINESS_AREAS = new Set([
  "parties_premises",
  "dates_term",
  "rent_charges",
  "expenses_recoveries",
  "cam_rules",
  "taxes",
  "insurance",
  "utilities",
  "repairs_maintenance",
  "legal_options",
  "critical_dates",
  "notices",
  "signatures",
  "documents_exhibits",
  "clause_records",
]);

function normalizeDynamicFieldKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 100);
}

function validateDynamicValue(
  finding: WholeDocumentDynamicFinding,
): { valid: true; value: unknown } | { valid: false; reason: string } {
  if (finding.status !== "found") {
    return finding.value == null
      ? { valid: true, value: null }
      : { valid: false, reason: `status ${finding.status} must have value=null` };
  }
  if (finding.value == null || finding.value === "") {
    return { valid: false, reason: "status found requires a non-empty value" };
  }
  if (["number", "currency", "percentage"].includes(finding.valueType)) {
    return typeof finding.value === "number" && Number.isFinite(finding.value)
      ? { valid: true, value: finding.value }
      : { valid: false, reason: `${finding.valueType} requires a finite numeric value` };
  }
  if (finding.valueType === "boolean") {
    return typeof finding.value === "boolean"
      ? { valid: true, value: finding.value }
      : { valid: false, reason: "boolean requires true or false" };
  }
  if (finding.valueType === "date") {
    return typeof finding.value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(finding.value)
      ? { valid: true, value: finding.value }
      : { valid: false, reason: "date requires YYYY-MM-DD" };
  }
  return typeof finding.value === "string" && finding.value.trim()
    ? { valid: true, value: finding.value.trim() }
    : { valid: false, reason: `${finding.valueType} requires a non-empty string` };
}

function buildDynamicItems(args: {
  findings: WholeDocumentDynamicFinding[];
  compact: CompactLeaseDocument;
  fixedFieldKeys: ReadonlySet<string>;
}): { items: any[]; rejected: Array<Record<string, unknown>> } {
  const items: any[] = [];
  const rejected: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const finding of args.findings) {
    const suggestedFieldKey = normalizeDynamicFieldKey(finding?.suggestedFieldKey);
    if (!suggestedFieldKey) {
      rejected.push({ suggested_field_key: finding?.suggestedFieldKey ?? null, reason: "missing_dynamic_field_key" });
      continue;
    }
    if (args.fixedFieldKeys.has(suggestedFieldKey)) {
      rejected.push({ suggested_field_key: suggestedFieldKey, reason: "duplicates_fixed_schema_field" });
      continue;
    }
    const typed = validateDynamicValue(finding);
    if (!typed.valid) {
      rejected.push({ suggested_field_key: suggestedFieldKey, reason: typed.reason });
      continue;
    }
    const evidence = verifyEvidence(finding as any, args.compact);
    // Dynamic vocabulary is unrestricted; evidence is not. Ungrounded
    // proposed fields remain in diagnostics and never become review rows.
    if (!evidence.nodeIdsValid || !evidence.quoteVerified) {
      rejected.push({
        suggested_field_key: suggestedFieldKey,
        reason: evidence.evidenceErrors.join("; "),
      });
      continue;
    }
    const dedupeKey = `${suggestedFieldKey}|${normalizeEvidenceText(String(finding.sourceQuote ?? ""))}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const businessArea = DYNAMIC_BUSINESS_AREAS.has(String(finding.businessArea))
      ? String(finding.businessArea)
      : "clause_records";
    const item = createDocumentItem({
      item_id: `whole_document_dynamic:${suggestedFieldKey}:${items.length}`,
      item_type: suggestedFieldKey,
      field_key: suggestedFieldKey,
      label: String(finding.label || suggestedFieldKey),
      business_area: businessArea,
      display_tab: businessArea,
      category: finding.valueType,
      value: typed.value,
      normalized_value: typed.value,
      raw_value: typed.value,
      source_text: finding.sourceQuote,
      source_page: evidence.sourcePage,
      confidence: Math.max(0, Math.min(1, Number(finding.confidence) || 0)),
      extraction_method: "whole_document_llm_v2",
      extraction_status: finding.status === "found" ? "extracted" : "needs_review",
      maps_to_existing_field: false,
      maps_to_fixed_field: false,
      creates_dynamic_row: true,
      review_status: "needs_review",
    });
    items.push({
      ...item,
      business_meaning: finding.businessMeaning,
      criticality: finding.criticality,
      value_type: finding.valueType,
      source_node_ids: finding.sourceNodeIds,
      quote_verified: true,
      requires_review: finding.status !== "found",
      review_reason: finding.uncertaintyReason,
    });
  }
  return { items, rejected };
}

function normalizeExpenseCategory(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildExpenseRuleCandidates(args: {
  candidates: WholeDocumentExpenseRuleCandidate[];
  compact: CompactLeaseDocument;
}): { rules: any[]; rejected: Array<Record<string, unknown>> } {
  const rules: any[] = [];
  const rejected: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const candidate of args.candidates || []) {
    const category = normalizeExpenseCategory(candidate?.category);
    if (!category) {
      rejected.push({ category: candidate?.category ?? null, reason: "missing_expense_category" });
      continue;
    }

    const evidence = verifyEvidence(candidate as any, args.compact);
    if (!evidence.quoteVerified) {
      rejected.push({
        category,
        reason: evidence.evidenceErrors.join("; "),
      });
      continue;
    }

    const sourceText = String(candidate.sourceQuote || "").trim();
    const subcategory = normalizeExpenseCategory(candidate.subcategory) || null;
    const dedupeKey = `${category}|${subcategory || ""}|${normalizeEvidenceText(sourceText)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const status = candidate.status === "found"
      ? "extracted"
      : candidate.status === "conflicting"
        ? "conflict_detected"
        : "needs_review";
    const includedInBaseRent =
      candidate.includedInBaseRent === "yes"
        ? true
        : candidate.includedInBaseRent === "no"
          ? false
          : null;
    const recoverable =
      candidate.recoverableFromTenant === "not_stated"
        ? "conditional"
        : candidate.recoverableFromTenant;
    const camEligible =
      candidate.camEligible === "not_stated"
        ? "conditional"
        : candidate.camEligible;
    const reconciliationRequired =
      candidate.reconciliationRequired === "yes"
        ? true
        : candidate.reconciliationRequired === "no"
          ? false
          : null;
    const amount = candidate.amount != null && Number.isFinite(Number(candidate.amount))
      ? Number(candidate.amount)
      : null;

    const sourceNodeIds = evidence.recoveredNodeId && !evidence.nodeIdsValid
      ? [evidence.recoveredNodeId]
      : candidate.sourceNodeIds;

    rules.push({
      expense_category: category,
      expense_subcategory: subcategory,
      category_name: String(candidate.category || category),
      responsibility:
        candidate.responsibleParty === "not_stated" ||
        candidate.responsibleParty === "conditional"
          ? "unknown"
          : candidate.responsibleParty,
      operational_responsibility:
        candidate.responsibleParty === "not_stated" ||
        candidate.responsibleParty === "conditional"
          ? "unknown"
          : candidate.responsibleParty,
      payment_treatment:
        candidate.paymentTreatment === "not_stated" ||
        candidate.paymentTreatment === "conditional"
          ? "not_applicable"
          : candidate.paymentTreatment,
      recoverable_from_tenant: recoverable,
      recoverable_flag: recoverable === "yes",
      cam_eligible: camEligible,
      included_in_base_rent: includedInBaseRent,
      included_in_rent: includedInBaseRent,
      recovery_method:
        candidate.recoveryMethod === "not_stated"
          ? "manual_review"
          : candidate.recoveryMethod,
      allocation_basis: candidate.allocationBasis,
      explicit_charge_amount: amount,
      fixed_monthly_amount: candidate.amountFrequency === "monthly" ? amount : null,
      billing_frequency:
        candidate.amountFrequency === "not_stated"
          ? null
          : candidate.amountFrequency,
      tenant_share_percent: candidate.tenantSharePercent,
      base_year: candidate.baseYear,
      base_year_amount: candidate.baseYearAmount,
      expense_stop_amount: candidate.expenseStopAmount,
      cap_type: candidate.capType,
      cap_amount: candidate.capAmount,
      cap_percent: candidate.capPercent,
      is_subject_to_cap: Boolean(candidate.capType || candidate.capAmount != null || candidate.capPercent != null),
      gross_up_percent: candidate.grossUpPercent,
      gross_up_applicable: candidate.grossUpPercent != null,
      admin_fee_percent: candidate.adminFeePercent,
      admin_fee_applicable: candidate.adminFeePercent != null,
      reconciliation_required: reconciliationRequired,
      reconciliation_frequency: candidate.reconciliationFrequency,
      obligation_kind: candidate.obligationKind,
      source_clause: sourceText,
      exact_source_text: sourceText,
      source_page: evidence.sourcePage,
      source_node_ids: sourceNodeIds,
      confidence_score: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
      confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
      extraction_status: status,
      status,
      review_status: "needs_review",
      approval_status: "draft",
      row_status: "needs_review",
      published_to_cam: false,
      editable: true,
      requires_review: true,
      review_reason:
        candidate.uncertaintyReason ||
        "LLM-extracted lease expense obligation requires approval before downstream publication.",
      notes: candidate.uncertaintyReason,
      generation_source: "whole_document_llm_expense_obligation_v1",
      extraction_method: "whole_document_llm_v2",
      quote_verified: true,
      source_evidence_recovered: Boolean(evidence.quoteRecoveredFromUncitedNode),
      clauses: [{
        clause_type: `${candidate.obligationKind}_obligation`,
        clause_text: sourceText,
        page_number: evidence.sourcePage,
        confidence: Math.max(0, Math.min(1, Number(candidate.confidence) || 0)),
        source_node_ids: sourceNodeIds,
      }],
    });
  }

  return { rules, rejected };
}

function envBoundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(Deno.env.get(name));
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(raw)));
}

function maxSectionedWholeDocumentChunks(): number {
  return envBoundedInt("LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_CHUNKS", 8, 2, 30);
}

function sectionPromptReserveChars(): number {
  return envBoundedInt("LEASE_WHOLE_DOCUMENT_LLM_SECTION_PROMPT_RESERVE_CHARS", 25_000, 5_000, 80_000);
}

function sectionDeadlineReserveMs(): number {
  return envBoundedInt("LEASE_WHOLE_DOCUMENT_LLM_SECTION_DEADLINE_RESERVE_MS", 20_000, 5_000, 60_000);
}

function isMeaningfulValue(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function normalizeComparableValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  return String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function compactDiagnostics(compact: CompactLeaseDocument): CompactLeaseDocument["diagnostics"] {
  const characterCount =
    compact.nodes.reduce((sum, node) => sum + String(node.text ?? "").length, 0) +
    compact.tables.reduce(
      (sum, table) => sum +
        (table.headers ?? []).join("\t").length +
        (table.rows ?? []).reduce((rowSum, row) => rowSum + (row.cells ?? []).join("\t").length, 0),
      0,
    ) +
    compact.keyValues.reduce((sum, field) => sum + field.key.length + field.value.length + (field.sourceText?.length ?? 0), 0);
  return {
    characterCount,
    nodeCount: compact.nodes.length,
    tableCount: compact.tables.length,
    tableRowCount: compact.tables.reduce((sum, table) => sum + table.rows.length, 0),
    keyValueCount: compact.keyValues.length,
    inputWasTruncated: compact.diagnostics.inputWasTruncated,
  };
}

function compactPromptChars(compact: CompactLeaseDocument, systemPrompt: string): number {
  return systemPrompt.length + JSON.stringify({ compactDocument: compact }).length;
}

function splitOversizeNode(node: CompactLeaseDocument["nodes"][number], maxTextChars: number): CompactLeaseDocument["nodes"] {
  const text = String(node.text ?? "");
  if (text.length <= maxTextChars) return [node];
  const parts: CompactLeaseDocument["nodes"] = [];
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const hardEnd = Math.min(text.length, offset + maxTextChars);
    const softEnd = hardEnd < text.length
      ? Math.max(offset + Math.floor(maxTextChars * 0.65), text.lastIndexOf("\n", hardEnd))
      : hardEnd;
    const end = softEnd > offset ? softEnd : hardEnd;
    const partText = text.slice(offset, end).trim();
    if (partText) {
      parts.push({
        ...node,
        id: `${node.id}:part:${index}`,
        text: partText,
      });
    }
    offset = end;
    index++;
  }
  return parts;
}

function makeCompactSection(
  compact: CompactLeaseDocument,
  nodes: CompactLeaseDocument["nodes"],
  sectionIndex: number,
): CompactLeaseDocument {
  const pages = new Set(nodes.map((node) => node.page).filter((page) => page != null));
  const includeUnpaged = sectionIndex === 0;
  const section: CompactLeaseDocument = {
    ...compact,
    source: "available_docling",
    nodes,
    tables: compact.tables.filter((table) => table.page == null ? includeUnpaged : pages.has(table.page)),
    keyValues: compact.keyValues.filter((field) => field.page == null ? includeUnpaged : pages.has(field.page)),
    diagnostics: compact.diagnostics,
  };
  section.diagnostics = compactDiagnostics(section);
  return section;
}

function buildCompactSections(
  compact: CompactLeaseDocument,
  systemPrompt: string,
  maxInputChars: number,
): { sections: CompactLeaseDocument[]; sectionDocumentBudget: number; warnings: string[] } {
  const reserve = sectionPromptReserveChars();
  const sectionDocumentBudget = Math.max(25_000, maxInputChars - systemPrompt.length - reserve);
  const maxNodeTextChars = Math.max(10_000, Math.floor(sectionDocumentBudget * 0.75));
  const expandedNodes = compact.nodes.flatMap((node) => splitOversizeNode(node, maxNodeTextChars));
  const sections: CompactLeaseDocument[] = [];
  const warnings: string[] = [];
  let current: CompactLeaseDocument["nodes"] = [];

  for (const node of expandedNodes) {
    const candidate = makeCompactSection(compact, [...current, node], sections.length);
    if (current.length > 0 && JSON.stringify({ compactDocument: candidate }).length > sectionDocumentBudget) {
      sections.push(makeCompactSection(compact, current, sections.length));
      current = [node];
      continue;
    }
    current.push(node);
  }
  if (current.length > 0) sections.push(makeCompactSection(compact, current, sections.length));

  for (const [index, section] of sections.entries()) {
    const chars = compactPromptChars(section, systemPrompt);
    if (chars > maxInputChars) {
      warnings.push(`Section ${index + 1} prompt is ${chars} characters, still above LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS=${maxInputChars}.`);
    }
  }

  return { sections, sectionDocumentBudget, warnings };
}

async function runWholeDocumentLlmOnCompact(args: {
  document: CompactLeaseDocument;
  moduleType: ModuleType;
  fields: Array<[string, FieldDef]>;
  systemPrompt: string;
  startedAt: number;
  maxInputChars: number;
  provenance?: RunWholeDocumentLlmArgs["provenance"];
  operation: string;
  section?: { index: number; count: number } | null;
}): Promise<ExtractionPipelineResult> {
  const compact = args.document;
  const serializedDocument = JSON.stringify({ compactDocument: compact });
  const totalInputChars = args.systemPrompt.length + serializedDocument.length;
  if (totalInputChars > args.maxInputChars) {
    return failureResult(
      args.startedAt,
      `Whole-document prompt is ${totalInputChars} characters, above LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS=${args.maxInputChars}. No truncation was performed.`,
      {
        failure_classification: "whole_document_context_limit",
        compact_document: compact.diagnostics,
        serialized_document_chars: serializedDocument.length,
        system_prompt_chars: args.systemPrompt.length,
        total_input_chars: totalInputChars,
        max_input_chars: args.maxInputChars,
        ...(args.section ? { section_index: args.section.index, section_count: args.section.count } : {}),
      },
    );
  }
  const callOptions = {
    systemPrompt: args.systemPrompt,
    userPrompt: serializedDocument,
    temperature: 0,
    maxOutputTokens: maxWholeDocumentOutputTokens(),
    promptVersion: WHOLE_DOCUMENT_SCHEMA_VERSION,
    schemaName: WHOLE_DOCUMENT_SCHEMA_NAME,
    schema: buildWholeDocumentJsonSchema(args.fields),
  };

  const response = args.provenance
    ? await callLLMStructuredWithProvenance<WholeDocumentExtractionResponse>(
      args.provenance.supabaseAdmin,
      { ...args.provenance.context, operation: args.operation, chunkIndex: args.section?.index },
      callOptions,
    )
    : await callLLMStructured<WholeDocumentExtractionResponse>(callOptions);

  if (
    response.status !== "success" ||
    !Array.isArray(response.data?.claims) ||
    !Array.isArray(response.data?.notStatedFieldKeys) ||
    !Array.isArray(response.data?.dynamicFindings) ||
    !Array.isArray(response.data?.expenseRuleCandidates)
  ) {
    return failureResult(
      args.startedAt,
      response.errorMessage ?? response.refusalReason ?? `Whole-document structured call returned ${response.status}.`,
      {
        failure_classification: response.errorClassification ?? response.status,
        structured_status: response.status,
        model: response.model,
        response_id: response.responseId,
        input_tokens: response.inputTokens,
        output_tokens: response.outputTokens,
        compact_document: compact.diagnostics,
      },
    );
  }

  const extractedFields: Record<string, ExtractedField> = {};
  const validationErrors: ValidationError[] = [];
  const fieldStatuses: Record<string, string> = {};
  const evidenceAnchors: Array<Record<string, unknown>> = [];
  let evidenceVerifiedCount = 0;
  let needsReviewCount = 0;
  const claimsByField = new Map<string, WholeDocumentFieldResult>();
  const duplicateFieldKeys = new Set<string>();
  for (const claim of response.data.claims) {
    if (!claim || typeof claim.fieldKey !== "string") continue;
    if (claimsByField.has(claim.fieldKey)) {
      duplicateFieldKeys.add(claim.fieldKey);
      continue;
    }
    claimsByField.set(claim.fieldKey, claim);
  }
  const notStatedFieldKeys = new Set<string>();
  const duplicateNotStatedFieldKeys = new Set<string>();
  for (const fieldKey of response.data.notStatedFieldKeys) {
    if (notStatedFieldKeys.has(fieldKey)) duplicateNotStatedFieldKeys.add(fieldKey);
    notStatedFieldKeys.add(fieldKey);
  }

  for (const [fieldKey, def] of args.fields) {
    const fieldResult = claimsByField.get(fieldKey);
    const listedNotStated = notStatedFieldKeys.has(fieldKey);
    if (fieldResult && listedNotStated) {
      validationErrors.push({
        field: fieldKey,
        message: "Strict response returned the field in both claims and notStatedFieldKeys.",
        receivedValue: fieldResult.value,
        rowIndex: 0,
      });
      continue;
    }
    if (duplicateNotStatedFieldKeys.has(fieldKey)) {
      validationErrors.push({
        field: fieldKey,
        message: "Strict response returned the field more than once in notStatedFieldKeys.",
        receivedValue: null,
        rowIndex: 0,
      });
      continue;
    }
    if (!fieldResult) {
      if (listedNotStated) {
        fieldStatuses[fieldKey] = "not_stated";
        continue;
      }
      validationErrors.push({
        field: fieldKey,
        message: "Strict response omitted the field from both claims and notStatedFieldKeys.",
        receivedValue: null,
        rowIndex: 0,
      });
      continue;
    }
    if (duplicateFieldKeys.has(fieldKey)) {
      validationErrors.push({
        field: fieldKey,
        message: "Strict response returned the field more than once.",
        receivedValue: fieldResult.value,
        rowIndex: 0,
      });
      continue;
    }
    fieldStatuses[fieldKey] = fieldResult.status;

    if (fieldResult.status !== "found") {
      const evidence = verifyEvidence(fieldResult, compact);
      const uncertainField = uncertainFieldFromResult(fieldResult, evidence, compact);
      extractedFields[fieldKey] = uncertainField;
      needsReviewCount++;
      evidenceAnchors.push({
        field_key: fieldKey,
        source_text: fieldResult.sourceQuote,
        source_page: evidence.sourcePage,
        source_node_ids: fieldResult.sourceNodeIds,
        quote_verified: evidence.quoteVerified,
        node_ids_valid: evidence.nodeIdsValid,
        status: fieldResult.status,
        alternatives: fieldResult.alternatives ?? [],
      });
      continue;
    }
    if (fieldResult.value == null) {
      validationErrors.push({
        field: fieldKey,
        message: "Whole-document LLM returned status=found with a null value.",
        receivedValue: null,
        rowIndex: 0,
      });
      continue;
    }

    let typed = validateTypedValue(fieldResult.value, def);
    let valueCoercedFromRaw = false;
    if (!typed.valid && fieldResult.rawValue != null && fieldResult.rawValue !== fieldResult.value) {
      const rawTyped = validateTypedValue(fieldResult.rawValue, def);
      if (rawTyped.valid) {
        typed = rawTyped;
        valueCoercedFromRaw = true;
      }
    }
    if (!typed.valid) {
      validationErrors.push({
        field: fieldKey,
        message: `Whole-document LLM returned an invalid ${def.type}: ${typed.reason}`,
        receivedValue: fieldResult.value,
        rowIndex: 0,
      });
      continue;
    }

    const evidence = verifyEvidence(fieldResult, compact);
    const extracted = extractedFieldFromResult(fieldResult, typed.value, evidence);
    if (valueCoercedFromRaw || typed.value !== fieldResult.value) {
      (extracted as any).normalizationTrace = {
        original_value: fieldResult.value,
        raw_value: fieldResult.rawValue,
        normalized_value: typed.value,
        reason: valueCoercedFromRaw ? "coerced_from_raw_value" : "coerced_from_structured_value",
      };
    }
    extractedFields[fieldKey] = extracted;
    if (evidence.quoteVerified && evidence.nodeIdsValid) evidenceVerifiedCount++;
    if (extracted.requiresReview) needsReviewCount++;
    evidenceAnchors.push({
      field_key: fieldKey,
      source_text: fieldResult.sourceQuote,
      source_page: evidence.sourcePage,
      source_node_ids: fieldResult.sourceNodeIds,
      quote_verified: evidence.quoteVerified,
      node_ids_valid: evidence.nodeIdsValid,
      status: fieldResult.status,
    });
  }

  const dynamicResult = buildDynamicItems({
    findings: response.data.dynamicFindings,
    compact,
    fixedFieldKeys: new Set(args.fields.map(([fieldKey]) => fieldKey)),
  });
  const expenseRuleResult = buildExpenseRuleCandidates({
    candidates: response.data.expenseRuleCandidates,
    compact,
  });
  const record: ExtractedRecord = { rowIndex: 0, fields: extractedFields };
  const rows = flattenRecords([record], args.moduleType);
  computeDerivedFields(rows, args.moduleType);
  const fieldSnapshot = snapshotFieldMap([record]);
  const confidences = Object.values(extractedFields).map((field) => field.confidence);
  const nonNullFieldCount = Object.values(extractedFields)
    .filter((field) => field.value !== null && field.value !== undefined && field.value !== "")
    .length;
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100)
    : 0;

  return {
    rows,
    method: extractedFields && Object.keys(extractedFields).length > 0 ? "llm_only" : "fallback",
    warnings: compact.diagnostics.inputWasTruncated
      ? ["Whole-document LLM used a legacy/capped document because no full compact Azure artifact was available."]
      : [],
    validationErrors,
    customFieldSuggestions: dynamicResult.items.map((item) => ({
      field_name: item.field_key,
      field_label: item.label,
      field_type: item.value_type ?? "string",
      sample_values: item.value == null ? [] : [String(item.value)],
      confidence: item.confidence,
    })),
    metadata: {
      ruleFieldsExtracted: 0,
      tableFieldsExtracted: 0,
      llmFieldsExtracted: Object.keys(extractedFields).length,
      totalRecords: rows.length,
      avgConfidence,
      chunksProcessed: 1,
      processingTimeMs: Date.now() - args.startedAt,
      parsingMethod: (args.document as any)?.extraction_method ?? "text",
      charCount: compact.diagnostics.characterCount,
      extractionDebug: {
        extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
        merged_field_sources: fieldSnapshot,
        validated_field_values: fieldSnapshot,
        openai_fact_ledger: {
          extraction_mode: "whole_document_llm_v2",
          architecture: "llm_direct_schema",
          authoritative: true,
          typescript_field_mapping_used: false,
          llm_call_count: 1,
          schema_version: WHOLE_DOCUMENT_SCHEMA_VERSION,
          lease_schema_version: LEASE_SCHEMA_VERSION,
          model: response.model,
          response_id: response.responseId,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          max_output_tokens: maxWholeDocumentOutputTokens(),
          facts_extracted_count: Object.keys(extractedFields).length,
          facts_mapped_count: Object.keys(extractedFields).length,
          facts_unmapped_count: 0,
          mapped_non_null_field_count: nonNullFieldCount,
          invalid_or_omitted_claim_count: validationErrors.length,
          schema_field_count: args.fields.length,
          evidence_verified_count: evidenceVerifiedCount,
          needs_review_count: needsReviewCount,
          field_statuses: fieldStatuses,
          evidence_anchors: evidenceAnchors,
          dynamic_items: dynamicResult.items,
          dynamic_findings_returned_count: response.data.dynamicFindings.length,
          dynamic_items_published_count: dynamicResult.items.length,
          rejected_dynamic_findings: dynamicResult.rejected,
          expense_rule_candidates: expenseRuleResult.rules,
          expense_rule_candidates_returned_count: response.data.expenseRuleCandidates.length,
          expense_rule_candidates_published_count: expenseRuleResult.rules.length,
          rejected_expense_rule_candidates: expenseRuleResult.rejected,
          fixed_claims_returned_count: response.data.claims.length,
          not_stated_field_count: response.data.notStatedFieldKeys.length,
          compact_document: {
            source: compact.source,
            version: compact.version,
            serializedDocumentChars: serializedDocument.length,
            systemPromptChars: args.systemPrompt.length,
            totalInputChars,
            maxInputChars: args.maxInputChars,
            ...compact.diagnostics,
          },
          ...(args.section ? { section_index: args.section.index, section_count: args.section.count } : {}),
          bypassed_components: [
            "deterministic_domain_readiness",
            "section_router",
            "fact_field_mapper",
            "dynamic_rescue_mapper",
          ],
        },
      },
    } as any,
  };
}

function mergeSectionedWholeDocumentResults(args: {
  startedAt: number;
  parentCompact: CompactLeaseDocument;
  sectionResults: ExtractionPipelineResult[];
  sectionCount: number;
  sectionDocumentBudget: number;
  sectionWarnings: string[];
  fields: Array<[string, FieldDef]>;
  originalPromptChars: number;
  maxInputChars: number;
  deadlineExhausted?: boolean;
}): ExtractionPipelineResult {
  const candidatesByField = new Map<string, Array<Record<string, unknown>>>();
  const warnings = [...args.sectionWarnings];
  const validationErrors: ValidationError[] = [];
  const dynamicItems: any[] = [];
  const expenseRuleCandidates: any[] = [];
  let llmCallCount = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let sectionFailureCount = 0;

  if (args.deadlineExhausted) {
    validationErrors.push({
      field: "_document",
      message: "Sectioned whole-document LLM stopped before all sections completed to avoid the normalize worker deadline; extracted values are partial and require review.",
      receivedValue: null,
      rowIndex: 0,
    });
  }

  for (const [sectionIndex, result] of args.sectionResults.entries()) {
    warnings.push(...(result.warnings ?? []).map((warning) => `section ${sectionIndex + 1}: ${warning}`));
    validationErrors.push(...((result.validationErrors ?? []) as ValidationError[]));
    const debug = (result.metadata as any)?.extractionDebug?.openai_fact_ledger ?? {};
    llmCallCount += Number(debug.llm_call_count ?? 0) || 0;
    inputTokens += Number(debug.input_tokens ?? 0) || 0;
    outputTokens += Number(debug.output_tokens ?? 0) || 0;
    if (result.method === "fallback" || !Array.isArray(result.rows) || result.rows.length === 0) {
      sectionFailureCount++;
    }
    if (Array.isArray(debug.dynamic_items)) dynamicItems.push(...debug.dynamic_items);
    if (Array.isArray(debug.expense_rule_candidates)) {
      expenseRuleCandidates.push(...debug.expense_rule_candidates);
    }

    const row = result.rows?.[0] ?? {};
    const fieldSources = debug.merged_field_sources ?? {};
    const anchors = Array.isArray(debug.evidence_anchors) ? debug.evidence_anchors : [];
    for (const [fieldKey] of args.fields) {
      const value = row[fieldKey];
      if (!isMeaningfulValue(value)) continue;
      const source = fieldSources[fieldKey] ?? {};
      const anchor = anchors.find((item: any) => item?.field_key === fieldKey) ?? {};
      const candidate = {
        fieldKey,
        value,
        comparableValue: normalizeComparableValue(value),
        confidence: Math.max(0, Math.min(1, Number(source.confidence ?? 0))),
        sourceText: source.source_text ?? anchor.source_text ?? null,
        sourcePage: source.source_page ?? anchor.source_page ?? null,
        extractionStatus: source.extraction_status ?? "extracted",
        canonicalStatus: source.canonical_status ?? "extracted",
        resolutionState: source.resolution_state ?? "authoritative",
        requiresReview: Boolean(source.requires_review),
        sourceNodeIds: anchor.source_node_ids ?? [],
        sectionIndex: sectionIndex + 1,
      };
      const existing = candidatesByField.get(fieldKey) ?? [];
      existing.push(candidate);
      candidatesByField.set(fieldKey, existing);
    }
  }

  const mergedRecord: ExtractedRecord = { rowIndex: 0, fields: {} };
  const conflictFields: string[] = [];
  const fieldStatuses: Record<string, string> = {};
  const evidenceAnchors: Array<Record<string, unknown>> = [];
  let evidenceVerifiedCount = 0;
  let needsReviewCount = 0;

  for (const [fieldKey] of args.fields) {
    const candidates = candidatesByField.get(fieldKey) ?? [];
    if (candidates.length === 0) {
      fieldStatuses[fieldKey] = "not_stated_or_not_found_in_sections";
      continue;
    }
    const uniqueValues = new Map<string, Record<string, unknown>>();
    for (const candidate of candidates) {
      const key = String(candidate.comparableValue);
      const existing = uniqueValues.get(key);
      if (!existing || Number(candidate.confidence ?? 0) > Number(existing.confidence ?? 0)) {
        uniqueValues.set(key, candidate);
      }
    }
    if (uniqueValues.size > 1) {
      conflictFields.push(fieldKey);
      fieldStatuses[fieldKey] = "conflicting_across_sections";
      validationErrors.push({
        field: fieldKey,
        message: "Sectioned whole-document LLM found competing values in different document sections; value withheld for review.",
        receivedValue: Array.from(uniqueValues.values()).map((candidate) => candidate.value),
        rowIndex: 0,
      });
      const conflictCandidates = Array.from(uniqueValues.values()).map((candidate, index) => ({
        candidateId: `whole-document-sectioned:${fieldKey}:candidate:${index}`,
        fieldKey,
        rawValue: candidate.value,
        normalizedValue: candidate.value,
        source: "llm",
        confidence: candidate.confidence,
        evidenceIds: candidate.sourceNodeIds,
        sourceText: candidate.sourceText,
        sourcePage: candidate.sourcePage,
        sectionIndex: candidate.sectionIndex,
      }));
      (mergedRecord.fields as any)[fieldKey] = {
        value: null,
        source: "llm",
        confidence: Math.max(...conflictCandidates.map((candidate: any) => Number(candidate.confidence ?? 0))),
        extractionStatus: "conflict",
        canonicalStatus: "conflict",
        resolutionState: "unresolved",
        requiresReview: true,
        conflictCandidates,
        conflictCandidateIds: conflictCandidates.map((candidate: any) => candidate.candidateId),
      };
      needsReviewCount++;
      continue;
    }

    const selected = Array.from(uniqueValues.values())[0];
    const requiresReview = Boolean(selected.requiresReview);
    (mergedRecord.fields as any)[fieldKey] = {
      value: selected.value,
      source: "llm",
      confidence: Number(selected.confidence ?? 0),
      sourceText: selected.sourceText ?? undefined,
      sourcePage: selected.sourcePage ?? null,
      extractionStatus: selected.extractionStatus ?? "extracted",
      canonicalStatus: selected.canonicalStatus ?? "extracted",
      resolutionState: selected.resolutionState ?? "authoritative",
      requiresReview,
      wholeDocumentEvidence: {
        source_node_ids: selected.sourceNodeIds,
        section_index: selected.sectionIndex,
        sectioned_reduce: true,
      },
    } as ExtractedField;
    fieldStatuses[fieldKey] = String(selected.extractionStatus ?? "found");
    if (selected.sourceText && Array.isArray(selected.sourceNodeIds) && selected.sourceNodeIds.length > 0) evidenceVerifiedCount++;
    if (requiresReview) needsReviewCount++;
    evidenceAnchors.push({
      field_key: fieldKey,
      source_text: selected.sourceText,
      source_page: selected.sourcePage,
      source_node_ids: selected.sourceNodeIds,
      quote_verified: Boolean(selected.sourceText),
      node_ids_valid: Array.isArray(selected.sourceNodeIds) && selected.sourceNodeIds.length > 0,
      status: selected.extractionStatus,
      section_index: selected.sectionIndex,
    });
  }

  const rows = flattenRecords([mergedRecord], "lease");
  computeDerivedFields(rows, "lease");
  const fieldSnapshot = snapshotFieldMap([mergedRecord]);
  const confidences = Object.values(mergedRecord.fields).map((field: any) => Number(field.confidence ?? 0));
  const nonNullFieldCount = Object.values(mergedRecord.fields)
    .filter((field: any) => isMeaningfulValue(field.value))
    .length;
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((sum, value) => sum + value, 0) / confidences.length) * 100)
    : 0;
  const dynamicSuggestions = dynamicItems.map((item) => ({
    field_name: item.field_key,
    field_label: item.label,
    field_type: item.value_type ?? "string",
    sample_values: item.value == null ? [] : [String(item.value)],
    confidence: item.confidence,
  }));
  const dedupedExpenseRuleCandidates = Array.from(
    new Map(
      expenseRuleCandidates.map((rule) => [
        [
          normalizeExpenseCategory(rule?.expense_category),
          normalizeExpenseCategory(rule?.expense_subcategory),
          normalizeEvidenceText(String(rule?.exact_source_text || rule?.source_clause || "")),
        ].join("|"),
        rule,
      ]),
    ).values(),
  );

  return {
    rows,
    method: nonNullFieldCount > 0 ? "llm_only" : "fallback",
    warnings,
    validationErrors,
    customFieldSuggestions: dynamicSuggestions,
    metadata: {
      ruleFieldsExtracted: 0,
      tableFieldsExtracted: 0,
      llmFieldsExtracted: Object.keys(mergedRecord.fields).length,
      totalRecords: rows.length,
      avgConfidence,
      chunksProcessed: args.sectionCount,
      processingTimeMs: Date.now() - args.startedAt,
      parsingMethod: "azure_layout",
      charCount: args.parentCompact.diagnostics.characterCount,
      extractionDebug: {
        extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
        merged_field_sources: fieldSnapshot,
        validated_field_values: fieldSnapshot,
        openai_fact_ledger: {
          extraction_mode: "whole_document_llm_v2",
          architecture: "llm_sectioned_reduce",
          authoritative: true,
          typescript_field_mapping_used: false,
          llm_call_count: llmCallCount,
          schema_version: WHOLE_DOCUMENT_SCHEMA_VERSION,
          lease_schema_version: LEASE_SCHEMA_VERSION,
          input_tokens: inputTokens || null,
          output_tokens: outputTokens || null,
          max_output_tokens: maxWholeDocumentOutputTokens(),
          facts_extracted_count: Object.keys(mergedRecord.fields).length,
          facts_mapped_count: Object.keys(mergedRecord.fields).length,
          facts_unmapped_count: 0,
          mapped_non_null_field_count: nonNullFieldCount,
          invalid_or_omitted_claim_count: validationErrors.length,
          schema_field_count: args.fields.length,
          evidence_verified_count: evidenceVerifiedCount,
          needs_review_count: needsReviewCount,
          conflict_field_count: conflictFields.length,
          conflict_fields: conflictFields,
          section_count: args.sectionCount,
          section_failure_count: sectionFailureCount,
          section_deadline_exhausted: Boolean(args.deadlineExhausted),
          section_document_budget_chars: args.sectionDocumentBudget,
          original_prompt_chars: args.originalPromptChars,
          max_input_chars: args.maxInputChars,
          field_statuses: fieldStatuses,
          evidence_anchors: evidenceAnchors,
          dynamic_items: dynamicItems,
          dynamic_findings_returned_count: dynamicItems.length,
          dynamic_items_published_count: dynamicItems.length,
          expense_rule_candidates: dedupedExpenseRuleCandidates,
          expense_rule_candidates_returned_count: expenseRuleCandidates.length,
          expense_rule_candidates_published_count: dedupedExpenseRuleCandidates.length,
          compact_document: {
            source: args.parentCompact.source,
            version: args.parentCompact.version,
            totalInputChars: args.originalPromptChars,
            maxInputChars: args.maxInputChars,
            ...args.parentCompact.diagnostics,
          },
          bypassed_components: [
            "deterministic_domain_readiness",
            "section_router",
            "fact_field_mapper",
            "dynamic_rescue_mapper",
            "legacy_hybrid_fallback",
          ],
        },
      },
    } as any,
  };
}

async function runSectionedWholeDocumentLlmPipeline(args: {
  baseArgs: RunWholeDocumentLlmArgs;
  compact: CompactLeaseDocument;
  fields: Array<[string, FieldDef]>;
  systemPrompt: string;
  startedAt: number;
  maxInputChars: number;
  originalPromptChars: number;
}): Promise<ExtractionPipelineResult> {
  const { sections, sectionDocumentBudget, warnings } = buildCompactSections(args.compact, args.systemPrompt, args.maxInputChars);
  const maxChunks = maxSectionedWholeDocumentChunks();
  if (sections.length === 0) {
    return failureResult(args.startedAt, "Large-document sectioning produced no readable sections.", {
      failure_classification: "large_document_sectioning_empty",
      architecture: "llm_sectioned_reduce",
    });
  }
  if (sections.length > maxChunks) {
    return failureResult(
      args.startedAt,
      `Large-document LLM continuation requires ${sections.length} section calls, above LEASE_WHOLE_DOCUMENT_LLM_MAX_SECTION_CHUNKS=${maxChunks}.`,
      {
        failure_classification: "large_document_section_budget_exceeded",
        architecture: "llm_sectioned_reduce",
        section_count: sections.length,
        max_section_chunks: maxChunks,
        original_prompt_chars: args.originalPromptChars,
        max_input_chars: args.maxInputChars,
        compact_document: args.compact.diagnostics,
      },
    );
  }

  const sectionResults: ExtractionPipelineResult[] = [];
  let deadlineExhausted = false;
  for (const [index, section] of sections.entries()) {
    if (args.baseArgs.deadlineAt && Date.now() + sectionDeadlineReserveMs() > args.baseArgs.deadlineAt) {
      deadlineExhausted = true;
      warnings.push(
        `Stopped sectioned LLM continuation before section ${index + 1}/${sections.length} to avoid exceeding the normalize worker deadline.`,
      );
      break;
    }
    sectionResults.push(await runWholeDocumentLlmOnCompact({
      document: section,
      moduleType: args.baseArgs.moduleType,
      fields: args.fields,
      systemPrompt: args.systemPrompt,
      startedAt: args.startedAt,
      maxInputChars: args.maxInputChars,
      provenance: args.baseArgs.provenance,
      operation: "whole_document_lease_extraction_section_v2",
      section: { index: index + 1, count: sections.length },
    }));
  }

  if (sectionResults.length === 0) {
    return failureResult(args.startedAt, "Large-document LLM continuation had no safe time budget for section calls.", {
      failure_classification: "large_document_deadline_exhausted",
      architecture: "llm_sectioned_reduce",
      section_count: sections.length,
      original_prompt_chars: args.originalPromptChars,
      max_input_chars: args.maxInputChars,
    });
  }

  return mergeSectionedWholeDocumentResults({
    startedAt: args.startedAt,
    parentCompact: args.compact,
    sectionResults,
    sectionCount: sections.length,
    sectionDocumentBudget,
    sectionWarnings: warnings,
    fields: args.fields,
    originalPromptChars: args.originalPromptChars,
    maxInputChars: args.maxInputChars,
    deadlineExhausted,
  });
}

export async function runWholeDocumentLlmPipeline(
  args: RunWholeDocumentLlmArgs,
): Promise<ExtractionPipelineResult> {
  const startedAt = Date.now();
  if (!isLeaseModuleType(args.moduleType)) {
    return failureResult(startedAt, "Whole-document LLM mode currently supports lease documents only.", {
      failure_classification: "unsupported_module",
    });
  }

  const compact = buildCompactLeaseDocument(args.document);
  if (compact.nodes.length === 0 && compact.tables.length === 0 && compact.keyValues.length === 0) {
    return failureResult(startedAt, "Compact document contains no readable evidence.", {
      failure_classification: "empty_document",
      compact_document: compact.diagnostics,
    });
  }

  const schema = getSchema(args.moduleType);
  const fields = Object.entries(schema).filter(([, def]) => !(def as FieldDef).derived) as Array<[string, FieldDef]>;
  const systemPrompt = buildWholeDocumentSystemPrompt(fields);
  const maxInputChars = maxWholeDocumentPromptChars();
  const originalPromptChars = compactPromptChars(compact, systemPrompt);
  if (originalPromptChars > maxInputChars) {
    return await runSectionedWholeDocumentLlmPipeline({
      baseArgs: args,
      compact,
      fields,
      systemPrompt,
      startedAt,
      maxInputChars,
      originalPromptChars,
    });
  }

  return await runWholeDocumentLlmOnCompact({
    document: compact,
    moduleType: args.moduleType,
    fields,
    systemPrompt,
    startedAt,
    maxInputChars,
    provenance: args.provenance,
    operation: "whole_document_lease_extraction_v2",
    section: null,
  });
}

export const __test__ = {
  validateTypedValue,
  verifyEvidence,
  maxWholeDocumentPromptChars,
  maxWholeDocumentOutputTokens,
  normalizeDynamicFieldKey,
  validateDynamicValue,
  buildDynamicItems,
  buildExpenseRuleCandidates,
  buildCompactSections,
  mergeSectionedWholeDocumentResults,
};

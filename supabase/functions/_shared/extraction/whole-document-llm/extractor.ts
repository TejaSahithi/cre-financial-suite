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
  type WholeDocumentFieldResult,
} from "./whole-document-schema.ts";

export interface RunWholeDocumentLlmArgs {
  document: DoclingOutput | Record<string, unknown>;
  moduleType: ModuleType;
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
          facts_extracted_count: 0,
          facts_mapped_count: 0,
          ...diagnostics,
        },
      },
    } as any,
  };
}

function validateTypedValue(
  value: unknown,
  def: FieldDef,
): { valid: true; value: unknown } | { valid: false; reason: string } {
  if (value == null || value === "") return { valid: false, reason: "value is null or empty" };

  if (def.type === "string") {
    return typeof value === "string" && value.trim()
      ? { valid: true, value: value.trim() }
      : { valid: false, reason: "expected a non-empty string" };
  }
  if (def.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { valid: false, reason: "expected a finite number" };
    }
    if (def.min != null && value < def.min) return { valid: false, reason: `number is below minimum ${def.min}` };
    if (def.max != null && value > def.max) return { valid: false, reason: `number is above maximum ${def.max}` };
    return { valid: true, value };
  }
  if (def.type === "boolean") {
    return typeof value === "boolean"
      ? { valid: true, value }
      : { valid: false, reason: "expected a boolean" };
  }
  if (def.type === "enum") {
    return typeof value === "string" && (def.enumValues ?? []).includes(value)
      ? { valid: true, value }
      : { valid: false, reason: `expected one of: ${(def.enumValues ?? []).join(", ")}` };
  }
  if (def.type === "date") {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return { valid: false, reason: "expected an ISO date (YYYY-MM-DD)" };
    }
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
      ? { valid: true, value }
      : { valid: false, reason: "expected a real calendar date" };
  }
  return { valid: false, reason: `unsupported field type ${String((def as any).type)}` };
}

function normalizeEvidenceText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function verifyEvidence(
  result: WholeDocumentFieldResult,
  compact: CompactLeaseDocument,
): {
  quoteVerified: boolean;
  nodeIdsValid: boolean;
  sourcePage: number | null;
  evidenceErrors: string[];
} {
  const evidenceMap = compactDocumentEvidenceMap(compact);
  const nodeIds = Array.isArray(result.sourceNodeIds) ? result.sourceNodeIds : [];
  const validNodes = nodeIds.map((id) => evidenceMap.get(id)).filter(Boolean) as Array<{ text: string; page: number | null }>;
  const nodeIdsValid = nodeIds.length > 0 && validNodes.length === nodeIds.length;
  const quote = normalizeEvidenceText(String(result.sourceQuote ?? ""));
  const quoteVerified = !!quote && validNodes.some((node) => normalizeEvidenceText(node.text).includes(quote));
  const evidenceErrors: string[] = [];
  if (!nodeIdsValid) evidenceErrors.push("one or more sourceNodeIds do not exist in the compact document");
  if (!quoteVerified) evidenceErrors.push("sourceQuote was not found verbatim in the cited source nodes");
  return {
    quoteVerified,
    nodeIdsValid,
    sourcePage: validNodes.find((node) => node.page != null)?.page ?? null,
    evidenceErrors,
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

export async function runWholeDocumentLlmPipeline(
  args: RunWholeDocumentLlmArgs,
): Promise<ExtractionPipelineResult> {
  const startedAt = Date.now();
  if (args.moduleType !== "lease") {
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
  const serializedDocument = JSON.stringify({ compactDocument: compact });
  const systemPrompt = buildWholeDocumentSystemPrompt(fields);
  const totalInputChars = systemPrompt.length + serializedDocument.length;
  const maxInputChars = maxWholeDocumentPromptChars();
  if (totalInputChars > maxInputChars) {
    return failureResult(
      startedAt,
      `Whole-document prompt is ${totalInputChars} characters, above LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS=${maxInputChars}. No truncation was performed.`,
      {
        failure_classification: "whole_document_context_limit",
        compact_document: compact.diagnostics,
        serialized_document_chars: serializedDocument.length,
        system_prompt_chars: systemPrompt.length,
        total_input_chars: totalInputChars,
        max_input_chars: maxInputChars,
      },
    );
  }
  const callOptions = {
    systemPrompt,
    userPrompt: serializedDocument,
    temperature: 0,
    maxOutputTokens: maxWholeDocumentOutputTokens(),
    promptVersion: WHOLE_DOCUMENT_SCHEMA_VERSION,
    schemaName: WHOLE_DOCUMENT_SCHEMA_NAME,
    schema: buildWholeDocumentJsonSchema(fields),
  };

  const response = args.provenance
    ? await callLLMStructuredWithProvenance<WholeDocumentExtractionResponse>(
      args.provenance.supabaseAdmin,
      { ...args.provenance.context, operation: "whole_document_lease_extraction_v2" },
      callOptions,
    )
    : await callLLMStructured<WholeDocumentExtractionResponse>(callOptions);

  if (
    response.status !== "success" ||
    !Array.isArray(response.data?.claims) ||
    !Array.isArray(response.data?.notStatedFieldKeys) ||
    !Array.isArray(response.data?.dynamicFindings)
  ) {
    return failureResult(
      startedAt,
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

  for (const [fieldKey, def] of fields) {
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

    const typed = validateTypedValue(fieldResult.value, def);
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
    fixedFieldKeys: new Set(fields.map(([fieldKey]) => fieldKey)),
  });
  const record: ExtractedRecord = { rowIndex: 0, fields: extractedFields };
  const rows = flattenRecords([record], args.moduleType);
  computeDerivedFields(rows, args.moduleType);
  const fieldSnapshot = snapshotFieldMap([record]);
  const confidences = Object.values(extractedFields).map((field) => field.confidence);
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
      processingTimeMs: Date.now() - startedAt,
      parsingMethod: (args.document as any)?.extraction_method ?? "text",
      charCount: compact.diagnostics.characterCount,
      extractionDebug: {
        extraction_contract_version: EXTRACTION_CONTRACT_VERSION,
        merged_field_sources: fieldSnapshot,
        validated_field_values: fieldSnapshot,
        openai_fact_ledger: {
          extraction_mode: "whole_document_llm_v2",
          schema_version: WHOLE_DOCUMENT_SCHEMA_VERSION,
          lease_schema_version: LEASE_SCHEMA_VERSION,
          model: response.model,
          response_id: response.responseId,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          max_output_tokens: maxWholeDocumentOutputTokens(),
          facts_extracted_count: Object.keys(extractedFields).length,
          facts_mapped_count: Object.keys(extractedFields).length,
          evidence_verified_count: evidenceVerifiedCount,
          needs_review_count: needsReviewCount,
          field_statuses: fieldStatuses,
          evidence_anchors: evidenceAnchors,
          dynamic_items: dynamicResult.items,
          dynamic_findings_returned_count: response.data.dynamicFindings.length,
          dynamic_items_published_count: dynamicResult.items.length,
          rejected_dynamic_findings: dynamicResult.rejected,
          fixed_claims_returned_count: response.data.claims.length,
          not_stated_field_count: response.data.notStatedFieldKeys.length,
          compact_document: {
            source: compact.source,
            version: compact.version,
            serializedDocumentChars: serializedDocument.length,
            systemPromptChars: systemPrompt.length,
            totalInputChars,
            maxInputChars,
            ...compact.diagnostics,
          },
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

export const __test__ = {
  validateTypedValue,
  verifyEvidence,
  maxWholeDocumentPromptChars,
  maxWholeDocumentOutputTokens,
  normalizeDynamicFieldKey,
  validateDynamicValue,
  buildDynamicItems,
};

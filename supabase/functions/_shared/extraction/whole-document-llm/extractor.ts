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
          extraction_mode: "whole_document_llm_v1",
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
  const maxInputChars = maxWholeDocumentPromptChars();
  if (serializedDocument.length > maxInputChars) {
    return failureResult(
      startedAt,
      `Compact document is ${serializedDocument.length} characters, above LEASE_WHOLE_DOCUMENT_LLM_MAX_INPUT_CHARS=${maxInputChars}. No truncation was performed.`,
      {
        failure_classification: "whole_document_context_limit",
        compact_document: compact.diagnostics,
        serialized_document_chars: serializedDocument.length,
        max_input_chars: maxInputChars,
      },
    );
  }
  const callOptions = {
    systemPrompt: buildWholeDocumentSystemPrompt(fields),
    userPrompt: serializedDocument,
    temperature: 0,
    maxOutputTokens: 16384,
    promptVersion: WHOLE_DOCUMENT_SCHEMA_VERSION,
    schemaName: WHOLE_DOCUMENT_SCHEMA_NAME,
    schema: buildWholeDocumentJsonSchema(fields),
  };

  const response = args.provenance
    ? await callLLMStructuredWithProvenance<WholeDocumentExtractionResponse>(
      args.provenance.supabaseAdmin,
      { ...args.provenance.context, operation: "whole_document_lease_extraction_v1" },
      callOptions,
    )
    : await callLLMStructured<WholeDocumentExtractionResponse>(callOptions);

  if (response.status !== "success" || !Array.isArray(response.data?.claims)) {
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

  for (const [fieldKey, def] of fields) {
    const fieldResult = claimsByField.get(fieldKey);
    if (!fieldResult) {
      validationErrors.push({
        field: fieldKey,
        message: "Strict response omitted a required field envelope.",
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
    if (fieldResult.status === "not_stated" || fieldResult.value == null) continue;

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
          extraction_mode: "whole_document_llm_v1",
          schema_version: WHOLE_DOCUMENT_SCHEMA_VERSION,
          lease_schema_version: LEASE_SCHEMA_VERSION,
          model: response.model,
          response_id: response.responseId,
          input_tokens: response.inputTokens,
          output_tokens: response.outputTokens,
          facts_extracted_count: Object.keys(extractedFields).length,
          facts_mapped_count: Object.keys(extractedFields).length,
          evidence_verified_count: evidenceVerifiedCount,
          needs_review_count: needsReviewCount,
          field_statuses: fieldStatuses,
          evidence_anchors: evidenceAnchors,
          compact_document: {
            source: compact.source,
            version: compact.version,
            serializedDocumentChars: serializedDocument.length,
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
};

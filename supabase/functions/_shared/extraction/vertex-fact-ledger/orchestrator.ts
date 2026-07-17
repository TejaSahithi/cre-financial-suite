// @ts-nocheck
/**
 * Vertex Fact Ledger — Orchestrator
 *
 * runVertexFactLedgerPipeline() is the vertex_fact_ledger counterpart to
 * pipeline.ts's runExtractionPipeline() and MUST return the exact same
 * ExtractionPipelineResult shape ({rows, method, warnings, validationErrors,
 * metadata}), with metadata.extractionDebug.merged_field_sources /
 * .validated_field_values in the same per-field {value, source, confidence,
 * source_text, source_page} shape pipeline.ts's snapshotFieldMap() produces
 * (reused here, not reimplemented) — this is the contract that lets every
 * downstream consumer (buildMinimalReviewPayload, buildReviewPayload,
 * LeaseReview.jsx) work unchanged regardless of which provider ran.
 *
 * Prefers Azure canonical text extraction (input.docling, built upstream
 * from the Azure-parsed docling_raw) over file-mode Vertex calls — file mode
 * is only reachable through fact-ledger-extractor.ts's own opt-in flag.
 *
 * On any internal failure this degrades to {rows:[], method:"fallback", ...}
 * rather than throwing, exactly like runExtractionPipeline() does for
 * too-short documents.
 */

import type { DoclingOutput, ExtractionPipelineResult } from "../types.ts";
import { parseDocument } from "../parser.ts";
import { flattenRecords } from "../validator.ts";
import { computeDerivedFields } from "../calculator.ts";
import { snapshotFieldMap } from "../pipeline.ts";
import { resolveDocumentIndex, enrichFactWithBlockEvidence } from "./document-index-v3.ts";
import { classifyDocumentProfile } from "./profile-classifier.ts";
import { extractFactLedger } from "./fact-ledger-extractor.ts";
import { mapFactsToStandardFields } from "./fact-field-mapper.ts";
import { surfaceDynamicFacts } from "./dynamic-fact-surfacer.ts";
import { computeProfileApprovalBlockers } from "./approval-blockers.ts";
import type { VertexFactLedgerInput, VertexFactLedgerOptions } from "./types.ts";
import { VertexProviderError } from "../../vertex-ai.ts";

function emptyMetadata(processingTimeMs: number) {
  return {
    ruleFieldsExtracted: 0,
    tableFieldsExtracted: 0,
    llmFieldsExtracted: 0,
    totalRecords: 0,
    avgConfidence: 0,
    chunksProcessed: 0,
    processingTimeMs,
  };
}

function fallbackResult(
  warning: string,
  startTime: number,
  failureClassification?: string,
  failureHttpStatus?: number,
): ExtractionPipelineResult {
  return {
    rows: [],
    method: "fallback",
    warnings: [warning],
    validationErrors: [],
    metadata: {
      ...emptyMetadata(Date.now() - startTime),
      // Azure+Vertex Phase 4E: structured, not string-parsed, failure signal
      // for the business-extraction acceptance/fallback-eligibility layer.
      extractionDebug: {
        vertex_fact_ledger: {
          failure_classification: failureClassification ?? "unknown",
          failure_http_status: failureHttpStatus ?? null,
        },
      },
    },
  };
}

async function resolveDocling(input: VertexFactLedgerInput): Promise<DoclingOutput> {
  if (input.docling) return input.docling;

  if ((input.rawText ?? "").trim().length > 0) {
    const paragraphs = (input.rawText ?? "").split(/\n\s*\n/).filter((p) => p.trim().length > 0);
    return {
      text_blocks: paragraphs.map((text, i) => ({ block_index: i, type: "paragraph", text: text.trim() })),
      tables: [],
      fields: [],
      full_text: input.rawText,
    };
  }

  if (input.fileBase64) {
    const binaryString = atob(input.fileBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
    return await parseDocument(bytes, input.fileName || "document", input.fileMimeType || "application/pdf");
  }

  return { text_blocks: [], tables: [], fields: [], full_text: "" };
}

export async function runVertexFactLedgerPipeline(
  input: VertexFactLedgerInput,
  options: VertexFactLedgerOptions = {},
): Promise<ExtractionPipelineResult> {
  const startTime = Date.now();

  try {
    const doclingRaw = await resolveDocling(input);
    // Phase 6: opt-in canonical-layout-backed index (ENABLE_DOCUMENT_INTELLIGENCE_V3
    // only), falling straight back to the existing legacy_evidence_index path
    // (document-index.ts, untouched) on any failure. Default/flag-off
    // behavior is byte-for-byte what this line did before Phase 6.
    const indexResolution = await resolveDocumentIndex(doclingRaw);
    const docIndex = indexResolution.index;

    if (docIndex.fullText.trim().length < 10 && !input.fileBase64) {
      return fallbackResult("Document text is too short for extraction", startTime);
    }

    const profile = await classifyDocumentProfile({
      docIndex,
      documentSubtype: input.documentSubtype ?? null,
    });

    const factLedger = await extractFactLedger({
      docIndex,
      profile,
      moduleType: input.moduleType,
      fileBase64: input.fileBase64 ?? null,
      fileMimeType: input.fileMimeType ?? null,
      fileModeOverride: options.fileMode,
      deadlineAt: options.deadlineAt,
    });

    // Phase 6 Task E: when the canonical layout index was actually used,
    // enrich each fact with block-level evidence (never fabricated -- a
    // fact whose page/source_text doesn't match a real block gets empty
    // blockIds/polygon, exactly as if no enrichment had run). Facts
    // themselves (category/value/sourceText/sourcePage/confidence) are
    // unchanged either way, so mapping/dedup behavior downstream is
    // identical regardless of which index resolved.
    const canonicalLayoutForEnrichment =
      indexResolution.indexSource === "canonical_layout" ? (docIndex as any).canonicalLayout ?? null : null;
    const enrichedFacts = canonicalLayoutForEnrichment
      ? factLedger.facts.map((fact) => enrichFactWithBlockEvidence(fact, canonicalLayoutForEnrichment))
      : factLedger.facts;

    const mapped = mapFactsToStandardFields({
      facts: enrichedFacts,
      moduleType: input.moduleType,
    });

    const dynamicItems = surfaceDynamicFacts({
      unmappedFacts: mapped.unmappedFacts,
      docIndex,
      documentProfile: profile.documentProfile,
    });

    const approvalBlockers = computeProfileApprovalBlockers({
      profile: profile.documentProfile,
      standardFields: mapped.records[0] ?? null,
    });

    const flatRows = flattenRecords(mapped.records, input.moduleType);
    computeDerivedFields(flatRows, input.moduleType);

    const llmFieldsExtracted = Object.keys(mapped.records[0]?.fields || {}).length;
    const avgConfidence = flatRows.length > 0
      ? Math.round(flatRows.reduce((sum, r) => sum + ((r.confidence_score as number) || 0), 0) / flatRows.length)
      : 0;
    // "llm_only" only when facts actually mapped to standard fields — a
    // parsed-but-nothing-found row (e.g. Vertex unreachable, all chunks
    // failed) must not falsely report a successful LLM run.
    const method: ExtractionPipelineResult["method"] =
      flatRows.length > 0 && llmFieldsExtracted > 0 ? "llm_only" : "fallback";
    const fieldSnapshot = snapshotFieldMap(mapped.records as any[]);
    const processingTimeMs = Date.now() - startTime;

    return {
      rows: flatRows,
      method,
      warnings: factLedger.warnings,
      validationErrors: mapped.validationErrors,
      metadata: {
        ruleFieldsExtracted: 0,
        tableFieldsExtracted: 0,
        llmFieldsExtracted,
        totalRecords: flatRows.length,
        avgConfidence,
        chunksProcessed: factLedger.chunksProcessed,
        processingTimeMs,
        parsingMethod: doclingRaw.extraction_method || "text",
        charCount: docIndex.fullText.length,
        extractionDebug: {
          extraction_contract_version: "vertex-fact-ledger-v1",
          // Same shape/keys legacy_hybrid's pipeline.ts populates, so any
          // downstream consumer that reads these off metadata.extractionDebug
          // works unchanged regardless of provider.
          merged_field_sources: fieldSnapshot,
          validated_field_values: fieldSnapshot,
          vertex_fact_ledger: {
            document_profile: profile.documentProfile,
            document_profile_confidence: profile.confidence,
            document_profile_method: profile.method,
            facts_extracted_count: factLedger.facts.length,
            facts_mapped_count: llmFieldsExtracted,
            facts_unmapped_count: mapped.unmappedFacts.length,
            approval_blockers: approvalBlockers.blockers,
            dynamic_items: dynamicItems,
            // Phase 6 Task G: diagnostic-only, not read by any business logic.
            document_index_source: indexResolution.indexSource,
            document_index_fallback_reason: indexResolution.fallbackReason,
            // Azure+Vertex Phase 4E: structured failure signal, only present
            // when the chunk-aggregation in fact-ledger-extractor.ts decided
            // the document produced nothing usable overall (never set merely
            // because some individual chunks failed while others succeeded).
            ...(factLedger.failureClassification
              ? { failure_classification: factLedger.failureClassification, failure_http_status: factLedger.failureHttpStatus ?? null }
              : {}),
            // Phase 6 Task E: available whenever the canonical layout index
            // ran, so a future phase can persist block-level evidence into
            // document_claim_evidence without re-deriving it. Empty array
            // (not populated at all) when the legacy index was used, or when
            // enrichment found no block match for a given fact.
            evidence_anchors: canonicalLayoutForEnrichment
              ? enrichedFacts.map((fact) => ({
                category: fact.category,
                source_text: fact.sourceText,
                source_page: fact.sourcePage,
                block_ids: fact.blockIds,
                polygon: fact.polygon,
                support_type: fact.supportType,
              }))
              : [],
          },
        },
      },
    };
  } catch (error) {
    const classification = error instanceof VertexProviderError ? error.classification : undefined;
    const httpStatus = error instanceof VertexProviderError ? error.httpStatus : undefined;
    return fallbackResult(
      `Vertex fact ledger pipeline failed: ${(error as Error)?.message ?? error}`,
      startTime,
      classification,
      httpStatus,
    );
  }
}

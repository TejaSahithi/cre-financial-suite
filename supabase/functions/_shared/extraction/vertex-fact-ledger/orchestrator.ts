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
import { buildCanonicalDocumentIndex } from "./document-index.ts";
import { classifyDocumentProfile } from "./profile-classifier.ts";
import { extractFactLedger } from "./fact-ledger-extractor.ts";
import { mapFactsToStandardFields } from "./fact-field-mapper.ts";
import { surfaceDynamicFacts } from "./dynamic-fact-surfacer.ts";
import { computeProfileApprovalBlockers } from "./approval-blockers.ts";
import type { VertexFactLedgerInput, VertexFactLedgerOptions } from "./types.ts";

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

function fallbackResult(warning: string, startTime: number): ExtractionPipelineResult {
  return {
    rows: [],
    method: "fallback",
    warnings: [warning],
    validationErrors: [],
    metadata: emptyMetadata(Date.now() - startTime),
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
    const docIndex = buildCanonicalDocumentIndex(doclingRaw);

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
    });

    const mapped = mapFactsToStandardFields({
      facts: factLedger.facts,
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
    const method: ExtractionPipelineResult["method"] = flatRows.length === 0 ? "fallback" : "llm_only";
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
          },
        },
      },
    };
  } catch (error) {
    return fallbackResult(
      `Vertex fact ledger pipeline failed: ${(error as Error)?.message ?? error}`,
      startTime,
    );
  }
}

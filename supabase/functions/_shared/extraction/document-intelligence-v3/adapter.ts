// @ts-nocheck
/**
 * Document Intelligence v3 — Compatibility Adapter (Phase 1 scaffold)
 *
 * Builds a v3 contract *skeleton* from an existing uploaded_files row (and
 * optionally its linked leases row). This is a pure, read-only projection:
 *
 *   - it does not call any extraction provider and does not re-run parsing
 *   - it does not mutate its inputs
 *   - it does not write ui_review_payload or normalized_output
 *   - it is not imported by parse-document-azure, normalize-pdf-output, or
 *     LeaseReview.jsx — nothing in the live pipeline calls this yet
 *
 * Every v3-only section (claims, canonical_fields, clauses, ...) is left at
 * its Phase 1 empty default. Only identifiers and already-computed
 * parser/provider/debug metadata that already exists on the row are copied
 * in, per docs/document-intelligence-v3-baseline.md's Phase 1 scope.
 */

import {
  buildEmptyDocumentIntelligenceV3Contract,
  buildDocumentIntelligenceV3VersionMetadata,
} from "./contract.ts";
import type { DocumentIntelligenceV3Contract } from "./types.ts";

export interface UploadedFileLike {
  id?: string | null;
  org_id?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  module_type?: string | null;
  document_subtype?: string | null;
  status?: string | null;
  docling_raw?: Record<string, unknown> | null;
  normalized_output?: Record<string, unknown> | null;
  ui_review_payload?: Record<string, unknown> | null;
}

export interface LeaseLike {
  id?: string | null;
  org_id?: string | null;
}

export interface BuildDocumentIntelligenceV3SkeletonInput {
  uploadedFile: UploadedFileLike | null | undefined;
  lease?: LeaseLike | null;
}

function readDoclingMetadata(uploadedFile: UploadedFileLike | null): Record<string, unknown> {
  const metadata = uploadedFile?.docling_raw?._metadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
}

function readNormalizedMetadata(uploadedFile: UploadedFileLike | null): Record<string, unknown> {
  const metadata = uploadedFile?.normalized_output?.metadata;
  return metadata && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {};
}

function readPipelineMetadata(uploadedFile: UploadedFileLike | null): Record<string, unknown> {
  const payload = uploadedFile?.ui_review_payload as Record<string, unknown> | null | undefined;
  const metadata = payload?.metadata as Record<string, unknown> | undefined;
  const pipeline = metadata?.pipeline;
  return pipeline && typeof pipeline === "object" ? (pipeline as Record<string, unknown>) : {};
}

/**
 * Detects the business-extraction provider used for this row *without*
 * altering how normalize-pdf-output itself resolves it — this just reads
 * the already-persisted debug marker openai_fact_ledger's orchestrator
 * stamps onto metadata.extractionDebug.openai_fact_ledger when that
 * provider ran (see supabase/functions/_shared/extraction/openai-fact-ledger/
 * orchestrator.ts). Absence means legacy_hybrid ran, which is the default.
 */
function readExtractionProvider(uploadedFile: UploadedFileLike | null): string | null {
  const normalizedMetadata = readNormalizedMetadata(uploadedFile);
  const extractionDebug = normalizedMetadata.extractionDebug as Record<string, unknown> | undefined;
  return (extractionDebug?.openai_fact_ledger ?? extractionDebug?.vertex_fact_ledger) ? "openai_fact_ledger" : "legacy_hybrid";
}

function readLayoutProvider(uploadedFile: UploadedFileLike | null): string | null {
  const doclingMetadata = readDoclingMetadata(uploadedFile);
  if (typeof doclingMetadata.provider === "string") return doclingMetadata.provider;
  const extractionMethod = uploadedFile?.docling_raw?.extraction_method;
  return typeof extractionMethod === "string" ? extractionMethod : null;
}

/**
 * Builds a document_intelligence_v3 contract skeleton from an existing
 * uploaded_files row and (optionally) its linked leases row. Read-only:
 * takes no action beyond reading already-present fields off its inputs.
 */
export function buildDocumentIntelligenceV3Skeleton(
  input: BuildDocumentIntelligenceV3SkeletonInput,
): DocumentIntelligenceV3Contract {
  const uploadedFile = input?.uploadedFile ?? null;
  const lease = input?.lease ?? null;

  const doclingMetadata = readDoclingMetadata(uploadedFile);
  const pipelineMetadata = readPipelineMetadata(uploadedFile);

  const overrides: Partial<DocumentIntelligenceV3Contract> = {
    document: {
      document_id: uploadedFile?.id ?? null,
      uploaded_file_id: uploadedFile?.id ?? null,
      lease_id: lease?.id ?? null,
      org_id: uploadedFile?.org_id ?? lease?.org_id ?? null,
      file_name: uploadedFile?.file_name ?? null,
      mime_type: uploadedFile?.mime_type ?? null,
      module_type: uploadedFile?.module_type ?? null,
      document_subtype: uploadedFile?.document_subtype ?? null,
    },
    processing: {
      status: uploadedFile?.status ?? null,
      pipeline_job_id: null,
      started_at: typeof pipelineMetadata.started_at === "string" ? pipelineMetadata.started_at : null,
      finished_at: typeof pipelineMetadata.finished_at === "string" ? pipelineMetadata.finished_at : null,
      version: buildDocumentIntelligenceV3VersionMetadata({
        layout_provider: readLayoutProvider(uploadedFile),
        layout_api_version: typeof doclingMetadata.api_version === "string" ? doclingMetadata.api_version : null,
        extraction_provider: readExtractionProvider(uploadedFile),
      }),
    },
    layout: {
      provider: readLayoutProvider(uploadedFile),
      api_version: typeof doclingMetadata.api_version === "string" ? doclingMetadata.api_version : null,
      page_count: typeof uploadedFile?.docling_raw?.page_count === "number"
        ? (uploadedFile.docling_raw.page_count as number)
        : null,
      page_markers_present: typeof doclingMetadata.page_markers_present === "boolean"
        ? (doclingMetadata.page_markers_present as boolean)
        : null,
      page_mapping_coverage: typeof doclingMetadata.page_mapping_coverage === "number"
        ? (doclingMetadata.page_mapping_coverage as number)
        : null,
    },
  };

  return buildEmptyDocumentIntelligenceV3Contract(overrides);
}

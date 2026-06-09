// Shared lease extraction pipeline contract.
// Keep this small: it centralizes statuses, blocked payloads, and text-count
// guards without creating a parallel pipeline.

export const MIN_LEASE_TEXT_CHARS = 500;

export const PARSER_STATUSES = {
  COMPLETED: "parse_completed",
  EMPTY_TEXT: "parse_completed_empty_text",
  INSUFFICIENT_TEXT: "parse_completed_insufficient_text",
  FAILED: "parse_failed",
  TIMEOUT: "parse_timeout",
  OCR_REQUIRED: "parse_ocr_required",
  OCR_FAILED: "parse_ocr_failed",
} as const;

export const NORMALIZE_STATUSES = {
  COMPLETED: "normalize_completed",
  SKIPPED_EMPTY_PARSE: "normalize_skipped_empty_parse",
  FAILED: "normalize_failed",
} as const;

export const AI_STATUSES = {
  COMPLETED: "ai_completed",
  SKIPPED_PROVIDER_UNAVAILABLE: "ai_skipped_provider_unavailable",
  FAILED: "ai_failed",
  EMPTY_OUTPUT: "ai_empty_output",
} as const;

export const REVIEW_STATUSES = {
  READY: "review_ready",
  MANUAL_REQUIRED: "manual_review_required",
  BLOCKED: "blocked_pipeline_failure",
} as const;

export type ParserStatus = typeof PARSER_STATUSES[keyof typeof PARSER_STATUSES];
export type NormalizeStatus = typeof NORMALIZE_STATUSES[keyof typeof NORMALIZE_STATUSES];
export type AiStatus = typeof AI_STATUSES[keyof typeof AI_STATUSES];
export type PipelineReviewStatus = typeof REVIEW_STATUSES[keyof typeof REVIEW_STATUSES];

export interface PipelineCounts {
  full_text_chars?: number;
  page_count?: number | null;
  mapped_fields_count?: number;
  dynamic_terms_count?: number;
  source_backed_count?: number;
  lease_clauses_count?: number;
  expense_terms_count?: number;
  cam_terms_count?: number;
}

export interface PipelineMetadataInput extends PipelineCounts {
  parser_status?: ParserStatus | string | null;
  normalize_status?: NormalizeStatus | string | null;
  ai_status?: AiStatus | string | null;
  review_status?: PipelineReviewStatus | string | null;
  error_code?: string | null;
  error_message?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  total_duration_ms?: number | null;
  attempt?: number | null;
  provider_used?: string | null;
  docling_raw_present?: boolean;
  ocr_used?: boolean;
  warnings?: string[];
  stage?: string | null;
}

export function countTextChars(value: unknown): number {
  return String(value ?? "").replace(/\s+/g, " ").trim().length;
}

export function parserStatusForTextLength(length: number): ParserStatus {
  if (!Number.isFinite(length) || length <= 0) return PARSER_STATUSES.EMPTY_TEXT;
  if (length < MIN_LEASE_TEXT_CHARS) return PARSER_STATUSES.INSUFFICIENT_TEXT;
  return PARSER_STATUSES.COMPLETED;
}

export function isBlockingParserStatus(status: unknown): boolean {
  const blockingStatuses = new Set<string>([
    PARSER_STATUSES.EMPTY_TEXT,
    PARSER_STATUSES.INSUFFICIENT_TEXT,
    PARSER_STATUSES.FAILED,
    PARSER_STATUSES.TIMEOUT,
    PARSER_STATUSES.OCR_FAILED,
  ]);
  return blockingStatuses.has(String(status));
}

export function buildPipelineMetadata(input: PipelineMetadataInput = {}) {
  const now = new Date().toISOString();
  const startedAt = input.started_at ?? now;
  const finishedAt = input.finished_at ?? now;
  const duration =
    input.total_duration_ms ??
    (input.started_at ? Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)) : null);

  return {
    parser_status: input.parser_status ?? null,
    normalize_status: input.normalize_status ?? null,
    ai_status: input.ai_status ?? null,
    review_status: input.review_status ?? null,
    error_code: input.error_code ?? null,
    error_message: input.error_message ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
    total_duration_ms: duration,
    attempt: input.attempt ?? null,
    full_text_chars: input.full_text_chars ?? 0,
    page_count: input.page_count ?? null,
    mapped_fields_count: input.mapped_fields_count ?? 0,
    dynamic_terms_count: input.dynamic_terms_count ?? 0,
    source_backed_count: input.source_backed_count ?? 0,
    lease_clauses_count: input.lease_clauses_count ?? 0,
    expense_terms_count: input.expense_terms_count ?? 0,
    cam_terms_count: input.cam_terms_count ?? 0,
    provider_used: input.provider_used ?? null,
    docling_raw_present: input.docling_raw_present ?? false,
    ocr_used: input.ocr_used ?? false,
    warnings: Array.isArray(input.warnings) ? input.warnings : [],
    stage: input.stage ?? null,
  };
}

export function buildBlockedReviewPayload(opts: {
  fileId: string;
  fileName?: string | null;
  moduleType?: string | null;
  documentSubtype?: string | null;
  extractionMethod?: string | null;
  message: string;
  pipeline: PipelineMetadataInput;
}) {
  const pipeline = buildPipelineMetadata({
    review_status: REVIEW_STATUSES.BLOCKED,
    ...opts.pipeline,
  });
  const warnings = [opts.message, ...(pipeline.warnings ?? [])].filter(Boolean);

  return {
    schema_version: 2,
    file_id: opts.fileId,
    file_name: opts.fileName ?? "document",
    module_type: opts.moduleType ?? "leases",
    document_subtype: opts.documentSubtype ?? null,
    extraction_method: opts.extractionMethod ?? null,
    pipeline_method: "blocked_pipeline_failure",
    avg_confidence: 0,
    review_required: false,
    review_status: REVIEW_STATUSES.BLOCKED,
    records: [],
    rows: [],
    global_warnings: warnings,
    warnings,
    validation_errors: [],
    metadata: {
      totalRecords: 0,
      avgConfidence: 0,
      pipeline,
      extractionDebug: {
        ...pipeline,
        mapping_failure_reason: pipeline.error_code,
        core_mapping_failed: true,
      },
      extraction_debug: {
        ...pipeline,
        mapping_failure_reason: pipeline.error_code,
        core_mapping_failed: true,
      },
    },
    diagnostics: pipeline,
    built_at: new Date().toISOString(),
  };
}

export function mergePipelineIntoNormalizedOutput(
  existing: Record<string, unknown> | null | undefined,
  pipelineInput: PipelineMetadataInput,
  extra: Record<string, unknown> = {},
) {
  const existingMetadata =
    existing && typeof existing === "object" && typeof (existing as any).metadata === "object"
      ? ((existing as any).metadata as Record<string, unknown>)
      : {};
  const previousPipeline =
    existingMetadata.pipeline && typeof existingMetadata.pipeline === "object"
      ? (existingMetadata.pipeline as Record<string, unknown>)
      : {};
  const pipeline = buildPipelineMetadata({
    ...previousPipeline,
    ...pipelineInput,
  });

  return {
    ...(existing ?? {}),
    ...extra,
    metadata: {
      ...existingMetadata,
      pipeline,
      extractionDebug: {
        ...((existingMetadata.extractionDebug as Record<string, unknown>) ?? {}),
        ...pipeline,
      },
      extraction_debug: {
        ...((existingMetadata.extraction_debug as Record<string, unknown>) ?? {}),
        ...pipeline,
      },
    },
  };
}

export function extractPipelineMetadata(record: any): Record<string, unknown> {
  return (
    record?.normalized_output?.metadata?.pipeline ??
    record?.ui_review_payload?.metadata?.pipeline ??
    record?.docling_raw?._metadata?.pipeline ??
    record?.docling_raw?._metadata ??
    {}
  );
}

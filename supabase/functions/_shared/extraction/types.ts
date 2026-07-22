// @ts-nocheck
/**
 * Extraction Pipeline — Shared Types
 *
 * All interfaces used across the hybrid extraction pipeline.
 * Rule-based → Table-based → LLM fallback → Merge → Validate → Calculate
 */

// ── Source tracking ──────────────────────────────────────────────────────────

/** Where a field value was extracted from — determines merge priority */
export type ExtractionSource = "rule" | "table" | "llm";

/** Confidence tiers by source (rule > table > llm) */
export const SOURCE_CONFIDENCE: Record<ExtractionSource, number> = {
  rule: 0.95,
  table: 0.85,
  llm: 0.70,
};

// ── Core extraction types ────────────────────────────────────────────────────

/** A single extracted field with provenance */
export interface ExtractedField {
  value: unknown;
  source: ExtractionSource;
  confidence: number;
  sourceText?: string; // the raw text snippet this was extracted from
  sourcePage?: number | null; // page number in the source document, if known
  /** Set by candidate-decision.ts's evaluateCandidateForField() when this
   *  candidate's domain match was ambiguous ("needs_review") — the merge
   *  still accepted it (preserving pre-Release-1 merge behavior), but it's
   *  flagged for the rejected/needs-review candidate audit trail. */
  evidenceDecision?: "needs_review";
}

/** One extracted record (row) — a map of fieldName → ExtractedField */
export interface ExtractedRecord {
  fields: Record<string, ExtractedField>;
  rowIndex: number;
}

/** The final output of any extraction step */
export interface StepResult {
  records: ExtractedRecord[];
  warnings: string[];
  /** Optional structured diagnostics — populated by the LLM step so the
   *  pipeline can forward them into extractionDebug without reading logs. */
  diagnostics?: Record<string, unknown>;
}

// ── Provider-normalized Azure Document Intelligence input types ──────────────────────────────────────────────────────

export interface AzureDocumentTextBlock {
  block_index: number;
  type: string;    // "paragraph" | "heading" | "list_item" | etc.
  text: string;
  page?: number;
  /** Offset/length into the provider's full content string (provenance metadata only). */
  span?: { offset: number; length: number };
}

export interface AzureDocumentTable {
  table_index: number;
  headers: string[];
  rows: string[][];
  markdown?: string;
}

export interface AzureDocumentField {
  key: string;
  value: string;
  confidence?: number;
  page?: number;
  source_text?: string;
}

export interface AzureDocumentPage {
  page: number;
  text: string;
  fields?: AzureDocumentField[];
}

export interface AzureDocumentOutput {
  model_version?: string;
  page_count?: number;
  pages?: AzureDocumentPage[];
  text_blocks: AzureDocumentTextBlock[];
  tables: AzureDocumentTable[];
  fields: AzureDocumentField[];
  full_text?: string;
  extraction_method?: string;
  warnings?: string[];
  raw_response?: Record<string, unknown>;
}
/** @deprecated Compatibility alias for the former parser output shape. */
export type DoclingTextBlock = AzureDocumentTextBlock;
/** @deprecated Compatibility alias for the former parser output shape. */
export type DoclingTable = AzureDocumentTable;
/** @deprecated Compatibility alias for the former parser output shape. */
export type DoclingField = AzureDocumentField;
/** @deprecated Compatibility alias for the former parser output shape. */
export type DoclingPage = AzureDocumentPage;
/** @deprecated Compatibility alias for uploaded_files.docling_raw payloads. */
export type DoclingOutput = AzureDocumentOutput;
// ── Chunking types ───────────────────────────────────────────────────────────

export interface TextChunk {
  text: string;
  index: number;
  startPage?: number;
  endPage?: number;
  tokenEstimate: number;
}

// ── Pipeline types ───────────────────────────────────────────────────────────

export type ModuleType =
  | "property"
  | "lease"
  | "tenant"
  | "building"
  | "unit"
  | "expense"
  | "revenue"
  | "gl_account";

export interface ExtractionInput {
  document?: AzureDocumentOutput;
  /** @deprecated Use document. Kept for uploaded_files.docling_raw compatibility. */
  docling?: DoclingOutput;
  rawText?: string;        // backward compat — converted to minimal DoclingOutput
  fileBase64?: string;     // Base64 file contents for legacy compatibility paths
  fileMimeType?: string;   // MimeType for the Base64 file contents
  fileName: string;
  moduleType: ModuleType;
  suggestCustomFields?: boolean;
  /** P1.4: optional extraction-provenance identity, threaded unchanged from
   * business-extraction-orchestrator.ts down through pipeline.ts to
   * llm-extractor.ts's OpenAI call sites. Undefined for any caller that
   * doesn't have stage/run provenance (tests, non-lease modules, dry runs)
   * -- those keep calling the LLM exactly as before. */
  provenance?: {
    supabaseAdmin: any;
    context: import("./provenance/types.ts").ProvenanceContext;
  };
}

export interface ExtractionOptions {
  maxLLMChunks?: number;       // max chunks to send to LLM (default: 6)
  chunkSize?: number;          // target tokens per chunk (default: 1500)
  llmTemperature?: number;     // 0 = deterministic (default: 0)
  skipLLM?: boolean;           // skip LLM step entirely
  confidenceThreshold?: number; // min confidence to accept a value (default: 0.4)
}

export interface ValidationError {
  field: string;
  message: string;
  receivedValue: unknown;
  rowIndex: number;
}

export interface ExtractionPipelineResult {
  rows: Record<string, unknown>[];
  method: "hybrid" | "rule_only" | "table_only" | "llm_only" | "fallback";
  warnings: string[];
  validationErrors: ValidationError[];
  metadata: {
    ruleFieldsExtracted: number;
    tableFieldsExtracted: number;
    llmFieldsExtracted: number;
    totalRecords: number;
    avgConfidence: number;
    chunksProcessed: number;
    processingTimeMs: number;
  };
  customFieldSuggestions?: Array<{
    field_name: string;
    field_label: string;
    field_type: string;
    sample_values: string[];
    confidence: number;
  }>;
}

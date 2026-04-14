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
}

// ── Docling input types ──────────────────────────────────────────────────────

export interface DoclingTextBlock {
  block_index: number;
  type: string;    // "paragraph" | "heading" | "list_item" | etc.
  text: string;
  page?: number;
}

export interface DoclingTable {
  table_index: number;
  headers: string[];
  rows: string[][];
  markdown?: string;
}

export interface DoclingField {
  key: string;
  value: string;
  confidence?: number;
  page?: number;
}

export interface DoclingOutput {
  model_version?: string;
  page_count?: number;
  text_blocks: DoclingTextBlock[];
  tables: DoclingTable[];
  fields: DoclingField[];
  full_text?: string;
  raw_response?: Record<string, unknown>;
}

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
  docling?: DoclingOutput;
  rawText?: string;        // backward compat — converted to minimal DoclingOutput
  fileName: string;
  moduleType: ModuleType;
  suggestCustomFields?: boolean;
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

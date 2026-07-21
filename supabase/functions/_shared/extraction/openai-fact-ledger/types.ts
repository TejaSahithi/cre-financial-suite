// @ts-nocheck
/**
 * OpenAI Fact Ledger — Shared Types
 *
 * Types for the `BUSINESS_EXTRACTION_PROVIDER=openai_fact_ledger` pipeline.
 * This provider is an alternate path alongside `legacy_hybrid` (pipeline.ts);
 * it must not change any legacy_hybrid types or behavior.
 */

import type { DoclingOutput, ExtractedRecord, ModuleType } from "../types.ts";
import type { EvidenceIndex } from "../evidence-index.ts";

// ── Canonical document index ─────────────────────────────────────────────────

/** Thin, read-only view over a docling_raw document used by every downstream
 *  openai-fact-ledger module — built once per document by document-index.ts. */
export interface CanonicalDocumentIndex {
  fullText: string;
  pageCount: number | null;
  evidenceIndex: EvidenceIndex;
  /** First N + last M chars of fullText, precomputed for classifier prompts. */
  headTailExcerpt: string;
  /** The normalized docling_raw object this index was built from — kept so
   *  fact-ledger-extractor.ts can chunk via chunker.ts's chunkDocument()
   *  with real per-block page tracking instead of reimplementing it. */
  doclingRaw: DoclingOutput | Record<string, unknown>;
}

// ── Document profile classification ──────────────────────────────────────────

export type DocumentProfile =
  | "full_lease"
  | "assignment"
  | "amendment"
  | "assignment_amendment"
  | "abstract"
  | "addendum"
  | "exhibit";

export interface DocumentProfileClassification {
  documentProfile: DocumentProfile;
  confidence: number;
  /** "openai" when the OpenAI classifier call succeeded, "regex_fallback"
   *  when it fell back to lease-workflow.ts's detectDocumentProfileSignals(). */
  method: "openai" | "regex_fallback";
  reasoning?: string | null;
}

// ── Fact ledger ───────────────────────────────────────────────────────────────

/** A single atomic fact extracted from the document, grounded in real
 *  source text. Facts with no real sourceText are dropped before this
 *  type is ever constructed (see fact-ledger-extractor.ts). */
export interface Fact {
  /** e.g. "tenant_name", or "clause:rent_escalation" for the 34-category
   *  clause vocabulary CLAUSE_DEFINITIONS (lease-workflow.ts) already uses. */
  category: string;
  value: unknown;
  sourceText: string;
  sourcePage: number | null;
  confidence: number;
}

export interface FactLedgerResult {
  facts: Fact[];
  warnings: string[];
  chunksProcessed: number;
  /** Structured classification of the LAST provider failure encountered
   *  (if any) across all chunks/file-mode calls — set alongside `warnings`,
   *  never inferred later by parsing the warning text. Undefined when no
   *  provider call failed. See LLMFailureClassification in llm.ts. */
  failureClassification?: import("../../llm.ts").LLMFailureClassification;
  failureHttpStatus?: number;
}

// ── Field mapping ─────────────────────────────────────────────────────────────

/** A candidate the domain-aware decision engine rejected or flagged before
 *  it could populate a field — the Release-1 audit trail. No DB table yet;
 *  carried in extractionDebug so it's visible today (ExtractionDebugPanel)
 *  and forward-compatible with document_validation_drops (same shape). */
export interface RejectedCandidate {
  field_key: string;
  candidate_value: unknown;
  candidate_category: string;
  decision: string;
  reason: string;
  source_page: number | null;
  source_text: string;
}

export interface FactFieldMappingResult {
  records: ExtractedRecord[];
  validationErrors: import("../types.ts").ValidationError[];
  /** Facts that did not map to any LEASE_SCHEMA field — passed through to
   *  dynamic-fact-surfacer.ts unchanged. */
  unmappedFacts: Fact[];
  /** Facts the domain-aware decision engine hard-rejected for a field their
   *  own labels/keywords would otherwise have matched. */
  rejectedCandidates: RejectedCandidate[];
}

// ── Approval blockers (backend-only, advisory in this pass) ─────────────────

export interface ApprovalBlocker {
  fieldKey: string;
  label: string;
  reason: "missing" | "unverified";
}

export interface ProfileApprovalBlockersResult {
  documentProfile: DocumentProfile;
  blockers: ApprovalBlocker[];
}

// ── Orchestrator input (mirrors ExtractionInput from ../types.ts) ───────────

export interface OpenAIFactLedgerInput {
  document?: DoclingOutput;
  /** @deprecated Use document. */
  docling?: DoclingOutput;
  rawText?: string;
  fileBase64?: string;
  fileMimeType?: string;
  fileName: string;
  moduleType: ModuleType;
  suggestCustomFields?: boolean;
  documentSubtype?: string | null;
}

export type VertexFactLedgerInput = OpenAIFactLedgerInput;

export interface OpenAIFactLedgerOptions {
  /** Opt-in only, default false. Mirrors NORMALIZE_INLINE_ENRICHMENT's
   *  opt-in-flag convention. When false, extraction stays text-mode
   *  against docIndex.fullText (built from the Azure-parsed docling_raw). */
  fileMode?: boolean;
  maxChunks?: number;
  /** Absolute epoch-ms deadline forwarded to every OpenAI call
   *  this pipeline run makes. See OpenAI request deadline handling. */
  deadlineAt?: number;
}

export type VertexFactLedgerOptions = OpenAIFactLedgerOptions;

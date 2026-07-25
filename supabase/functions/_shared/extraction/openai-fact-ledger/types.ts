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
import type { CanonicalDocumentLayout } from "../document-intelligence-v3/canonical-layout.ts";

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
  chunkIndex?: number;
  sourceOffset?: number | null;
}

export interface FactLedgerResult {
  facts: Fact[];
  warnings: string[];
  chunksProcessed: number;
  chunksTotal?: number;
  chunksSucceeded?: number;
  chunksFailed?: number;
  chunksTruncated?: boolean;
  failedChunkIndexes?: number[];
  partialResult?: boolean;
  peakConcurrency?: number;
  continuationRequired?: boolean;
  continuationReason?: string | null;
  nextChunkIndex?: number | null;
  /** Structured classification of the LAST provider failure encountered
   *  (if any) across all chunks/file-mode calls — set alongside `warnings`,
   *  never inferred later by parsing the warning text. Undefined when no
   *  provider call failed. See LLMFailureClassification in llm.ts. */
  failureClassification?: import("../../llm.ts").LLMFailureClassification;
  failureHttpStatus?: number;
  /** Provider's own error code (e.g. Azure's "DeploymentNotFound" /
   *  "ResourceNotFound"), the exact request URL (no secrets), and the
   *  provider's request ID — captured alongside failureClassification for
   *  the same last-failing call. See LLMProviderError in llm.ts. */
  failureProviderErrorCode?: string;
  failureRequestId?: string;
  failureRequestUrl?: string;
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
  /** Micro-step 0 (pipeline-audit provenance): per-field selection
   *  provenance for a bounded set of high-value fields (see
   *  TRACKED_PROVENANCE_FIELDS in fact-field-mapper.ts). Purely additive and
   *  optional — absent/undefined must be treated identically to "no
   *  provenance available" by every consumer, and this must never become a
   *  required property. Does not affect which fact wins a field; it only
   *  explains why. */
  fieldProvenance?: Record<string, FieldSelectionProvenance>;
}

// ── Micro-step 0: field selection provenance (additive, diagnostic-only) ────
// See LEASE_EXTRACTION_UI_PIPELINE_AUDIT.md Section 16.3 for the design this
// implements. Every type here is additive — nothing here changes what value
// a field resolves to; it only explains the decision that already happened.

/** Which extraction pipeline produced a field's winning value. This module
 *  (fact-field-mapper.ts) is only ever invoked from the openai_fact_ledger
 *  orchestrator, so every FieldSelectionProvenance this module builds is
 *  stamped "openai_fact_ledger" — the other pipelinePath values are reserved
 *  for a future pass that instruments the legacy_hybrid pipeline
 *  (rule-extractor.ts/llm-extractor.ts), which this Micro-step does not
 *  touch. */
export type FieldPipelinePath =
  | "openai_fact_ledger"
  | "legacy_rule"
  | "legacy_targeted_llm"
  | "table_extraction"
  | "derived"
  | "unknown";

/** Explicit accept/reject explanation for looksLikeFieldCompatibleFact's
 *  per-field value-shape guard (fact-field-mapper.ts). `guard` names which
 *  field's guard block evaluated the candidate; `reasons` are the specific
 *  condition(s) that fired. `guard: null` means no guard is configured for
 *  this field at all (an intentional finding in itself — see the original
 *  audit's ti_allowance/tenant_signatory_name/electric_responsibility gaps). */
export interface FieldGuardDecision {
  passed: boolean;
  guard: string | null;
  reasons: string[];
}

/** A candidate value considered for a field, trimmed for payload-size safety
 *  (sourceText capped, see CANDIDATE_SOURCE_TEXT_MAX_CHARS in
 *  fact-field-mapper.ts). */
export interface FieldCandidateSummary {
  value: unknown;
  sourceText: string | null;
  sourcePage: number | null;
  chunkIndex: number | null;
  mapperScore: number | null;
  modelConfidence: number | null;
}

export interface FieldRejectedCandidateSummary extends FieldCandidateSummary {
  rejectionReason: string | null;
}

/** Backend answer to "why did this candidate win?" — as distinct from
 *  FieldDisplayResolutionProvenance (frontend, "why is this value the one
 *  displayed?"), per the Micro-step 0 design's guardrail #5. */
export interface FieldSelectionProvenance {
  fieldKey: string;
  pipelinePath: FieldPipelinePath;
  chunkIndex: number | null;
  clauseCategory: string | null;
  /** Raw CandidateDecision from candidate-decision.ts's
   *  evaluateCandidateForField ("accept" | "reject" | "needs_review" |
   *  "unconstrained") for the WINNING candidate specifically. */
  clauseCategoryDecision: string | null;
  clauseCategoryAllowed: boolean | null;
  clauseCategoryReasons: string[];
  mapperScore: number | null;
  matchedLabels: string[];
  shapeGuard: FieldGuardDecision;
  /** Kept deliberately separate from mapperScore/ruleConfidence — a fact-
   *  ledger LLM's self-reported 0-1 confidence is not the same scale as a
   *  rule-extractor's hardcoded 0.88/0.92/0.98 or the mapper's integer
   *  keyword score. This Micro-step does not compute a blended
   *  "finalConfidence"; that conflation is exactly what the original audit
   *  flagged as a gap (Section 11), not something to reproduce here. */
  modelConfidence: number | null;
  ruleConfidence: number | null;
  validationStatus: "accepted" | "rejected" | "warning" | "not_run" | "unknown";
  selected: FieldCandidateSummary;
  /** Capped at 5 — see CANDIDATE_LIST_MAX_LENGTH in fact-field-mapper.ts. */
  competingCandidates: FieldCandidateSummary[];
  /** Capped at 5. */
  rejectedCandidates: FieldRejectedCandidateSummary[];
  // Present only when pipelinePath === "derived" (e.g. annual_rent).
  derivedFromField?: string | null;
  derivedFromValue?: unknown;
  parentSourcePath?: string | null;
  parentValidationStatus?: string | null;
  parentGenerationId?: string | null;
  derivationExpression?: string | null;
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

export interface FactLedgerResumeState {
  startChunkIndex?: number;
  priorFacts?: Fact[];
  chunksProcessed?: number;
  chunksSucceeded?: number;
  chunksFailed?: number;
  failedChunkIndexes?: number[];
}

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
  canonicalLayout?: CanonicalDocumentLayout | null;
}

export type VertexFactLedgerInput = OpenAIFactLedgerInput;

export interface OpenAIFactLedgerOptions {
  /** Opt-in only, default false. Mirrors NORMALIZE_INLINE_ENRICHMENT's
   *  opt-in-flag convention. When false, extraction stays text-mode
   *  against docIndex.fullText (built from the Azure-parsed docling_raw). */
  fileMode?: boolean;
  maxChunks?: number;
  onProgress?: (progress: Record<string, unknown>) => Promise<void> | void;
  /** Absolute epoch-ms deadline forwarded to every OpenAI call
   *  this pipeline run makes. See OpenAI request deadline handling. */
  deadlineAt?: number;
  /** P1.4-style extraction-provenance identity, forwarded to every OpenAI
   *  call this pipeline run makes so provider_invocations rows get recorded
   *  for the openai_fact_ledger path exactly as they already do for
   *  legacy_hybrid's llm-extractor.ts calls. Undefined for callers without
   *  stage/run provenance -- extraction behavior is identical either way,
   *  callLLMJSONWithProvenance falls back to a plain call. */
  provenance?: {
    supabaseAdmin: any;
    context: import("../provenance/types.ts").ProvenanceContext;
  };
}

export type VertexFactLedgerOptions = OpenAIFactLedgerOptions;

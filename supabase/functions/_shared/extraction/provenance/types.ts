// @ts-nocheck
/**
 * Extraction Provenance — shared types (P1.3)
 *
 * StageOutputSummary is bounded and non-sensitive by contract: never full
 * document text, source clauses, raw provider responses, prompts, signed
 * URLs, authorization headers, or personal names/addresses. recorder.ts
 * enforces a serialized-size cap on top of this type-level restriction.
 */

export type ExtractionStage = "parse" | "normalize" | "enrich";

export type StageOutcome =
  | "completed"
  | "manual_review"
  | "retryable_failure"
  | "terminal_failure"
  | "superseded";

export interface ExtractionStageContext {
  orgId: string;
  uploadedFileId: string;
  generationId: string;
  /** extraction_runs.id -- maps to the recorder RPCs' p_run_id parameter. */
  extractionRunId: string | null;
  pipelineJobId?: string;
  stage: ExtractionStage;
  /** Informational/for logging only -- the RPC derives the real attempt
   * number server-side (MAX(attempt)+1 for this run+stage); this is never
   * passed to start_extraction_stage_run as an authority. */
  attempt: number;
}

export interface StageOutputSummary {
  outcome?: StageOutcome;
  fieldsProduced?: number;
  evidenceProduced?: number;
  pageCount?: number;
  providerCalls?: number;
  workflowOutputPresent?: boolean;
  uiReviewPayloadPresent?: boolean;
  [key: string]: unknown;
}

export interface StageHandle {
  readonly stageRunId: string | null;
  readonly enabled: boolean;

  complete(summary?: StageOutputSummary): Promise<void>;

  fail(
    errorCode: string,
    sanitizedMessage: string,
    summary?: StageOutputSummary,
  ): Promise<void>;

  ensureSettled(): Promise<void>;
}

/**
 * P1.4 — passed from a stage handler down to a provider transport wrapper.
 * High-level extractors (llm-extractor.ts, fact-ledger-extractor.ts, etc.)
 * only ever construct and pass this; they never call the recorder's
 * insert/update logic directly. `providerAttempt` is transport-specific
 * (defaults to 1) -- it's the caller's responsibility to increment it for
 * a genuinely new attempt (a new HTTP call the caller's own retry logic
 * decides to make), never inferred by the transport wrapper itself, since
 * the wrapper has no visibility into why a second call is happening.
 */
export interface ProvenanceContext {
  orgId: string;
  uploadedFileId: string;
  generationId: string;
  extractionRunId: string | null;
  stageRunId: string | null;
  stageAttempt: number;
  operation: string;
  chunkIndex?: number;
  providerAttempt?: number;
}

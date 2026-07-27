// @ts-nocheck
/**
 * Per-stage telemetry for the bounded enrich chain (see
 * FAILED_EXTRACTION_ROOT_CAUSE.md and the "Bounded Per-Domain Enrich
 * Refactor" plan). Pure data -- never secrets, never full LLM prompts --
 * intended for pipeline_jobs.metadata (an existing, legitimately-used-for-
 * bookkeeping column) and the bounded_stage_results entry itself.
 *
 * Deno does not expose precise heap/RSS stats cheaply from inside a request
 * handler; Deno.memoryUsage() (when available) is recorded as a best-effort,
 * directional signal only, never presented as a precise measurement. Byte
 * counts of the actual serialized input/output are the more reliable proxy
 * this module leans on.
 */

export interface BoundedStageTelemetry {
  stage: string;
  stage_version: string;
  generation_id: string | null;
  input_bytes: number | null;
  output_bytes: number | null;
  page_count: number | null;
  table_count: number | null;
  candidate_count: number | null;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  reused_from_cache: boolean;
  split_count: number;
  error_code: string | null;
  /** Best-effort, approximate -- absent when Deno.memoryUsage() is unavailable. */
  memory_usage_rss_bytes?: number | null;
}

function safeByteLength(value: unknown): number | null {
  if (value == null) return 0;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return null;
  }
}

function safeMemoryUsage(): number | null {
  try {
    return typeof Deno !== "undefined" && typeof (Deno as any).memoryUsage === "function"
      ? (Deno as any).memoryUsage().rss ?? null
      : null;
  } catch {
    return null;
  }
}

export function startBoundedStageTelemetry(args: { stage: string; stageVersion: string; generationId: string | null; input?: unknown }) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  const inputBytes = safeByteLength(args.input);
  return {
    finish(finishArgs: {
      output?: unknown;
      pageCount?: number | null;
      tableCount?: number | null;
      candidateCount?: number | null;
      reusedFromCache?: boolean;
      splitCount?: number;
      errorCode?: string | null;
    } = {}): BoundedStageTelemetry {
      const completedAt = new Date().toISOString();
      return {
        stage: args.stage,
        stage_version: args.stageVersion,
        generation_id: args.generationId,
        input_bytes: inputBytes,
        output_bytes: safeByteLength(finishArgs.output),
        page_count: finishArgs.pageCount ?? null,
        table_count: finishArgs.tableCount ?? null,
        candidate_count: finishArgs.candidateCount ?? null,
        started_at: startedAt,
        completed_at: completedAt,
        duration_ms: Date.now() - startedAtMs,
        reused_from_cache: !!finishArgs.reusedFromCache,
        split_count: finishArgs.splitCount ?? 0,
        error_code: finishArgs.errorCode ?? null,
        memory_usage_rss_bytes: safeMemoryUsage(),
      };
    },
  };
}

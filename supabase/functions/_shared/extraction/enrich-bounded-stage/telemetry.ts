// @ts-nocheck
/**
 * Per-stage telemetry for the bounded enrich chain (see
 * docs/lease-extraction-architecture-audit-2026-07-29.md and the "Bounded Per-Domain Enrich
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

/**
 * Approximate payload size for telemetry, WITHOUT materialising a copy of the
 * payload.
 *
 * This previously did `new TextEncoder().encode(JSON.stringify(value)).length`
 * on the stage input AND the stage output. For a bounded enrich stage that is
 * ~3x peak memory for a number nobody calculates with: the payload itself,
 * plus a full JSON string copy of it, plus a full Uint8Array copy of that
 * string — all inside a worker that is already holding the document. It also
 * grows with the pipeline: each successive enrich_evidence_* stage carries a
 * larger accumulated payload, so the later stages serialise the most, which
 * matches the production failure landing on the third domain stage while the
 * first two complete.
 *
 * Measuring is now opt-in. When
 * LEASE_ENRICH_STAGE_TELEMETRY_MEASURE_BYTES is not enabled the function
 * returns null, which the emitted contract already allows and documents as
 * "best-effort, approximate -- absent when unavailable". Nothing downstream
 * computes with these values; they are diagnostics.
 */
function safeByteLength(value: unknown): number | null {
  if (value == null) return 0;
  const measure =
    (Deno.env.get("LEASE_ENRICH_STAGE_TELEMETRY_MEASURE_BYTES") ?? "").trim()
      .toLowerCase();
  if (measure !== "1" && measure !== "true") return null;
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return null;
  }
}

function safeMemoryUsage(): number | null {
  try {
    return typeof Deno !== "undefined" &&
        typeof (Deno as any).memoryUsage === "function"
      ? (Deno as any).memoryUsage().rss ?? null
      : null;
  } catch {
    return null;
  }
}

export function startBoundedStageTelemetry(
  args: {
    stage: string;
    stageVersion: string;
    generationId: string | null;
    input?: unknown;
  },
) {
  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  // Copy only tiny scalar identifiers into the returned closure. Keeping the
  // original args object alive can retain large input payloads such as
  // docling_raw.text_blocks for the duration of the stage, exactly when the
  // worker is building large evidence-domain outputs.
  const stage = args.stage;
  const stageVersion = args.stageVersion;
  const generationId = args.generationId;
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
        stage,
        stage_version: stageVersion,
        generation_id: generationId,
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

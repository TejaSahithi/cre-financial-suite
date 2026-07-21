// @ts-nocheck
/**
 * Extraction Provenance — recorder module (P1.3)
 *
 * The sole call point for the extraction_stage_runs lifecycle RPCs
 * (start_extraction_stage_run / settle_extraction_stage_run, added in
 * 20260825000200_extraction_runs_recorder_rpcs.sql). Stage bodies
 * (parse-document-azure, normalize-pdf-output, handleEnrichMode) call
 * withExtractionStage() once at the top of their existing try/catch
 * structure and call stage.complete()/stage.fail() at their EXISTING exit
 * points -- no restructuring into a callback shape.
 *
 * Flag off (ENABLE_EXTRACTION_PROVENANCE unset/false): zero RPC calls, an
 * inert no-op handle is returned. Flag on: provenance is required, not
 * best-effort -- a failed start_extraction_stage_run call throws
 * ProvenancePersistenceError rather than being swallowed, so the stage
 * fails closed (matching P0's posture toward silent failure).
 *
 * The local `settled` flag on each handle is a fast-path optimization only
 * (skip a redundant round-trip); the database's conditional
 * `UPDATE ... WHERE status = 'running'` inside settle_extraction_stage_run
 * is the real authority, so double-settlement from any source (a call site
 * AND the `ensureSettled()` safety net both firing) can never corrupt the
 * row -- the second call is always a safe no-op there regardless of what
 * this module's local state believes.
 */

import { isExtractionProvenanceEnabled } from "./feature-flag.ts";
import type {
  ExtractionStageContext,
  StageHandle,
  StageOutputSummary,
} from "./types.ts";

/** Serialized output_summary/error_message must stay well under this --
 * mirrors the schema's intent that these columns hold small counters, not
 * document content. Enforced here AND (follow-up) at the RPC layer. */
const MAX_OUTPUT_SUMMARY_BYTES = 32_000;
const MAX_ERROR_MESSAGE_CHARS = 500;

export class ProvenancePersistenceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProvenancePersistenceError";
  }
}

/** Strips bearer tokens/private keys/service-account fields before anything
 * reaches error_message, and bounds length. Provenance rows must never
 * carry secrets or document text. */
export function sanitizeErrorMessage(value: unknown): string {
  let text = String(
    value instanceof Error ? value.message : (value ?? "Unknown error"),
  );
  const patterns = [
    /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi,
    /"private_key"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"client_email"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"access_token"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"authorization"\s*:\s*"(?:\\"|[^"])*"/gi,
  ];
  for (const pattern of patterns) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text.slice(0, MAX_ERROR_MESSAGE_CHARS);
}

/** Bounds the summary to a safe size; drops it entirely (rather than
 * truncating mid-JSON) if it's too large -- a missing summary is a minor
 * loss of debug detail, a truncated/corrupt JSONB value is worse. */
export function sanitizeOutputSummary(
  summary: StageOutputSummary | undefined,
): Record<string, unknown> {
  if (!summary) return {};
  const serialized = JSON.stringify(summary);
  if (serialized.length > MAX_OUTPUT_SUMMARY_BYTES) {
    return {
      outcome: summary.outcome ?? "unknown",
      _truncated: true,
      _original_size_bytes: serialized.length,
    };
  }
  return summary;
}

const NOOP_STAGE_HANDLE: StageHandle = {
  stageRunId: null,
  enabled: false,
  async complete() {},
  async fail() {},
  async ensureSettled() {},
};

function assertValidSettlement(
  settlement: { settled_by_this_call?: boolean; status?: string } | null | undefined,
  expectedStatus: "completed" | "failed",
  stageRunId: string,
) {
  if (!settlement || !settlement.status) {
    throw new ProvenancePersistenceError(
      "PROVENANCE_SETTLEMENT_FAILED",
      `settle_extraction_stage_run returned no status for stage run ${stageRunId}`,
    );
  }
  if (settlement.settled_by_this_call && settlement.status !== expectedStatus) {
    // Should be unreachable (the RPC only ever sets the status this call
    // asked for on a fresh settlement) -- defensive check against a future
    // RPC change silently altering that contract.
    throw new ProvenancePersistenceError(
      "PROVENANCE_SETTLEMENT_MISMATCH",
      `Expected stage run ${stageRunId} to settle as ${expectedStatus}, RPC reported ${settlement.status}`,
    );
  }
  if (!settlement.settled_by_this_call && settlement.status !== expectedStatus) {
    // A genuine conflict: something else already settled this row into the
    // OTHER terminal state before we got here (e.g. fail() racing
    // complete()). The DB's conditional UPDATE already prevented corruption
    // -- surface this loudly rather than silently accepting the mismatch.
    throw new ProvenancePersistenceError(
      "PROVENANCE_SETTLEMENT_CONFLICT",
      `Stage run ${stageRunId} was already settled as ${settlement.status}, not ${expectedStatus}`,
    );
  }
}

/**
 * Resolves extraction_run_id from generation_id, server-side, at the point
 * a caller already has generation_id in scope (post-claim for the worker,
 * from the request body for parse/normalize). Returns null when provenance
 * was off for that generation (no extraction_runs row exists) -- callers
 * treat that exactly like "no extractionRunId available," which
 * withExtractionStage's own flag check already makes moot via the no-op
 * path. Never derives identity from anything browser-supplied -- org_id and
 * generation_id here are always server-issued/fenced values already
 * threaded through P0's generation machinery.
 */
export async function resolveExtractionRunId(
  supabaseAdmin: any,
  orgId: string,
  generationId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("extraction_runs")
    .select("id")
    .eq("org_id", orgId)
    .eq("generation_id", generationId)
    .maybeSingle();
  if (error) {
    // A lookup failure is not itself a provenance-identity failure (no
    // write was attempted) -- treat as "no run to attach to" rather than
    // throwing, consistent with flag-off/no-row being indistinguishable to
    // callers.
    return null;
  }
  return data?.id ?? null;
}

/** Inline vs storage_object threshold -- matches the schema's documented
 * intent (extraction_artifacts migration comment) and the P1 design's
 * stated MAX_ARTIFACT_INLINE_BYTES. */
const MAX_ARTIFACT_INLINE_BYTES = 200_000;
const ARTIFACT_BUCKET = "extraction-artifacts";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface PersistArtifactArgs {
  orgId: string;
  runId: string;
  stageRunId?: string | null;
  artifactType: "parser_raw_output" | "provider_raw_request" | "provider_raw_response" | "normalized_snapshot";
  content: unknown;
  contentType?: string;
  retentionClass?: "debug_short_term" | "audit_standard" | "legal_hold";
  containsDocumentContent?: boolean;
  containsPersonalData?: boolean;
  /** When set, links the artifact onto this invocation's raw_request/response pointer. */
  linkToInvocationId?: string;
  linkRole?: "request" | "response";
}

/**
 * Captures raw provider request/response (or parser output) content as an
 * extraction_artifacts row -- inline when small, uploaded to the private
 * `extraction-artifacts` Storage bucket (via the admin client, since that
 * bucket grants no RLS access to anyone else) when it exceeds
 * MAX_ARTIFACT_INLINE_BYTES. Artifact capture is secondary to invocation
 * identity (per the P1.4/P1.5 failure policy): a failure here is logged
 * and swallowed, never thrown -- losing a debug artifact must never fail
 * an already-recorded, already-completed/failed provider call. Returns
 * null (rather than throwing) on any failure, including when the flag is
 * off (in which case this should not typically be called at all, but a
 * defensive no-op here costs nothing).
 */
export async function persistArtifact(
  supabaseAdmin: any,
  args: PersistArtifactArgs,
): Promise<string | null> {
  if (!isExtractionProvenanceEnabled()) return null;
  try {
    const serialized = typeof args.content === "string" ? args.content : JSON.stringify(args.content ?? null);
    const bytes = new TextEncoder().encode(serialized);
    const byteSize = bytes.length;
    const contentType = args.contentType ?? "application/json";
    const retentionClass = args.retentionClass ?? "debug_short_term";
    const containsDocumentContent = args.containsDocumentContent ?? true;
    const containsPersonalData = args.containsPersonalData ?? true;

    let storageMode: "inline" | "storage_object";
    let inlineContent: unknown = null;
    let storageBucket: string | null = null;
    let storagePath: string | null = null;
    let sha256: string | null = null;

    if (byteSize <= MAX_ARTIFACT_INLINE_BYTES) {
      storageMode = "inline";
      inlineContent = typeof args.content === "string" ? { text: args.content } : (args.content ?? {});
    } else {
      storageMode = "storage_object";
      sha256 = await sha256Hex(bytes);
      storagePath = `${args.orgId}/${args.runId}/${crypto.randomUUID()}.json`;
      const { error: uploadError } = await supabaseAdmin.storage
        .from(ARTIFACT_BUCKET)
        .upload(storagePath, bytes, { contentType, upsert: false });
      if (uploadError) {
        console.error(`[recorder] artifact upload failed for run ${args.runId}:`, uploadError.message);
        await markArtifactUnavailable(supabaseAdmin, args);
        return null;
      }
      storageBucket = ARTIFACT_BUCKET;
    }

    const { data, error } = await supabaseAdmin.rpc("register_extraction_artifact", {
      p_org_id: args.orgId,
      p_run_id: args.runId,
      p_artifact_type: args.artifactType,
      p_storage_mode: storageMode,
      p_byte_size: byteSize,
      p_stage_run_id: args.stageRunId ?? null,
      p_inline_content: storageMode === "inline" ? inlineContent : null,
      p_storage_bucket: storageBucket,
      p_storage_path: storagePath,
      p_content_type: contentType,
      p_sha256: sha256,
      p_retention_class: retentionClass,
      p_contains_document_content: containsDocumentContent,
      p_contains_personal_data: containsPersonalData,
      p_link_to_invocation_id: args.linkToInvocationId ?? null,
      p_link_role: args.linkRole ?? null,
    });

    if (error) {
      console.error(`[recorder] register_extraction_artifact failed for run ${args.runId}:`, error.message);
      await markArtifactUnavailable(supabaseAdmin, args);
      return null;
    }
    return data?.artifact_id ?? null;
  } catch (err) {
    // Never let an artifact-capture bug affect the caller's own outcome.
    console.error(`[recorder] persistArtifact threw unexpectedly for run ${args.runId}:`, err?.message ?? err);
    await markArtifactUnavailable(supabaseAdmin, args);
    return null;
  }
}

/** Best-effort: mark the owning invocation's artifact-status column
 * 'unavailable' when capture fails, so it's distinguishable from
 * 'not_requested' (capture was never attempted). This is a narrow,
 * single-column update -- not routed through a dedicated RPC, since the
 * recorder module itself (not any one RPC) is the established write
 * boundary, and creating a whole RPC for one status flip would be
 * disproportionate. A failure here is logged only -- it must never mask
 * the original capture failure it's trying to record. */
async function markArtifactUnavailable(supabaseAdmin: any, args: PersistArtifactArgs): Promise<void> {
  if (!args.linkToInvocationId || !args.linkRole) return;
  const column = args.linkRole === "request" ? "request_artifact_status" : "response_artifact_status";
  const { error } = await supabaseAdmin
    .from("provider_invocations")
    .update({ [column]: "unavailable" })
    .eq("id", args.linkToInvocationId)
    .eq("org_id", args.orgId);
  if (error) {
    console.error(`[recorder] could not mark ${column}='unavailable' for invocation ${args.linkToInvocationId}:`, error.message);
  }
}

export async function withExtractionStage(
  supabaseAdmin: any,
  context: ExtractionStageContext,
): Promise<StageHandle> {
  if (!isExtractionProvenanceEnabled()) {
    return NOOP_STAGE_HANDLE;
  }
  if (!context.extractionRunId) {
    // Flag is on but this generation has no extraction_runs row (e.g. it
    // was started before the flag was turned on, or resolveExtractionRunId
    // found nothing) -- there is nothing to attach a stage to. This is a
    // provenance-identity failure, not a silent no-op, because the flag
    // being on means provenance IS expected for new work.
    throw new ProvenancePersistenceError(
      "PROVENANCE_STAGE_START_FAILED",
      "Extraction provenance is enabled but no extraction_run_id was available for this generation.",
    );
  }

  const { data, error } = await supabaseAdmin.rpc("start_extraction_stage_run", {
    p_org_id: context.orgId,
    p_run_id: context.extractionRunId,
    p_stage: context.stage,
    p_pipeline_job_id: context.pipelineJobId ?? null,
  });

  if (error || !data?.stage_run_id) {
    throw new ProvenancePersistenceError(
      "PROVENANCE_STAGE_START_FAILED",
      sanitizeErrorMessage(error?.message ?? "start_extraction_stage_run returned no stage_run_id"),
    );
  }

  const stageRunId: string = data.stage_run_id;
  // Tracks WHICH status this handle already settled to locally, not just
  // whether it settled -- a repeat of the SAME status (e.g. two call sites
  // both calling complete() on the happy path) must be a harmless no-op,
  // but a request for the OPPOSITE status (fail() called after complete()
  // already won, or vice versa) is a genuine conflict and must reject
  // rather than silently doing nothing. This is a local fast-path only;
  // settle_extraction_stage_run's conditional UPDATE remains the real
  // cross-process authority via assertValidSettlement below.
  let settledStatus: "completed" | "failed" | null = null;

  const settle = async (
    targetStatus: "completed" | "failed",
    errorCode: string | null,
    errorMessage: string | null,
    summary: StageOutputSummary | undefined,
  ) => {
    if (settledStatus !== null) {
      if (settledStatus === targetStatus) return; // idempotent repeat, safe no-op
      throw new ProvenancePersistenceError(
        "PROVENANCE_SETTLEMENT_CONFLICT",
        `Stage run ${stageRunId} was already settled as ${settledStatus}, cannot settle as ${targetStatus}`,
      );
    }
    const { data: settlement, error: settleError } = await supabaseAdmin.rpc(
      "settle_extraction_stage_run",
      {
        p_stage_run_id: stageRunId,
        p_org_id: context.orgId,
        p_status: targetStatus,
        p_error_code: errorCode,
        p_error_message: errorMessage ? sanitizeErrorMessage(errorMessage) : null,
        p_output_summary: sanitizeOutputSummary(summary),
      },
    );
    if (settleError) {
      throw new ProvenancePersistenceError(
        "PROVENANCE_SETTLEMENT_FAILED",
        sanitizeErrorMessage(settleError.message),
      );
    }
    assertValidSettlement(settlement, targetStatus, stageRunId);
    settledStatus = targetStatus;
  };

  return {
    stageRunId,
    enabled: true,

    async complete(summary) {
      await settle("completed", null, null, summary);
    },

    async fail(errorCode, sanitizedMessage, summary) {
      await settle("failed", errorCode, sanitizedMessage, summary);
    },

    async ensureSettled() {
      if (settledStatus !== null) return; // already settled, either status -- no-op, not a conflict
      await settle(
        "failed",
        "STAGE_EXITED_WITHOUT_OUTCOME",
        "The extraction stage exited without recording an explicit outcome.",
        { outcome: "terminal_failure" },
      );
    },
  };
}

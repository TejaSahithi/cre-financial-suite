// @ts-nocheck
/**
 * Vertex AI transport wrapper — P1.4.
 *
 * The sole call point for provider_invocations rows covering Vertex AI
 * calls. High-level extractors (llm-extractor.ts, fact-ledger-extractor.ts,
 * profile-classifier.ts) do not call the recorder RPCs directly and are not
 * instrumented individually — they call THIS wrapper with a
 * ProvenanceContext, and this is the one place invocation identity is
 * created/settled for Vertex.
 *
 * Preserves the original provider behavior exactly: callVertexAI itself is
 * never modified, its retry/model/location sweep logic is untouched, and
 * any error it throws propagates to the caller completely unchanged (same
 * type, same message, same classification) — this wrapper only observes
 * the call, it never alters routing, fallback, or output.
 *
 * Flag off / no stage provenance for this call (no extractionRunId or
 * stageRunId on the context): zero RPC calls, calls straight through to
 * callVertexAI. Flag on with valid identity: start_provider_invocation
 * must succeed before the outbound call begins (fail-closed
 * PROVENANCE_PERSISTENCE_FAILED otherwise, matching the recorder module's
 * posture) -- a settlement failure AFTER the provider call already
 * happened is logged, not thrown, since masking a real provider
 * success/failure behind a bookkeeping error would be worse.
 */

import { callVertexAI } from "../../../vertex-ai.ts";
import type {
  VertexAIOptions,
  VertexAIResponse,
  VertexFailureClassification,
} from "../../../vertex-ai.ts";
import { VertexProviderError } from "../../../vertex-ai.ts";
import { isExtractionProvenanceEnabled } from "../feature-flag.ts";
import { persistArtifact, ProvenancePersistenceError, sanitizeErrorMessage } from "../recorder.ts";
import type { ProvenanceContext } from "../types.ts";

/** Generic, cross-provider taxonomy (matches provider_invocations.failure_classification's
 * CHECK constraint) -- NOT the Vertex-specific enum promoted directly, so P7
 * can evolve this without rewriting historical provider semantics. */
export function mapVertexFailureToGeneric(
  classification: VertexFailureClassification | undefined,
): string {
  switch (classification) {
    case "timeout": return "timeout";
    case "rate_limited": return "rate_limit";
    case "server_error": return "provider_server_error";
    case "auth_error": return "authentication";
    case "network_error": return "transport";
    case "budget_exhausted": return "resource_exhausted";
    case "model_unavailable": return "provider_client_error";
    case "malformed_response": return "invalid_response";
    case "empty_extraction": return "schema_validation";
    default: return "unknown";
  }
}

async function settleInvocation(
  supabaseAdmin: any,
  invocationId: string,
  orgId: string,
  args: {
    status: "completed" | "failed";
    success: boolean;
    inputTokens?: number | null;
    outputTokens?: number | null;
    latencyMs?: number | null;
    httpStatus?: number | null;
    failureClassification?: string | null;
    providerErrorCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("settle_provider_invocation", {
    p_invocation_id: invocationId,
    p_org_id: orgId,
    p_status: args.status,
    p_success: args.success,
    p_failure_classification: args.failureClassification ?? null,
    p_provider_error_code: args.providerErrorCode ?? null,
    p_provider_error_status: null,
    p_error_message: args.errorMessage ? sanitizeErrorMessage(args.errorMessage) : null,
    p_input_tokens: args.inputTokens ?? null,
    p_output_tokens: args.outputTokens ?? null,
    p_latency_ms: args.latencyMs ?? null,
    p_http_status: args.httpStatus ?? null,
  });
  if (error) {
    // The provider call itself already completed/failed by this point --
    // a settlement bookkeeping failure must not be presented as a provider
    // failure to the caller. Log and move on (mirrors the "artifact
    // failures are secondary" posture, extended to post-call settlement).
    console.error(
      `[vertex-provenance] settle_provider_invocation failed for invocation ${invocationId}:`,
      error.message,
    );
  }
}

export async function callVertexAIWithProvenance(
  supabaseAdmin: any,
  context: ProvenanceContext,
  opts: VertexAIOptions,
  // Injectable purely for testability (mocking a real fetch-based provider
  // call is otherwise not possible against a read-only ES module binding).
  // No production call site passes this -- it always defaults to the real
  // callVertexAI, so real callers' behavior is completely unaffected.
  callFn: (opts: VertexAIOptions) => Promise<VertexAIResponse> = callVertexAI,
): Promise<VertexAIResponse> {
  if (!isExtractionProvenanceEnabled() || !context.extractionRunId || !context.stageRunId) {
    return callFn(opts);
  }

  const providerAttempt = context.providerAttempt ?? 1;
  const invocationKey = [
    context.generationId,
    context.stageRunId,
    "vertex_ai",
    context.operation,
    context.chunkIndex ?? "",
    providerAttempt,
  ].join(":");

  const { data: startResult, error: startError } = await supabaseAdmin.rpc(
    "start_provider_invocation",
    {
      p_org_id: context.orgId,
      p_run_id: context.extractionRunId,
      p_stage_run_id: context.stageRunId,
      p_provider: "vertex_ai",
      p_operation: context.operation,
      p_invocation_key: invocationKey,
      p_provider_attempt: providerAttempt,
      p_model: opts.model ?? null,
      p_chunk_index: context.chunkIndex ?? null,
    },
  );

  if (startError || !startResult?.invocation_id) {
    throw new ProvenancePersistenceError(
      "PROVENANCE_PERSISTENCE_FAILED",
      sanitizeErrorMessage(startError?.message ?? "start_provider_invocation returned no invocation_id"),
    );
  }

  if (startResult.created === false && startResult.status !== "running") {
    // The same invocation_key was reused for what should have been a NEW
    // attempt -- a caller bug (it must increment providerAttempt for every
    // real new call), not something to silently proceed past: doing so
    // would make a real provider call whose outcome can never be recorded
    // (settle_provider_invocation's conditional UPDATE would no-op against
    // an already-terminal row).
    throw new ProvenancePersistenceError(
      "PROVENANCE_INVOCATION_KEY_REUSED",
      `invocation_key ${invocationKey} already resolved to a terminal invocation (status=${startResult.status}); a new attempt must use a new providerAttempt`,
    );
  }

  const invocationId: string = startResult.invocation_id;
  const startedAt = Date.now();

  // Artifact capture is secondary to invocation identity (P1.5 failure
  // policy) -- persistArtifact never throws, so a capture failure can
  // never affect settlement or the caller's result/error.
  await persistArtifact(supabaseAdmin, {
    orgId: context.orgId,
    runId: context.extractionRunId,
    stageRunId: context.stageRunId,
    artifactType: "provider_raw_request",
    content: { systemPrompt: opts.systemPrompt, userPrompt: opts.userPrompt, model: opts.model },
    linkToInvocationId: invocationId,
    linkRole: "request",
  });

  try {
    const result = await callFn(opts);
    await settleInvocation(supabaseAdmin, invocationId, context.orgId, {
      status: "completed",
      success: true,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      latencyMs: Date.now() - startedAt,
    });
    await persistArtifact(supabaseAdmin, {
      orgId: context.orgId,
      runId: context.extractionRunId,
      stageRunId: context.stageRunId,
      artifactType: "provider_raw_response",
      content: { content: result.content, model: result.model },
      linkToInvocationId: invocationId,
      linkRole: "response",
    });
    return result;
  } catch (err) {
    const isProviderError = err instanceof VertexProviderError;
    await settleInvocation(supabaseAdmin, invocationId, context.orgId, {
      status: "failed",
      success: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: isProviderError ? err.httpStatus ?? null : null,
      failureClassification: mapVertexFailureToGeneric(isProviderError ? err.classification : undefined),
      providerErrorCode: isProviderError ? err.classification : null,
      errorMessage: err?.message ?? String(err),
    });
    // Re-thrown completely unchanged -- same type, same message, same
    // classification -- so existing catch/retry/fallback logic in every
    // caller is entirely unaffected by this wrapper's existence.
    throw err;
  }
}

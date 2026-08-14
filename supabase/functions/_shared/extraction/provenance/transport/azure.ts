// @ts-nocheck
/**
 * Azure Document Intelligence transport wrapper — P1.4.
 *
 * Same shape and guarantees as the OpenAI transport wrapper (transport/openai.ts):
 * sole call point for provider_invocations rows covering Azure Document
 * Intelligence calls, no-op when the flag is off or the stage has no
 * provenance identity, fail-closed on a start-persistence failure, never
 * alters analyzeWithAzureLayout's own routing/retry/output -- the original
 * function is called completely unmodified and any error it throws
 * propagates unchanged.
 *
 * Unlike Vertex, analyzeWithAzureLayout throws plain Error objects (no
 * typed classification/httpStatus property) -- the HTTP status appears
 * only inside the message text (e.g. "submit failed (429): ..."). The
 * classifier below extracts it from the message rather than inventing a
 * new typed error class in document-intelligence.ts, which would be an
 * unrelated behavior change to a file this phase must leave untouched.
 * There is also no token concept for a document-layout API -- only latency
 * is recorded.
 */

import { analyzeWithAzureLayout } from "../../../azure/document-intelligence.ts";
import type { AzureAnalyzeLayoutArgs } from "../../../azure/document-intelligence.ts";
import { isExtractionProvenanceEnabled } from "../feature-flag.ts";
import { persistArtifact, ProvenancePersistenceError, sanitizeErrorMessage } from "../recorder.ts";
import type { ProvenanceContext } from "../types.ts";

/** Extracts an HTTP status embedded in the message text, e.g.
 * "Azure Document Intelligence submit failed (429): ...". Returns null if
 * none is found (config errors, timeouts, missing-header cases). */
function extractHttpStatus(message: string): number | null {
  const match = /\((\d{3})\)/.exec(message);
  return match ? Number(match[1]) : null;
}

export function classifyAzureFailure(message: string): { generic: string; httpStatus: number | null } {
  const httpStatus = extractHttpStatus(message);
  if (/is not configured/i.test(message)) {
    return { generic: "authentication", httpStatus };
  }
  if (/timed out/i.test(message)) {
    return { generic: "timeout", httpStatus };
  }
  if (httpStatus === 429) {
    return { generic: "rate_limit", httpStatus };
  }
  if (httpStatus != null && httpStatus >= 500) {
    return { generic: "provider_server_error", httpStatus };
  }
  if (httpStatus != null && httpStatus >= 400) {
    return { generic: "provider_client_error", httpStatus };
  }
  if (/analysis failed/i.test(message)) {
    return { generic: "provider_server_error", httpStatus };
  }
  if (/analyzeResult was missing|Operation-Location header was missing/i.test(message)) {
    return { generic: "invalid_response", httpStatus };
  }
  return { generic: "unknown", httpStatus };
}

async function settleInvocation(
  supabaseAdmin: any,
  invocationId: string,
  orgId: string,
  args: {
    status: "completed" | "failed";
    success: boolean;
    latencyMs?: number | null;
    httpStatus?: number | null;
    failureClassification?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const { error } = await supabaseAdmin.rpc("settle_provider_invocation", {
    p_invocation_id: invocationId,
    p_org_id: orgId,
    p_status: args.status,
    p_success: args.success,
    p_failure_classification: args.failureClassification ?? null,
    p_provider_error_code: null,
    p_provider_error_status: null,
    p_error_message: args.errorMessage ? sanitizeErrorMessage(args.errorMessage) : null,
    p_input_tokens: null,
    p_output_tokens: null,
    p_latency_ms: args.latencyMs ?? null,
    p_http_status: args.httpStatus ?? null,
  });
  if (error) {
    console.error(
      `[azure-provenance] settle_provider_invocation failed for invocation ${invocationId}:`,
      error.message,
    );
  }
}

export async function analyzeWithAzureLayoutAndProvenance(
  supabaseAdmin: any,
  context: ProvenanceContext,
  args: AzureAnalyzeLayoutArgs,
  callFn: (args: AzureAnalyzeLayoutArgs) => Promise<Record<string, unknown>> = analyzeWithAzureLayout,
): Promise<Record<string, unknown>> {
  if (!isExtractionProvenanceEnabled() || !context.extractionRunId || !context.stageRunId) {
    return callFn(args);
  }

  const providerAttempt = context.providerAttempt ?? context.stageAttempt ?? 1;
  const invocationKey = [
    context.generationId,
    context.stageRunId,
    "azure_document_intelligence",
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
      p_provider: "azure_document_intelligence",
      p_operation: context.operation,
      p_invocation_key: invocationKey,
      p_provider_attempt: providerAttempt,
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
    throw new ProvenancePersistenceError(
      "PROVENANCE_INVOCATION_KEY_REUSED",
      `invocation_key ${invocationKey} already resolved to a terminal invocation (status=${startResult.status}); a new attempt must use a new providerAttempt`,
    );
  }

  const invocationId: string = startResult.invocation_id;
  const startedAt = Date.now();

  try {
    const result = await callFn(args);
    await settleInvocation(supabaseAdmin, invocationId, context.orgId, {
      status: "completed",
      success: true,
      latencyMs: Date.now() - startedAt,
    });
    // Response capture only -- the request "body" here is the original
    // uploaded file's bytes/URL, which is already durably stored as the
    // uploaded_files row itself; duplicating raw file bytes into a second
    // artifact table would be wasteful, not informative.
    await persistArtifact(supabaseAdmin, {
      orgId: context.orgId,
      runId: context.extractionRunId,
      stageRunId: context.stageRunId,
      artifactType: "provider_raw_response",
      content: result,
      linkToInvocationId: invocationId,
      linkRole: "response",
    });
    return result;
  } catch (err) {
    const message = err?.message ?? String(err);
    const { generic, httpStatus } = classifyAzureFailure(message);
    await settleInvocation(supabaseAdmin, invocationId, context.orgId, {
      status: "failed",
      success: false,
      latencyMs: Date.now() - startedAt,
      httpStatus,
      failureClassification: generic,
      errorMessage: message,
    });
    throw err;
  }
}

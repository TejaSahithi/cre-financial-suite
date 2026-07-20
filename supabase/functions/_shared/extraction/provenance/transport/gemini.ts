// @ts-nocheck
/**
 * OpenAI transport wrapper with legacy filename/function compatibility.
 *
 * Older imports can still call this compatibility function, but the
 * implementation delegates to _shared/llm.ts and records provider=openai.
 */

import { callLLMText, LLMProviderError } from "../../../llm.ts";
import { isExtractionProvenanceEnabled } from "../feature-flag.ts";
import { persistArtifact, ProvenancePersistenceError, sanitizeErrorMessage } from "../recorder.ts";
import type { ProvenanceContext } from "../types.ts";
import { mapOpenAIFailureToGeneric } from "./vertex.ts";

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
    console.error(
      `[openai-provenance] settle_provider_invocation failed for invocation ${invocationId}:`,
      error.message,
    );
  }
}

export async function callGeminiWithAPIKeyAndProvenance(
  supabaseAdmin: any,
  context: ProvenanceContext,
  opts: any,
  callFn: (opts: any) => Promise<any> = async (o: any) => {
    const res = await callLLMText({
      systemPrompt: o.systemPrompt ?? "",
      userPrompt: o.userPrompt,
      temperature: o.temperature,
      maxOutputTokens: o.maxOutputTokens,
    });
    return {
      content: res.content,
      model: res.model,
      inputTokens: res.promptTokens,
      outputTokens: res.completionTokens,
    };
  },
): Promise<any> {
  if (!isExtractionProvenanceEnabled() || !context.extractionRunId || !context.stageRunId) {
    return callFn(opts);
  }

  const providerAttempt = context.providerAttempt ?? 1;
  const invocationKey = [
    context.generationId,
    context.stageRunId,
    "openai",
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
      p_provider: "openai",
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
    throw new ProvenancePersistenceError(
      "PROVENANCE_INVOCATION_KEY_REUSED",
      `invocation_key ${invocationKey} already resolved to a terminal invocation (status=${startResult.status}); a new attempt must use a new providerAttempt`,
    );
  }

  const invocationId: string = startResult.invocation_id;
  const startedAt = Date.now();

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
    const isProviderError = err instanceof LLMProviderError;
    await settleInvocation(supabaseAdmin, invocationId, context.orgId, {
      status: "failed",
      success: false,
      latencyMs: Date.now() - startedAt,
      httpStatus: isProviderError ? err.httpStatus ?? null : null,
      failureClassification: mapOpenAIFailureToGeneric(isProviderError ? err.classification : undefined),
      providerErrorCode: isProviderError ? err.classification : null,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

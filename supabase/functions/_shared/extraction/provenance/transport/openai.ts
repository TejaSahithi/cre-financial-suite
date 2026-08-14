// @ts-nocheck
/**
 * OpenAI transport wrapper — P1.4.
 *
 * Sole call point for provider_invocations rows covering OpenAI LLM calls
 * made from the extraction pipeline. No-op when the flag is off or the
 * stage has no provenance identity, fail-closed on a start-persistence
 * failure, never alters the underlying call's own result -- errors
 * propagate unchanged. All invocations are recorded with provider="openai";
 * there is only ever one LLM provider.
 */

import { callLLMJSON, callLLMStructured, callLLMText, LLMProviderError } from "../../../llm.ts";
import type { LLMCallOpts, LLMJSONResponse, LLMStructuredCallOpts, StructuredLlmResult } from "../../../llm.ts";
import { isExtractionProvenanceEnabled } from "../feature-flag.ts";
import { persistArtifact, ProvenancePersistenceError, sanitizeErrorMessage } from "../recorder.ts";
import type { ProvenanceContext } from "../types.ts";

export function mapOpenAIFailureToGeneric(
  classification: string | undefined,
): string {
  if (!classification) return "unknown";
  return classification; // LLMProviderError classification maps 1:1 to generic categories
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
    console.error(
      `[openai-provenance] settle_provider_invocation failed for invocation ${invocationId}:`,
      error.message,
    );
  }
}

const defaultCallFn = async (opts: any) => {
  const res = await callLLMText({
    systemPrompt: opts.systemPrompt ?? "",
    userPrompt: opts.userPrompt,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
  });
  return {
    content: res.content,
    model: res.model,
    inputTokens: res.promptTokens,
    outputTokens: res.completionTokens,
    finishReason: res.finishReason,
    responseId: res.responseId,
  };
};

export async function callOpenAIWithProvenance(
  supabaseAdmin: any,
  context: ProvenanceContext,
  opts: any,
  callFn: (opts: any) => Promise<any> = defaultCallFn,
): Promise<any> {
  if (!isExtractionProvenanceEnabled() || !context.extractionRunId || !context.stageRunId) {
    return callFn(opts);
  }

  const providerAttempt = context.providerAttempt ?? context.stageAttempt ?? 1;
  const invocationKey = [
    context.generationId,
    context.stageRunId,
    "openai",
    context.operation,
    context.chunkIndex ?? "",
    providerAttempt,
  ].join(":");

  const modelName = opts.model ?? (Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini");

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
      p_model: modelName,
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
    content: {
      systemPrompt: opts.systemPrompt,
      userPrompt: opts.userPrompt,
      model: modelName,
      temperature: opts.temperature ?? 0.1,
      prompt_version: opts.promptVersion,
    },
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
      providerErrorCode: result.finishReason ?? null,
    });

    await persistArtifact(supabaseAdmin, {
      orgId: context.orgId,
      runId: context.extractionRunId,
      stageRunId: context.stageRunId,
      artifactType: "provider_raw_response",
      content: {
        content: result.content,
        model: result.model,
        response_id: result.responseId,
        finish_reason: result.finishReason,
      },
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
      failureClassification: mapOpenAIFailureToGeneric(isProviderError ? err.classification : "unknown"),
      providerErrorCode: isProviderError ? err.classification : null,
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

/**
 * JSON-mode counterpart of callOpenAIWithProvenance -- the actual call
 * shape used by llm-extractor.ts / fact-ledger-extractor.ts (callLLMJSON,
 * not callLLMText). Wraps callLLMJSON in the {content, model, inputTokens,
 * outputTokens, finishReason, responseId} shape callOpenAIWithProvenance's
 * settle/artifact logic expects, then unwraps back to the original
 * LLMJSONResponse so call sites need no changes beyond swapping the import
 * -- same guarantee as callOpenAIWithProvenance: a no-op passthrough to
 * callLLMJSON when the flag is off or the stage has no provenance identity.
 */
export async function callLLMJSONWithProvenance(
  supabaseAdmin: any,
  context: ProvenanceContext,
  opts: LLMCallOpts,
): Promise<LLMJSONResponse> {
  const wrapped = await callOpenAIWithProvenance(supabaseAdmin, context, opts, async (o: LLMCallOpts) => {
    const raw = await callLLMJSON(o);
    return {
      content: JSON.stringify(raw.data ?? null),
      model: raw.model,
      inputTokens: raw.promptTokens,
      outputTokens: raw.completionTokens,
      finishReason: raw.finishReason,
      responseId: raw.responseId,
      __raw: raw,
    };
  });
  return (wrapped as any).__raw ?? wrapped;
}

/**
 * Internal-only plumbing error: carries a non-"success" StructuredLlmResult
 * across callOpenAIWithProvenance's try/catch so its EXISTING
 * settle/artifact logic (which only knows how to record a thrown
 * LLMProviderError as a failed invocation) records refusal/truncated/
 * schema_error/provider_error outcomes as real failed provider_invocations
 * rows -- rather than the misleading "completed, success:true" a returned
 * (never-thrown) non-success result would otherwise produce. callLLMStructured
 * itself never throws for these cases (its entire point is one exhaustive
 * result type); this class exists only so this one wrapper can reuse
 * callOpenAIWithProvenance unchanged, and it never escapes
 * callLLMStructuredWithProvenance's own catch block below.
 */
class NonSuccessStructuredResultError extends LLMProviderError {
  constructor(public readonly structuredResult: StructuredLlmResult<unknown>) {
    super(
      structuredResult.errorMessage ?? structuredResult.refusalReason ?? `Structured output call returned status=${structuredResult.status}`,
      structuredResult.errorClassification ?? "schema_validation",
    );
  }
}

/**
 * Structured-outputs counterpart of callLLMJSONWithProvenance -- the
 * transport used by the strict-outputs shadow pilot (adaptive-extractor.ts,
 * expenses_and_cam only). Same no-op-when-flag-off/no-stage-identity
 * guarantee as callOpenAIWithProvenance. Always returns the full
 * StructuredLlmResult (never throws for a data-shaped outcome) -- a thrown
 * error here means something outside the structured-call contract itself
 * failed (e.g. ProvenancePersistenceError from a start-provenance failure),
 * and is propagated, not swallowed.
 */
export async function callLLMStructuredWithProvenance<T = unknown>(
  supabaseAdmin: any,
  context: ProvenanceContext,
  opts: LLMStructuredCallOpts,
): Promise<StructuredLlmResult<T>> {
  try {
    const wrapped = await callOpenAIWithProvenance(supabaseAdmin, context, opts, async (o: LLMStructuredCallOpts) => {
      const structured = await callLLMStructured<T>(o);
      if (structured.status !== "success") {
        throw new NonSuccessStructuredResultError(structured);
      }
      return {
        content: JSON.stringify(structured.data ?? null),
        model: structured.model,
        inputTokens: structured.inputTokens,
        outputTokens: structured.outputTokens,
        finishReason: structured.finishReason,
        responseId: structured.responseId,
        __raw: structured,
      };
    });
    return ((wrapped as any).__raw ?? wrapped) as StructuredLlmResult<T>;
  } catch (error) {
    if (error instanceof NonSuccessStructuredResultError) {
      return error.structuredResult as StructuredLlmResult<T>;
    }
    if (error instanceof ProvenancePersistenceError) throw error;
    if (error instanceof LLMProviderError) {
      return {
        status: "provider_error",
        data: null,
        refusalReason: null,
        errorClassification: error.classification,
        errorMessage: error.message,
        model: null,
        responseId: null,
        inputTokens: null,
        outputTokens: null,
        finishReason: null,
      };
    }
    throw error;
  }
}

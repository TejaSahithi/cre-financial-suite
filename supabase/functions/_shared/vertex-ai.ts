// @ts-nocheck
/**
 * Deprecated compatibility facade.
 *
 * The platform now uses Azure Document Intelligence for document parsing and
 * _shared/llm.ts for OpenAI LLM calls. This file remains only so older imports
 * keep compiling; it no longer calls retired provider endpoints.
 */

import {
  callLLMJSON,
  callLLMText,
  LLMProviderError,
  type LLMCallOpts,
  type LLMFailureClassification,
} from "./llm.ts";

export type VertexFailureClassification = LLMFailureClassification | "auth_error" | "rate_limited" | "server_error" | "network_error" | "budget_exhausted" | "model_unavailable" | "malformed_response" | "empty_extraction";

function normalizeClassification(value: string): LLMFailureClassification {
  switch (value) {
    case "auth_error": return "authentication";
    case "rate_limited": return "rate_limit";
    case "server_error": return "provider_server_error";
    case "network_error": return "transport";
    case "malformed_response": return "invalid_response";
    case "empty_extraction": return "invalid_response";
    case "budget_exhausted": return "timeout";
    case "model_unavailable": return "provider_server_error";
    default: return (value as LLMFailureClassification) || "unknown";
  }
}

export class VertexProviderError extends LLMProviderError {
  constructor(message: string, classification: VertexFailureClassification = "unknown", httpStatus?: number) {
    super(message, normalizeClassification(classification), httpStatus);
    this.name = "OpenAICompatibilityProviderError";
  }
}

export interface VertexAIOptions {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  model?: string;
  timeoutMs?: number;
  deadlineAt?: number;
}

export interface VertexAIFileOptions extends VertexAIOptions {
  fileBase64?: string;
  fileMimeType?: string;
  fileUri?: string;
}

export interface VertexAIResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  finishReason: string;
}

function toLLMOpts(opts: VertexAIOptions): LLMCallOpts {
  return {
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    temperature: opts.temperature,
    maxOutputTokens: opts.maxOutputTokens,
    model: opts.model,
  };
}

export async function validateVertexAIAuth(): Promise<{ ok: boolean; source: string | null; error?: string }> {
  try {
    await callLLMText({ systemPrompt: "Respond with ok.", userPrompt: "ok", maxOutputTokens: 4, temperature: 0 });
    return { ok: true, source: "openai_compatibility" };
  } catch (error) {
    return { ok: false, source: "openai_compatibility", error: (error as Error)?.message ?? String(error) };
  }
}

export async function callVertexAI(opts: VertexAIOptions): Promise<VertexAIResponse> {
  const response = await callLLMText(toLLMOpts(opts));
  return {
    text: response.content,
    model: response.model,
    inputTokens: response.promptTokens,
    outputTokens: response.completionTokens,
    finishReason: response.finishReason,
  };
}

export async function callVertexAIJSON<T = unknown>(opts: VertexAIOptions): Promise<T | null> {
  const response = await callLLMJSON(toLLMOpts(opts));
  return response.data as T;
}

export async function callGeminiWithAPIKey(opts: VertexAIOptions): Promise<VertexAIResponse> {
  return await callVertexAI(opts);
}

export async function callGeminiWithAPIKeyAndFile(opts: VertexAIFileOptions): Promise<VertexAIResponse> {
  return await callVertexAIWithFile(opts);
}

function fileModeRetired(): never {
  throw new VertexProviderError(
    "Legacy file-mode LLM extraction is retired. Use Azure Document Intelligence parser output before OpenAI extraction.",
    "model_unavailable",
  );
}

export async function callVertexAIWithFile(_opts: VertexAIFileOptions): Promise<VertexAIResponse> {
  fileModeRetired();
}

export async function callVertexAIFileJSON<T = unknown>(_opts: VertexAIFileOptions): Promise<T | null> {
  fileModeRetired();
}

export type VertexAIDiagnosticStageName = "openai_request_started" | "openai_response_received";
export interface VertexAIDiagnosticStageEvent {
  stage: VertexAIDiagnosticStageName;
  elapsedMs: number;
  detail?: Record<string, unknown>;
}

export class VertexAIDiagnosticError extends Error {
  category: string;
  constructor(category: string, message: string) {
    super(message);
    this.name = "OpenAICompatibilityDiagnosticError";
    this.category = category;
  }
}

export interface VertexAISingleRequestDiagnosticOptions extends VertexAIOptions {
  onStage?: (event: VertexAIDiagnosticStageEvent) => void;
}

export async function callVertexAISingleRequestDiagnostic(
  opts: VertexAISingleRequestDiagnosticOptions,
): Promise<VertexAIResponse & { location: string; latencyMs: number; stages: VertexAIDiagnosticStageEvent[] }> {
  const start = Date.now();
  const stages: VertexAIDiagnosticStageEvent[] = [];
  const emit = (stage: VertexAIDiagnosticStageName) => {
    const event = { stage, elapsedMs: Date.now() - start };
    stages.push(event);
    opts.onStage?.(event);
  };
  emit("openai_request_started");
  const response = await callVertexAI(opts);
  emit("openai_response_received");
  return { ...response, location: "openai", latencyMs: Date.now() - start, stages };
}
// @ts-nocheck
/**
 * _shared/llm.ts — Provider-agnostic LLM service.
 *
 * This is the ONLY file in the codebase that knows about OpenAI.
 * All callers import { callLLMJSON, callLLMText } from here.
 * Switching providers in the future only requires changing this file.
 *
 * Configuration (Supabase secrets):
 *   OPENAI_API_KEY          — required
 *   OPENAI_MODEL            — optional, default: "gpt-4o-mini"
 *   OPENAI_MAX_OUTPUT_TOKENS — optional, default: 16384
 */

// ---------------------------------------------------------------------------
// Public interface — the rest of the codebase only depends on these types
// ---------------------------------------------------------------------------

export interface LLMCallOpts {
  systemPrompt: string;
  userPrompt: string;
  temperature?: number;      // default: 0.1
  maxOutputTokens?: number;  // default: OPENAI_MAX_OUTPUT_TOKENS env var or 16384
  promptVersion?: string;    // recorded in provenance (e.g. "expense-rules-v2")
  model?: string;            // override OPENAI_MODEL for this call only
}

export interface LLMJSONResponse {
  data: unknown;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;  // "stop" | "length" | "content_filter" — "length" = truncated JSON
  responseId: string;    // OpenAI request ID for debugging / support tickets
}

export interface LLMTextResponse {
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  responseId: string;
}

export interface LLMProvider {
  json(opts: LLMCallOpts): Promise<LLMJSONResponse>;
  text(opts: LLMCallOpts): Promise<LLMTextResponse>;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function getConfig() {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new LLMProviderError(
      "OPENAI_API_KEY is not set. Add it via: supabase secrets set OPENAI_API_KEY=sk-proj-...",
      "authentication",
    );
  }
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const maxOutputTokens = parseInt(Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS") || "16384", 10);
  return { apiKey, model, maxOutputTokens };
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export type LLMFailureClassification =
  | "authentication"
  | "rate_limit"
  | "provider_server_error"
  | "timeout"
  | "transport"
  | "invalid_response"
  | "context_length_exceeded"
  | "content_filter"
  | "unknown";

export class LLMProviderError extends Error {
  public readonly classification: LLMFailureClassification;
  public readonly httpStatus?: number;

  constructor(message: string, classification: LLMFailureClassification, httpStatus?: number) {
    super(message);
    this.name = "LLMProviderError";
    this.classification = classification;
    this.httpStatus = httpStatus;
  }
}

// ---------------------------------------------------------------------------
// OpenAI adapter (internal — not exported)
// ---------------------------------------------------------------------------

const OPENAI_CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";

function classifyOpenAIError(status: number, body: any): LLMFailureClassification {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status === 400) {
    const msg = String(body?.error?.message ?? "").toLowerCase();
    if (msg.includes("context_length") || msg.includes("maximum context")) return "context_length_exceeded";
    if (msg.includes("content_filter") || msg.includes("content policy")) return "content_filter";
    return "invalid_response";
  }
  if (status >= 500) return "provider_server_error";
  return "unknown";
}

// Newer reasoning-oriented OpenAI models (o-series, and some gpt-5.x models)
// reject any non-default `temperature` outright -- a 400 whose param is
// "temperature" (OpenAI's `unsupported_value` error code), rather than a
// real extraction failure. Every caller in this codebase sends an explicit
// temperature (usually 0, for deterministic extraction); without this check
// switching OPENAI_MODEL to such a model makes every single call fail,
// system-wide, with no document-specific cause -- exactly the "OpenAI never
// returns anything" symptom this was added to catch and recover from.
function isUnsupportedTemperatureError(status: number, body: any): boolean {
  if (status !== 400) return false;
  const param = String(body?.error?.param ?? "").toLowerCase();
  const code = String(body?.error?.code ?? "").toLowerCase();
  const msg = String(body?.error?.message ?? "").toLowerCase();
  if (param === "temperature" || code === "unsupported_value") return true;
  return msg.includes("temperature") && (msg.includes("unsupported") || msg.includes("does not support") || msg.includes("only the default"));
}

async function postToOpenAI(apiKey: string, body: Record<string, unknown>): Promise<{ response: Response; responseBody: any; responseId: string }> {
  let response: Response;
  try {
    response = await fetch(OPENAI_CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000), // 2 min hard timeout
    });
  } catch (fetchErr: any) {
    const isTimeout = fetchErr?.name === "TimeoutError" || fetchErr?.name === "AbortError";
    throw new LLMProviderError(
      isTimeout
        ? `OpenAI request timed out after 120s`
        : `Network error calling OpenAI: ${fetchErr?.message}`,
      isTimeout ? "timeout" : "transport",
    );
  }

  const responseId = response.headers.get("x-request-id") ?? "unknown";
  let responseBody: any;
  try {
    responseBody = await response.json();
  } catch {
    throw new LLMProviderError(
      `OpenAI returned non-JSON response (HTTP ${response.status})`,
      "invalid_response",
      response.status,
    );
  }

  return { response, responseBody, responseId };
}

async function openAICall(opts: LLMCallOpts, jsonMode: boolean): Promise<{
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  responseId: string;
}> {
  const { apiKey, model: defaultModel, maxOutputTokens: defaultMaxTokens } = getConfig();
  const model = opts.model ?? defaultModel;
  const maxTokens = opts.maxOutputTokens ?? defaultMaxTokens;
  const temperature = opts.temperature ?? 0.1;

  const messages: any[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: opts.userPrompt });

  const body: any = {
    model,
    messages,
    temperature,
    max_completion_tokens: maxTokens,
  };

  if (jsonMode) {
    // Enforce valid JSON output — prevents truncated or prose responses
    body.response_format = { type: "json_object" };
  }

  let { response, responseBody, responseId } = await postToOpenAI(apiKey, body);

  // Newer reasoning-oriented models (o-series, some gpt-5.x models) reject
  // any non-default temperature outright. Retry exactly once with
  // `temperature` omitted (the model's own default applies) rather than
  // surfacing this as an extraction failure -- every caller in this
  // codebase sends an explicit temperature for deterministic extraction,
  // so without this, switching OPENAI_MODEL to such a model would make
  // every single call fail, for every document, with no per-document cause.
  if (!response.ok && isUnsupportedTemperatureError(response.status, responseBody)) {
    console.warn(
      `[llm] model "${model}" rejected temperature=${temperature}; retrying once without a custom temperature`,
    );
    const { temperature: _drop, ...bodyWithoutTemperature } = body;
    ({ response, responseBody, responseId } = await postToOpenAI(apiKey, bodyWithoutTemperature));
  }

  if (!response.ok) {
    const classification = classifyOpenAIError(response.status, responseBody);
    throw new LLMProviderError(
      responseBody?.error?.message ?? `OpenAI HTTP ${response.status}`,
      classification,
      response.status,
    );
  }

  const choice = responseBody?.choices?.[0];
  if (!choice) {
    throw new LLMProviderError("OpenAI returned no choices", "invalid_response");
  }

  const content = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason ?? "unknown";
  const usage = responseBody?.usage ?? {};

  return {
    content,
    model: responseBody?.model ?? model,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    finishReason,
    responseId,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Call the LLM and parse the response as JSON.
 *
 * Uses OpenAI's json_object response_format — the model is forced to return
 * valid JSON. If finishReason === "length", the JSON was truncated; callers
 * should retry with chunking.
 */
export async function callLLMJSON(opts: LLMCallOpts): Promise<LLMJSONResponse> {
  const raw = await openAICall(opts, true);

  let data: unknown;
  try {
    data = JSON.parse(raw.content);
  } catch {
    throw new LLMProviderError(
      `LLM returned invalid JSON despite json_object mode. finish_reason=${raw.finishReason}. Content preview: ${raw.content.slice(0, 200)}`,
      "invalid_response",
    );
  }

  return {
    data,
    model: raw.model,
    promptTokens: raw.promptTokens,
    completionTokens: raw.completionTokens,
    finishReason: raw.finishReason,
    responseId: raw.responseId,
  };
}

/**
 * Call the LLM and return a plain text response.
 *
 * Use for narrative generation (budget summaries, notes) where structured
 * JSON is not needed.
 */
export async function callLLMText(opts: LLMCallOpts): Promise<LLMTextResponse> {
  const raw = await openAICall(opts, false);
  return {
    content: raw.content,
    model: raw.model,
    promptTokens: raw.promptTokens,
    completionTokens: raw.completionTokens,
    finishReason: raw.finishReason,
    responseId: raw.responseId,
  };
}

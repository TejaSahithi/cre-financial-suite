// @ts-nocheck
/**
 * _shared/llm.ts — Provider-agnostic LLM service.
 *
 * This is the ONLY file in the codebase that knows about OpenAI / Azure
 * OpenAI. All callers import { callLLMJSON, callLLMText } from here.
 *
 * Two supported backends, chosen automatically by whether
 * AZURE_OPENAI_ENDPOINT is set:
 *
 *   Direct OpenAI platform (default when AZURE_OPENAI_ENDPOINT is unset):
 *     OPENAI_API_KEY           — required. A platform key (starts "sk-").
 *     OPENAI_MODEL             — optional, default: "gpt-4o-mini"
 *     OPENAI_MAX_OUTPUT_TOKENS — optional, default: 16384
 *
 *   Azure OpenAI / Microsoft Foundry (used whenever AZURE_OPENAI_ENDPOINT is
 *   set — an Azure OpenAI resource key is NOT a valid credential against
 *   api.openai.com, and vice versa; these are two different services with
 *   different auth schemes, so which one is active is never ambiguous).
 *   Uses the Azure OpenAI v1 API (POST {endpoint}/openai/v1/chat/completions,
 *   deployment name passed as the body's "model" field) — NOT the older
 *   dated /openai/deployments/{name}/chat/completions?api-version=... route.
 *   The v1 route works against both *.openai.azure.com and
 *   *.services.ai.azure.com hosts and needs no api-version at all, which
 *   avoids the single most error-prone part of the legacy route (a
 *   model-version string like "2026-03-17" is easy to mistake for the
 *   REST api-version and paste into the wrong place — they are unrelated
 *   values from unrelated Azure concepts):
 *     AZURE_OPENAI_ENDPOINT    — required. Base resource URL only, e.g.
 *                                https://your-resource.openai.azure.com or
 *                                https://your-resource.services.ai.azure.com
 *                                — no /openai/... path, no query string.
 *     AZURE_OPENAI_API_KEY     — the resource's key. Falls back to
 *                                OPENAI_API_KEY if unset, so an existing
 *                                deployment that already stored the Azure
 *                                key under OPENAI_API_KEY keeps working.
 *     AZURE_OPENAI_DEPLOYMENT  — the deployment name you chose when
 *                                deploying the model in the Azure portal
 *                                (NOT necessarily the model name, and NOT a
 *                                model version). Falls back to OPENAI_MODEL
 *                                if unset. Sent as the body's "model" field.
 *     OPENAI_MAX_OUTPUT_TOKENS — optional, default: 16384
 *
 *   AZURE_OPENAI_API_VERSION is not used by this module — the v1 route takes
 *   no api-version parameter. Any value left in that secret is ignored.
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

type LLMConfig =
  | { isAzure: false; apiKey: string; model: string; maxOutputTokens: number }
  | {
    isAzure: true;
    apiKey: string;
    model: string;
    maxOutputTokens: number;
    azureEndpoint: string;
    deployment: string;
  };

/** Whether AZURE_OPENAI_ENDPOINT selects the Azure OpenAI backend. Exported
 * so callers that only need a yes/no "is the LLM configured" signal (health
 * checks, UI banners) don't have to duplicate this branching — see
 * isLLMProviderConfigured() below.
 *
 * Defensive against the single most common Azure setup mistake: copying the
 * FULL sample request URL from the Azure portal's "view code" panel (which
 * already includes /openai/deployments/{name}/chat/completions?api-version=...)
 * into AZURE_OPENAI_ENDPOINT instead of just the resource's base URL. Left
 * uncorrected, buildRequestTarget() would append a second
 * /openai/deployments/... segment onto that path, producing a URL nothing on
 * Azure's side matches — which surfaces as an opaque "Resource not found"
 * (404) with no indication the endpoint itself was the problem. Stripping
 * any /openai/... suffix here (and logging once) means an accidental
 * full-URL paste self-heals instead of silently breaking every call. */
function resolveAzureEndpoint(): string {
  const raw = String(Deno.env.get("AZURE_OPENAI_ENDPOINT") ?? "").trim();
  if (!raw) return "";
  const openaiPathIndex = raw.indexOf("/openai/");
  if (openaiPathIndex === -1) {
    return raw.replace(/\/+$/, "");
  }
  const base = raw.slice(0, openaiPathIndex).replace(/\/+$/, "");
  console.warn(
    `[llm] AZURE_OPENAI_ENDPOINT looks like a full request URL (contains "/openai/...") ` +
      `rather than just the resource base URL; using "${base}" instead of the full value. ` +
      `Set AZURE_OPENAI_ENDPOINT to just "https://<resource>.openai.azure.com" to avoid this warning.`,
  );
  return base;
}

/** True when a usable credential is present for whichever backend
 * (Azure OpenAI or direct OpenAI) AZURE_OPENAI_ENDPOINT currently selects.
 * Use this instead of checking `Deno.env.get("OPENAI_API_KEY")` directly —
 * that check alone does not distinguish "no LLM configured" from "an Azure
 * OpenAI key is stored under OPENAI_API_KEY", which was the exact
 * misdiagnosis this function replaces. */
export function isLLMProviderConfigured(): boolean {
  if (resolveAzureEndpoint()) {
    return !!(Deno.env.get("AZURE_OPENAI_API_KEY") || Deno.env.get("OPENAI_API_KEY"));
  }
  return !!Deno.env.get("OPENAI_API_KEY");
}

function getConfig(): LLMConfig {
  const azureEndpoint = resolveAzureEndpoint();
  const model = Deno.env.get("OPENAI_MODEL") || "gpt-4o-mini";
  const maxOutputTokens = parseInt(Deno.env.get("OPENAI_MAX_OUTPUT_TOKENS") || "16384", 10);

  if (azureEndpoint) {
    // An Azure OpenAI resource key and a direct-OpenAI platform key are
    // different credential types issued by different services — one is
    // never valid against the other's endpoint. AZURE_OPENAI_API_KEY is
    // preferred; OPENAI_API_KEY is accepted as a fallback so a deployment
    // that already stored its Azure key there keeps working unchanged.
    const apiKey = Deno.env.get("AZURE_OPENAI_API_KEY") || Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) {
      throw new LLMProviderError(
        "AZURE_OPENAI_ENDPOINT is set but no API key was found. Add one via: " +
          "supabase secrets set AZURE_OPENAI_API_KEY=...",
        "authentication",
      );
    }
    const deployment = Deno.env.get("AZURE_OPENAI_DEPLOYMENT") || model;
    return { isAzure: true, apiKey, model, maxOutputTokens, azureEndpoint, deployment };
  }

  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    throw new LLMProviderError(
      "OPENAI_API_KEY is not set. Add it via: supabase secrets set OPENAI_API_KEY=sk-proj-...",
      "authentication",
    );
  }
  return { isAzure: false, apiKey, model, maxOutputTokens };
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

export interface LLMProviderErrorExtra {
  /** The provider's own error code from its JSON error body (e.g. Azure's
   * "DeploymentNotFound" / "ResourceNotFound", distinct from the HTTP
   * status). Never a secret — safe to log and persist. */
  providerErrorCode?: string;
  /** x-request-id / x-ms-request-id response header — the ID to hand to
   * OpenAI/Azure support for this exact call. Never a secret. */
  requestId?: string;
  /** The exact URL called, with no query secrets (Azure's API key travels
   * only in the api-key header, never the URL) — safe to log and persist,
   * and is the single fastest way to catch a malformed
   * endpoint/deployment/api-version combination. */
  requestUrl?: string;
}

export class LLMProviderError extends Error {
  public readonly classification: LLMFailureClassification;
  public readonly httpStatus?: number;
  public readonly providerErrorCode?: string;
  public readonly requestId?: string;
  public readonly requestUrl?: string;

  constructor(message: string, classification: LLMFailureClassification, httpStatus?: number, extra?: LLMProviderErrorExtra) {
    super(message);
    this.name = "LLMProviderError";
    this.classification = classification;
    this.httpStatus = httpStatus;
    this.providerErrorCode = extra?.providerErrorCode;
    this.requestId = extra?.requestId;
    this.requestUrl = extra?.requestUrl;
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

/** Builds the request target for whichever backend `config` selects.
 *
 * Azure uses the v1 API: POST {endpoint}/openai/v1/chat/completions, with
 * no api-version query param and no deployment segment in the path — the
 * deployment name goes in the request BODY's "model" field instead (see
 * openAICall). This is deliberate, not an oversight: the older
 * /openai/deployments/{name}/chat/completions?api-version=YYYY-MM-DD route
 * requires a REST api-version that is trivially confused with a model
 * version (e.g. gpt-5.4-mini's model version "2026-03-17" is NOT a valid
 * api-version — pasting one in place of the other is exactly the mistake
 * that produced a 404 in production here). The v1 route sidesteps that
 * whole class of error and works against both *.openai.azure.com and
 * *.services.ai.azure.com hosts.
 *
 * Azure authenticates via an `api-key` header, never `Authorization: Bearer`
 * — the two backends are not interchangeable at the HTTP level. */
function buildRequestTarget(config: LLMConfig): { url: string; headers: Record<string, string>; providerLabel: string } {
  if (config.isAzure) {
    return {
      url: `${config.azureEndpoint}/openai/v1/chat/completions`,
      headers: { "api-key": config.apiKey, "Content-Type": "application/json" },
      providerLabel: "Azure OpenAI",
    };
  }
  return {
    url: OPENAI_CHAT_ENDPOINT,
    headers: { "Authorization": `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    providerLabel: "OpenAI",
  };
}

async function postToOpenAI(config: LLMConfig, body: Record<string, unknown>): Promise<{ response: Response; responseBody: any; responseId: string; requestUrl: string }> {
  const { url, headers, providerLabel } = buildRequestTarget(config);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Bounded well under lease-extraction-worker's NORMALIZE_TIMEOUT_MS
      // (90s): fact-ledger extraction runs up to MAX_CHUNKS calls like this
      // one CONCURRENTLY, so the slowest single call determines normalize's
      // real wall-clock time. A 120s per-call ceiling here could singlehandedly
      // blow the 90s normalize budget (and, upstream of that, the platform's
      // 150s Edge Function hard wall) on one slow call.
      signal: AbortSignal.timeout(60_000),
    });
  } catch (fetchErr: any) {
    const isTimeout = fetchErr?.name === "TimeoutError" || fetchErr?.name === "AbortError";
    throw new LLMProviderError(
      isTimeout
        ? `${providerLabel} request timed out after 60s`
        : `Network error calling ${providerLabel}: ${fetchErr?.message}`,
      isTimeout ? "timeout" : "transport",
      undefined,
      { requestUrl: url },
    );
  }

  // Direct OpenAI sends x-request-id; Azure's API Management gateway in
  // front of Azure OpenAI sends apim-request-id (and sometimes
  // x-ms-request-id) instead — check all three rather than assuming one.
  const responseId =
    response.headers.get("x-request-id") ??
    response.headers.get("apim-request-id") ??
    response.headers.get("x-ms-request-id") ??
    "unknown";
  let responseBody: any;
  try {
    responseBody = await response.json();
  } catch {
    throw new LLMProviderError(
      `${providerLabel} returned non-JSON response (HTTP ${response.status})`,
      "invalid_response",
      response.status,
      { requestId: responseId, requestUrl: url },
    );
  }

  return { response, responseBody, responseId, requestUrl: url };
}

async function openAICall(opts: LLMCallOpts, jsonMode: boolean): Promise<{
  content: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string;
  responseId: string;
}> {
  const config = getConfig();
  const model = opts.model ?? config.model;
  // What actually goes in the request body's "model" field: Azure's v1
  // route takes the deployment name there (not a model name, and not baked
  // into the URL, unlike the older deployment-in-path route); direct
  // OpenAI takes its actual model name.
  const effectiveModel = config.isAzure ? config.deployment : model;
  const maxTokens = opts.maxOutputTokens ?? config.maxOutputTokens;
  const temperature = opts.temperature ?? 0.1;

  const messages: any[] = [];
  if (opts.systemPrompt) {
    messages.push({ role: "system", content: opts.systemPrompt });
  }
  messages.push({ role: "user", content: opts.userPrompt });

  const body: any = {
    model: effectiveModel,
    messages,
    temperature,
    max_completion_tokens: maxTokens,
  };

  if (jsonMode) {
    // Enforce valid JSON output — prevents truncated or prose responses
    body.response_format = { type: "json_object" };
  }

  let { response, responseBody, responseId, requestUrl } = await postToOpenAI(config, body);

  // Newer reasoning-oriented models (o-series, some gpt-5.x models) reject
  // any non-default temperature outright. Retry exactly once with
  // `temperature` omitted (the model's own default applies) rather than
  // surfacing this as an extraction failure -- every caller in this
  // codebase sends an explicit temperature for deterministic extraction,
  // so without this, switching OPENAI_MODEL to such a model would make
  // every single call fail, for every document, with no per-document cause.
  if (!response.ok && isUnsupportedTemperatureError(response.status, responseBody)) {
    console.warn(
      `[llm] model "${effectiveModel}" rejected temperature=${temperature}; retrying once without a custom temperature`,
    );
    const { temperature: _drop, ...bodyWithoutTemperature } = body;
    ({ response, responseBody, responseId, requestUrl } = await postToOpenAI(config, bodyWithoutTemperature));
  }

  if (!response.ok) {
    const classification = classifyOpenAIError(response.status, responseBody);
    const providerLabel = config.isAzure ? "Azure OpenAI" : "OpenAI";
    // Azure/OpenAI's own error code (e.g. "DeploymentNotFound",
    // "ResourceNotFound", "401") — distinct from and more specific than the
    // HTTP status, and the single fastest signal for telling "wrong
    // deployment name" apart from "wrong endpoint/resource" apart from
    // "wrong key", none of which otherwise look different from each other.
    const providerErrorCode =
      typeof responseBody?.error?.code === "string" ? responseBody.error.code : undefined;
    console.error(
      `[llm] ${providerLabel} call failed: http_status=${response.status} ` +
      `provider_error_code=${providerErrorCode ?? "n/a"} request_id=${responseId} ` +
      `url=${requestUrl}`,
    );
    throw new LLMProviderError(
      responseBody?.error?.message ?? `${providerLabel} HTTP ${response.status}`,
      classification,
      response.status,
      { providerErrorCode, requestId: responseId, requestUrl },
    );
  }

  const choice = responseBody?.choices?.[0];
  if (!choice) {
    throw new LLMProviderError(
      `${config.isAzure ? "Azure OpenAI" : "OpenAI"} returned no choices`,
      "invalid_response",
      undefined,
      { requestId: responseId, requestUrl },
    );
  }

  const content = choice?.message?.content ?? "";
  const finishReason = choice?.finish_reason ?? "unknown";
  const usage = responseBody?.usage ?? {};

  return {
    content,
    model: responseBody?.model ?? effectiveModel,
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

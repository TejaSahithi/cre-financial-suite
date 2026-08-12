// @ts-nocheck
/**
 * _shared/assistant/assistant-llm.ts — LLM client for the Assistant feature ONLY.
 *
 * This is a deliberately SEPARATE, PARALLEL module to `_shared/llm.ts` (the
 * lease-extraction LLM client). It reads its own env vars and has NO fallback
 * to the extraction credentials, and `_shared/llm.ts` is never imported here.
 * That separation is a security/operational requirement, not a style choice:
 * the extraction pipeline and the Assistant are billed, rate-limited, and
 * governed independently, and a silent fallback from one to the other would
 * make an Assistant outage look like an extraction credential problem (or
 * vice versa) and could route Assistant traffic through a deployment never
 * provisioned/approved for chat use.
 *
 * Required env vars (Azure OpenAI only — the Assistant deployment is always
 * Azure per product requirement; no direct-OpenAI fallback path exists here):
 *   ASSISTANT_AZURE_OPENAI_ENDPOINT    — resource base URL only, e.g.
 *                                        https://your-resource.openai.azure.com
 *   ASSISTANT_AZURE_OPENAI_API_KEY     — the Assistant resource's own key.
 *                                        NOT AZURE_OPENAI_API_KEY.
 *   ASSISTANT_AZURE_OPENAI_DEPLOYMENT  — the Assistant deployment name
 *                                        (e.g. "gpt-5.4-mini-3").
 * Optional:
 *   ASSISTANT_OPENAI_MAX_OUTPUT_TOKENS — default 4096 (assistant answers are
 *                                        short; tool payloads are pre-trimmed
 *                                        by each tool, not by this module).
 *
 * If any required var is missing, every call throws AssistantLLMError with
 * classification "configuration" — callers must fail safely (surface a
 * config error to the caller), never substitute the extraction credentials.
 *
 * Uses the same Azure OpenAI v1 API shape as `_shared/llm.ts`
 * (POST {endpoint}/openai/v1/chat/completions, deployment name in body
 * "model", auth via "api-key" header, no api-version query param).
 */

export type AssistantLLMFailureClassification =
  | "configuration"
  | "authentication"
  | "rate_limit"
  | "provider_server_error"
  | "timeout"
  | "transport"
  | "invalid_response"
  | "content_filter"
  | "schema_validation"
  | "unknown";

export class AssistantLLMError extends Error {
  public readonly classification: AssistantLLMFailureClassification;
  public readonly httpStatus?: number;
  public readonly providerErrorCode?: string;
  public readonly requestId?: string;

  constructor(
    message: string,
    classification: AssistantLLMFailureClassification,
    httpStatus?: number,
    extra?: { providerErrorCode?: string; requestId?: string },
  ) {
    super(message);
    this.name = "AssistantLLMError";
    this.classification = classification;
    this.httpStatus = httpStatus;
    this.providerErrorCode = extra?.providerErrorCode;
    this.requestId = extra?.requestId;
  }
}

interface AssistantLLMConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  maxOutputTokens: number;
}

/** True when all three ASSISTANT_AZURE_OPENAI_* vars are present. Does not
 * check AZURE_OPENAI_* or OPENAI_* — those belong to extraction and must
 * never be treated as a valid Assistant configuration. */
export function isAssistantLLMConfigured(): boolean {
  return Boolean(
    Deno.env.get("ASSISTANT_AZURE_OPENAI_ENDPOINT") &&
      Deno.env.get("ASSISTANT_AZURE_OPENAI_API_KEY") &&
      Deno.env.get("ASSISTANT_AZURE_OPENAI_DEPLOYMENT"),
  );
}

function getConfig(): AssistantLLMConfig {
  const endpoint = String(Deno.env.get("ASSISTANT_AZURE_OPENAI_ENDPOINT") ?? "").trim().replace(/\/+$/, "");
  const apiKey = Deno.env.get("ASSISTANT_AZURE_OPENAI_API_KEY") ?? "";
  const deployment = Deno.env.get("ASSISTANT_AZURE_OPENAI_DEPLOYMENT") ?? "";
  const maxOutputTokens = parseInt(Deno.env.get("ASSISTANT_OPENAI_MAX_OUTPUT_TOKENS") || "4096", 10);

  const missing: string[] = [];
  if (!endpoint) missing.push("ASSISTANT_AZURE_OPENAI_ENDPOINT");
  if (!apiKey) missing.push("ASSISTANT_AZURE_OPENAI_API_KEY");
  if (!deployment) missing.push("ASSISTANT_AZURE_OPENAI_DEPLOYMENT");
  if (missing.length > 0) {
    throw new AssistantLLMError(
      `Assistant LLM is not configured. Missing: ${missing.join(", ")}. ` +
        "These must be set independently of the lease-extraction AZURE_OPENAI_* / OPENAI_* variables " +
        "(supabase secrets set ASSISTANT_AZURE_OPENAI_ENDPOINT=... ASSISTANT_AZURE_OPENAI_API_KEY=... ASSISTANT_AZURE_OPENAI_DEPLOYMENT=...).",
      "configuration",
    );
  }

  return { endpoint, apiKey, deployment, maxOutputTokens };
}

function classifyError(status: number, body: any): AssistantLLMFailureClassification {
  if (status === 401 || status === 403) return "authentication";
  if (status === 429) return "rate_limit";
  if (status === 400) {
    const msg = String(body?.error?.message ?? "").toLowerCase();
    if (msg.includes("content_filter") || msg.includes("content policy")) return "content_filter";
    return "invalid_response";
  }
  if (status >= 500) return "provider_server_error";
  return "unknown";
}

function isUnsupportedTemperatureError(status: number, body: any): boolean {
  if (status !== 400) return false;
  const param = String(body?.error?.param ?? "").toLowerCase();
  const code = String(body?.error?.code ?? "").toLowerCase();
  return param === "temperature" || code === "unsupported_value";
}

export interface AssistantStructuredCallOpts {
  systemPrompt: string;
  userPrompt: string;
  schemaName: string;
  schema: Record<string, unknown>;
  temperature?: number;
  maxOutputTokens?: number;
}

export type AssistantStructuredStatus = "success" | "refusal" | "truncated" | "schema_error" | "provider_error";

export interface AssistantStructuredResult<T = unknown> {
  status: AssistantStructuredStatus;
  data: T | null;
  errorMessage: string | null;
  classification: AssistantLLMFailureClassification | null;
  promptTokens: number | null;
  completionTokens: number | null;
  model: string | null;
}

async function postToAssistantDeployment(config: AssistantLLMConfig, body: Record<string, unknown>) {
  const url = `${config.endpoint}/openai/v1/chat/completions`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "api-key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (fetchErr: any) {
    const isTimeout = fetchErr?.name === "TimeoutError" || fetchErr?.name === "AbortError";
    throw new AssistantLLMError(
      isTimeout ? "Assistant LLM request timed out after 60s" : `Network error calling Assistant LLM: ${fetchErr?.message}`,
      isTimeout ? "timeout" : "transport",
    );
  }

  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("apim-request-id") ??
    response.headers.get("x-ms-request-id") ??
    "unknown";

  let responseBody: any;
  try {
    responseBody = await response.json();
  } catch {
    throw new AssistantLLMError(
      `Assistant LLM returned non-JSON response (HTTP ${response.status})`,
      "invalid_response",
      response.status,
      { requestId },
    );
  }

  return { response, responseBody, requestId };
}

function stringifyStructuredValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return JSON.stringify(value);
  return "";
}

function extractContentPartText(part: unknown): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  const record = part as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.output_text === "string") return record.output_text;
  if (record.text && typeof record.text === "object" && typeof (record.text as any).value === "string") return (record.text as any).value;
  return "";
}

function extractAssistantMessageContent(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const record = message as Record<string, unknown>;
  const parsed = stringifyStructuredValue(record.parsed);
  if (parsed) return parsed;

  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(extractContentPartText).join("");
}

function extractJsonObjectText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]?.trim().startsWith("{")) return fenced[1].trim();

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return null;
}

function parseAssistantJson<T>(content: string): T | null {
  const candidates = [content.trim(), extractJsonObjectText(content)].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}
/** Call the Assistant's own Azure OpenAI deployment under strict json_schema
 * structured-outputs mode. This is the ONLY call shape the orchestrator uses
 * (both for tool-call turns and the final answer turn) — kept singular
 * deliberately so there is exactly one place credential isolation could be
 * broken, and it's covered by tests asserting it never reads AZURE_OPENAI_*
 * or OPENAI_*. */
export async function callAssistantLLMStructured<T = unknown>(
  opts: AssistantStructuredCallOpts,
): Promise<AssistantStructuredResult<T>> {
  let config: AssistantLLMConfig;
  try {
    config = getConfig();
  } catch (error) {
    if (error instanceof AssistantLLMError) {
      return {
        status: "provider_error",
        data: null,
        errorMessage: error.message,
        classification: error.classification,
        promptTokens: null,
        completionTokens: null,
        model: null,
      };
    }
    throw error;
  }

  const body: Record<string, unknown> = {
    model: config.deployment,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    temperature: opts.temperature ?? 0.1,
    max_completion_tokens: opts.maxOutputTokens ?? config.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: { name: opts.schemaName, strict: true, schema: opts.schema },
    },
  };

  try {
    let { response, responseBody, requestId } = await postToAssistantDeployment(config, body);

    if (!response.ok && isUnsupportedTemperatureError(response.status, responseBody)) {
      const { temperature: _drop, ...bodyWithoutTemperature } = body;
      ({ response, responseBody, requestId } = await postToAssistantDeployment(config, bodyWithoutTemperature));
    }

    if (!response.ok) {
      const classification = classifyError(response.status, responseBody);
      const providerErrorCode = typeof responseBody?.error?.code === "string" ? responseBody.error.code : undefined;
      console.error(
        `[assistant-llm] call failed: http_status=${response.status} provider_error_code=${providerErrorCode ?? "n/a"} request_id=${requestId}`,
      );
      return {
        status: "provider_error",
        data: null,
        errorMessage: responseBody?.error?.message ?? `Assistant LLM HTTP ${response.status}`,
        classification,
        promptTokens: responseBody?.usage?.prompt_tokens ?? null,
        completionTokens: responseBody?.usage?.completion_tokens ?? null,
        model: responseBody?.model ?? config.deployment,
      };
    }

    const choice = responseBody?.choices?.[0];
    const usage = responseBody?.usage ?? {};
    const model = responseBody?.model ?? config.deployment;

    const refusal = typeof choice?.message?.refusal === "string" && choice.message.refusal.length > 0
      ? choice.message.refusal
      : null;
    if (refusal) {
      return {
        status: "refusal",
        data: null,
        errorMessage: refusal,
        classification: null,
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        model,
      };
    }

    if (choice?.finish_reason === "length") {
      return {
        status: "truncated",
        data: null,
        errorMessage: "Assistant LLM response was truncated before completing.",
        classification: null,
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        model,
      };
    }

    const content = extractAssistantMessageContent(choice?.message);
    const data = parseAssistantJson<T>(content);
    if (!data) {
      console.error(`[assistant-llm] schema parse failed: model=${model} finish_reason=${choice?.finish_reason ?? "unknown"} content_preview=${content.slice(0, 300)}`);
      return {
        status: "schema_error",
        data: null,
        errorMessage: "Assistant LLM output was not valid JSON despite strict json_schema mode.",
        classification: "schema_validation",
        promptTokens: usage.prompt_tokens ?? null,
        completionTokens: usage.completion_tokens ?? null,
        model,
      };
    }

    return {
      status: "success",
      data,
      errorMessage: null,
      classification: null,
      promptTokens: usage.prompt_tokens ?? null,
      completionTokens: usage.completion_tokens ?? null,
      model,
    };
  } catch (error) {
    if (error instanceof AssistantLLMError) {
      return {
        status: "provider_error",
        data: null,
        errorMessage: error.message,
        classification: error.classification,
        promptTokens: null,
        completionTokens: null,
        model: null,
      };
    }
    throw error;
  }
}

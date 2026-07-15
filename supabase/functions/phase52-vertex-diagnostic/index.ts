// @ts-nocheck
/**
 * Phase 52B internal-only Vertex diagnostic.
 *
 * This function is deliberately not part of the normal extraction pipeline:
 * - no file_id / uploaded_file_id / lease_id accepted
 * - no Supabase client import
 * - no DB reads/writes
 * - no Azure/Gemini/OpenAI fallback
 * - exactly one Vertex generateContent request through the diagnostic helper
 */

import { corsHeaders } from "../_shared/cors.ts";
import { isInternalCall } from "../_shared/internal-auth.ts";
import { callVertexAISingleRequestDiagnostic } from "../_shared/vertex-ai.ts";

const REJECTED_FIELDS = new Set([
  "file_id",
  "fileId",
  "uploaded_file_id",
  "uploadedFileId",
  "lease_id",
  "leaseId",
  "run_id",
  "runId",
  "org_id",
  "orgId",
  "table",
  "from",
  "select",
  "insert",
  "update",
  "delete",
  "upsert",
  "rpc",
  "provider",
  "provider_override",
  "debug_business_extraction_provider",
  "business_extraction_provider",
  "extraction_provider",
]);

const SYSTEM_PROMPT = `You are a diagnostic commercial real estate lease fact extractor.
Return compact JSON only. Extract facts stated in the sample text into this shape:
{
  "facts": [
    { "field": "landlord|tenant|premises|cam_estimate|administrative_fee|security_deposit", "value": "...", "source_text": "short supporting quote", "confidence": 0.0 }
  ]
}
Do not infer facts not present in the sample.`;

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sanitizeText(value: unknown): string {
  let text = String(value ?? "");
  const replacements = [
    /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi,
    /"private_key"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"client_email"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"access_token"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"authorization"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"x-worker-secret"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"x-internal-service-key"\s*:\s*"(?:\\"|[^"])*"/gi,
  ];
  for (const pattern of replacements) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text.slice(0, 4000);
}

function errorCategory(error: unknown): string {
  const message = String((error as Error)?.message ?? error ?? "").toLowerCase();
  if (/credential|service account|private key|access token|unauthorized|permission|auth/.test(message)) return "auth_or_credentials";
  if (/timeout|abort/.test(message)) return "timeout";
  if (/network|fetch|connection|reset/.test(message)) return "network";
  if (/status 4\d\d/.test(message)) return "provider_client_error";
  if (/status 5\d\d/.test(message)) return "provider_server_error";
  return "provider_error";
}

function parseDiagnosticJson(text: string): unknown {
  const trimmed = String(text ?? "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function validateBody(body: Record<string, unknown>): string | null {
  for (const key of Object.keys(body)) {
    if (REJECTED_FIELDS.has(key)) {
      return `Field '${key}' is not accepted by this diagnostic endpoint.`;
    }
  }

  if (typeof body.sample_text !== "string" || body.sample_text.trim().length < 20) {
    return "sample_text is required and must contain representative lease text.";
  }

  if (body.sample_text.length > 8000) {
    return "sample_text is too long for the single-request diagnostic endpoint.";
  }

  if (body.diagnostic_label != null && typeof body.diagnostic_label !== "string") {
    return "diagnostic_label must be a string when provided.";
  }

  return null;
}

export async function handlePhase52VertexDiagnosticRequest(
  req: Request,
  deps: {
    env?: { get(key: string): string | undefined | null };
    vertexCaller?: typeof callVertexAISingleRequestDiagnostic;
    now?: () => number;
  } = {},
): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ success: false, error_category: "method_not_allowed" }, 405);
  }

  const env = deps.env ?? Deno.env;
  if (!isInternalCall(req, env)) {
    return jsonResponse({ success: false, error_category: "unauthorized" }, 401);
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonResponse({ success: false, error_category: "invalid_json" }, 400);
  }

  const validationError = validateBody(body as Record<string, unknown>);
  if (validationError) {
    return jsonResponse({ success: false, error_category: "invalid_request", message: validationError }, 400);
  }

  const sampleText = (body as Record<string, unknown>).sample_text as string;
  const diagnosticLabel = ((body as Record<string, unknown>).diagnostic_label as string | undefined)?.slice(0, 120) ?? null;
  const vertexCaller = deps.vertexCaller ?? callVertexAISingleRequestDiagnostic;
  const startedAt = deps.now?.() ?? Date.now();

  try {
    const result = await vertexCaller({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: sampleText,
      responseMimeType: "application/json",
      temperature: 0,
      maxOutputTokens: 1200,
    });
    const latencyMs = Math.max(0, result.latencyMs ?? ((deps.now?.() ?? Date.now()) - startedAt));
    return jsonResponse({
      success: true,
      provider: "vertex",
      request_count: 1,
      model: sanitizeText(result.model),
      location: sanitizeText(result.location),
      latency_ms: latencyMs,
      token_usage: {
        input_tokens: result.inputTokens ?? 0,
        output_tokens: result.outputTokens ?? 0,
      },
      diagnostic_label: diagnosticLabel,
      parsed_diagnostic_facts: parseDiagnosticJson(result.content),
      sanitized_response_text: sanitizeText(result.content),
    });
  } catch (error) {
    return jsonResponse({
      success: false,
      provider: "vertex",
      request_count: 1,
      error_category: errorCategory(error),
      sanitized_error: sanitizeText((error as Error)?.message ?? error),
      diagnostic_label: diagnosticLabel,
    }, 502);
  }
}

if (import.meta.main) {
  Deno.serve(handlePhase52VertexDiagnosticRequest);
}

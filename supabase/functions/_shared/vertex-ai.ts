// @ts-nocheck
/**
 * Google Vertex AI (Gemini) helper for Supabase Edge Functions.
 *
 * Required env vars (set via `supabase secrets set`):
 *   VERTEX_PROJECT_ID          — GCP project ID (e.g. "my-project-123")
 *   VERTEX_LOCATION            — Region (e.g. "us-central1")
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Full service account JSON as a single-line string
 *
 * Model: gemini-2.5-flash (verified available on Vertex AI). The 1.5-series
 * models are deprecated/retired and kept only as a last-resort legacy
 * fallback in buildVertexAttempts() — trying them first wasted 3-4 guaranteed
 * 404 round-trips per call before ever reaching a working model.
 *
 * Usage:
 *   import { callVertexAI, callVertexAIJSON } from "../_shared/vertex-ai.ts";
 *   const result = await callVertexAIJSON({ systemPrompt, userPrompt });
 */

const DEFAULT_MODEL = "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// Service account → OAuth2 access token
// ---------------------------------------------------------------------------

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

/**
 * Sign a JWT using the service account private key (RS256).
 * Deno's Web Crypto API supports RSA-PKCS1-v1_5 signing natively.
 */
async function signJWT(payload: Record<string, unknown>, privateKeyPem: string): Promise<string> {
  // Strip PEM headers and decode base64
  const pemBody = privateKeyPem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");

  const keyBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const header = { alg: "RS256", typ: "JWT" };
  const encodeB64Url = (obj: unknown) =>
    btoa(JSON.stringify(obj))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

  const headerB64 = encodeB64Url(header);
  const payloadB64 = encodeB64Url(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput),
  );

  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `${signingInput}.${sigB64}`;
}

let _cachedToken: { token: string; expiresAt: number } | null = null;

function cleanSecretValue(value: string | undefined | null): string | null {
  if (!value) return null;
  let cleaned = String(value).trim();
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.replace(/\\n/g, "\n");
}

function buildServiceAccountFromFallbackVars(privateKeyOverride?: string | null): ServiceAccountKey | null {
  const clientEmail = Deno.env.get("GOOGLE_CLIENT_EMAIL");
  const privateKey =
    cleanSecretValue(privateKeyOverride)?.includes("PRIVATE KEY")
      ? cleanSecretValue(privateKeyOverride)
      : cleanSecretValue(Deno.env.get("GOOGLE_PRIVATE_KEY"));
  const projectId = Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID");

  if (!clientEmail || !privateKey || !projectId) return null;

  console.log("[vertex-ai] Constructing service account key from individual environment variables");
  return {
    client_email: clientEmail,
    private_key: privateKey,
    project_id: projectId,
    type: "service_account",
    private_key_id: "synthesized",
    client_id: "synthesized",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
  };
}

function parseServiceAccountKey(raw: string): ServiceAccountKey | null {
  const cleanedRaw = cleanSecretValue(raw) ?? raw;
  const candidates = [
    raw,
    raw.trim(),
    cleanedRaw,
  ];

  try {
    candidates.push(atob(raw));
  } catch {
    // Not base64; ignore.
  }

  try {
    candidates.push(decodeURIComponent(raw));
    candidates.push(decodeURIComponent(cleanedRaw));
  } catch {
    // Not URL-encoded; ignore.
  }

  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);
      if (typeof parsed === "string") {
        parsed = JSON.parse(parsed);
      }
      if (parsed?.client_email && parsed?.private_key) {
        return {
          ...parsed,
          private_key: String(parsed.private_key).replace(/\\n/g, "\n"),
        };
      }
    } catch {
      // Try the next representation.
    }
  }

  return null;
}

function serviceAccountFingerprint(key: ServiceAccountKey): string {
  return [
    key.client_email,
    key.private_key?.slice(0, 80),
    key.project_id,
  ].join("|");
}

function getServiceAccountCandidates(): Array<{ source: string; key: ServiceAccountKey }> {
  const candidates: Array<{ source: string; key: ServiceAccountKey }> = [];
  const seen = new Set<string>();
  const add = (source: string, key: ServiceAccountKey | null) => {
    if (!key) return;
    const fingerprint = serviceAccountFingerprint(key);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    candidates.push({ source, key });
  };

  const saKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
  if (saKeyRaw) {
    add("GOOGLE_SERVICE_ACCOUNT_KEY", parseServiceAccountKey(saKeyRaw));
    // Some deployments put only the private key in GOOGLE_SERVICE_ACCOUNT_KEY
    // and keep client_email/project_id in split vars. Treat that as a second
    // valid representation, but do not let a stale JSON key block it.
    add("GOOGLE_SERVICE_ACCOUNT_KEY_PRIVATE_KEY_WITH_SPLIT_METADATA", buildServiceAccountFromFallbackVars(saKeyRaw));
  }
  add("GOOGLE_CLIENT_EMAIL_GOOGLE_PRIVATE_KEY", buildServiceAccountFromFallbackVars());

  return candidates;
}

async function requestAccessTokenForServiceAccount(saKey: ServiceAccountKey): Promise<{
  token: string;
  expiresIn: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  const iat = now;
  const exp = now + 3600; // 1 hour

  const jwtPayload = {
    iss: saKey.client_email,
    sub: saKey.client_email,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    iat,
    exp,
  };

  const jwt = await signJWT(jwtPayload, saKey.private_key);

  let tokenRes: Response;
  try {
    assertExternalProviderCallsAllowed("Google OAuth token endpoint");
    tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    });
  } catch (fetchErr) {
    // The OAuth token endpoint itself was unreachable -- a temporary network
    // condition, not a credential problem. Fallback-eligible.
    throw new VertexProviderError(
      `Network error reaching Google OAuth token endpoint: ${(fetchErr as Error)?.message ?? fetchErr}`,
      "network_error",
    );
  }

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => "unknown");
    const status = tokenRes.status;
    // Azure+Vertex Phase 4E: distinguish a permanent credential/config
    // problem (invalid_grant, malformed key, revoked SA -> 400/401/403) from
    // a temporary token-service outage (429/5xx) -- only the latter is
    // fallback-eligible; a bad credential must never silently fall back to
    // legacy_hybrid and hide a real configuration defect.
    const classification: VertexFailureClassification =
      status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "auth_error";
    throw new VertexProviderError(`Failed to get Google access token: ${status} ${err}`, classification, status);
  }

  const tokenData = await tokenRes.json();
  return {
    token: tokenData.access_token,
    expiresIn: tokenData.expires_in ?? 3600,
  };
}

export async function validateVertexAIAuth(): Promise<{
  ok: boolean;
  source?: string;
  error?: string;
  checked_sources: string[];
}> {
  const candidates = getServiceAccountCandidates();
  const checked_sources = candidates.map((candidate) => candidate.source);
  if (candidates.length === 0) {
    return {
      ok: false,
      error: "Vertex AI service account is not configured",
      checked_sources,
    };
  }

  let lastError = "";
  for (const candidate of candidates) {
    try {
      await requestAccessTokenForServiceAccount(candidate.key);
      return { ok: true, source: candidate.source, checked_sources };
    } catch (error) {
      lastError = error?.message ?? String(error);
      console.warn(`[vertex-ai] Credential source ${candidate.source} failed token validation: ${lastError}`);
    }
  }

  return {
    ok: false,
    error: lastError || "All configured Vertex AI credentials failed token validation",
    checked_sources,
  };
}

/**
 * Get a Google OAuth2 access token from the service account key.
 * Caches the token until 5 minutes before expiry.
 */
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (_cachedToken && _cachedToken.expiresAt > now + 300) {
    return _cachedToken.token;
  }

  const candidates = getServiceAccountCandidates();
  if (candidates.length === 0) {
    // No credential configured at all -- permanent, not fallback-eligible.
    throw new VertexProviderError("Vertex AI service account is not configured", "auth_error");
  }

  let lastError = "";
  let lastClassification: VertexFailureClassification = "auth_error";
  for (const candidate of candidates) {
    try {
      const tokenData = await requestAccessTokenForServiceAccount(candidate.key);
      console.log(`[vertex-ai] Authenticated with credential source ${candidate.source}`);
      _cachedToken = {
        token: tokenData.token,
        expiresAt: now + tokenData.expiresIn,
      };
      return _cachedToken.token;
    } catch (error) {
      lastError = error?.message ?? String(error);
      lastClassification = error instanceof VertexProviderError ? error.classification : "auth_error";
      console.warn(`[vertex-ai] Credential source ${candidate.source} failed: ${lastError}`);
    }
  }

  // Propagate whichever classification the LAST attempted candidate failed
  // with -- if every configured credential hit a temporary condition
  // (network/rate-limited/server), the overall failure is temporary too and
  // fallback-eligible; only genuinely bad/missing credentials stay auth_error.
  throw new VertexProviderError(lastError || "All configured Vertex AI credentials failed", lastClassification);
}

export async function getGoogleCloudAccessToken(): Promise<string> {
  return await getAccessToken();
}

export function getGoogleCloudProjectId(): string | null {
  return Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID") || null;
}

// ---------------------------------------------------------------------------
// Vertex AI Gemini API call
// ---------------------------------------------------------------------------

// Azure+Vertex Phase 4E: structured failure classification so callers (the
// business-extraction orchestrator's acceptance/fallback logic) never have
// to infer what went wrong by parsing a free-text warning/error message.
export type VertexFailureClassification =
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "auth_error"
  | "network_error"
  | "budget_exhausted"
  /** Every model/location combination in the sweep returned 404 -- distinct
   *  from a single-attempt "unknown": this deployment has no working model
   *  available, not a transient per-attempt failure. Fallback-eligible. */
  | "model_unavailable"
  /** Provider call succeeded but the response could not be parsed as JSON
   *  even after the bounded repair attempt (or returned no content at all —
   *  callVertexAIJSON does not itself distinguish the two). Fallback-eligible. */
  | "malformed_response"
  /** Provider call succeeded and parsed, but yielded zero meaningful facts —
   *  a materially different signal from malformed_response for acceptance
   *  evaluation. Fallback-eligible only when this is the ONLY signal (i.e.
   *  no meaningful facts anywhere in the document), never merely because one
   *  chunk was empty while others produced real facts. */
  | "empty_extraction"
  | "unknown";

export class VertexProviderError extends Error {
  classification: VertexFailureClassification;
  httpStatus?: number;
  constructor(message: string, classification: VertexFailureClassification, httpStatus?: number) {
    super(message);
    this.name = "VertexProviderError";
    this.classification = classification;
    this.httpStatus = httpStatus;
  }
}


function assertExternalProviderCallsAllowed(providerName: string): void {
  if (String(Deno.env.get("DISABLE_EXTERNAL_PROVIDER_CALLS") ?? "").toLowerCase() === "true") {
    throw new VertexProviderError(
      `External provider calls are disabled; refusing to contact ${providerName}`,
      "network_error",
    );
  }
}
export interface VertexAIOptions {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Response MIME type — "application/json" (default) or "text/plain" for raw text output */
  responseMimeType?: string;
  /**
   * Absolute epoch-ms deadline for the whole model/location sweep. Checked
   * before each model/location attempt, and each request timeout is clamped to
   * the remaining budget so an in-flight attempt is aborted when the configured
   * budget expires. Callers that need a bounded total Vertex time (the
   * business-extraction orchestrator) must set this; omitted, the sweep behaves
   * exactly as before.
   */
  deadlineAt?: number;
}

export interface VertexAIFileOptions extends VertexAIOptions {
  /** Raw file bytes to send as an inline part */
  fileBytes?: Uint8Array;
  /** Raw base64 string */
  fileBase64?: string;
  /** Public HTTP(S) URL or Cloud Storage URI to avoid inline base64 uploads */
  fileUri?: string;
  /** MIME type of the file (e.g. "application/pdf", "image/jpeg") */
  fileMimeType: string;
}

export interface VertexAIResponse {
  content: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call Vertex AI Gemini and return the text response.
 * Implements robust fallback logic for models and locations to handle 404s.
 */
export async function callVertexAI(opts: VertexAIOptions): Promise<VertexAIResponse> {
  const projectId = Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID");
  if (!projectId) {
    throw new VertexProviderError(
      "Neither VERTEX_PROJECT_ID nor GOOGLE_PROJECT_ID environment variable is set",
      "auth_error",
    );
  }

  const primaryLocation = Deno.env.get("VERTEX_LOCATION") || Deno.env.get("GOOGLE_LOCATION") || "us-central1";
  const primaryModel = opts.model ?? DEFAULT_MODEL;

  // Ordered list of (location, model) to try if primary fails with 404
  const attempts = buildVertexAttempts(primaryLocation, primaryModel);

  let accessToken: string;
  try {
    accessToken = await getAccessToken();
  } catch (credErr) {
    // getAccessToken() already throws a properly-classified VertexProviderError
    // (auth_error for bad/missing credentials, network_error/rate_limited/
    // server_error for a temporary token-service outage) -- propagate that
    // classification unchanged rather than collapsing everything to auth_error.
    if (credErr instanceof VertexProviderError) throw credErr;
    throw new VertexProviderError(
      `Vertex AI credentials error: ${(credErr as Error)?.message ?? credErr}`,
      "auth_error",
    );
  }
  let lastError: Error | null = null;
  let consecutiveNetworkErrors = 0;
  let notFoundCount = 0;
  const MAX_NETWORK_ERRORS = 2;
  // Round-3 correction: a between-attempts deadline check alone can still
  // overshoot by one full 30s request. Clamp each individual request's own
  // timeout to whatever budget remains, so total elapsed time stays close to
  // deadlineAt rather than deadlineAt + one more full attempt.
  const DEFAULT_ATTEMPT_TIMEOUT_MS = 30000;

  for (const { loc, mod } of attempts) {
    let attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS;
    if (opts.deadlineAt) {
      const remainingMs = opts.deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new VertexProviderError(
          "Vertex AI attempt budget exhausted before all model/location combinations were tried",
          "budget_exhausted",
        );
      }
      attemptTimeoutMs = Math.min(DEFAULT_ATTEMPT_TIMEOUT_MS, remainingMs);
    }
    try {
      console.log(`[vertex-ai] Trying ${mod} in ${loc}...`);
      const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${loc}/publishers/google/models/${mod}:generateContent`;

      const requestBody: Record<string, unknown> = {
        contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
        generationConfig: {
          maxOutputTokens: opts.maxOutputTokens ?? 2048,
          temperature: opts.temperature ?? 0,
          responseMimeType: "application/json",
        },
      };

      if (opts.systemPrompt) {
        requestBody.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
      }

      assertExternalProviderCallsAllowed("Vertex AI generateContent endpoint");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(attemptTimeoutMs),
      });

      if (response.ok) {
        consecutiveNetworkErrors = 0;
        const data = await response.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
        console.log(`[vertex-ai] Success with ${mod} in ${loc}`);
        return { content, model: mod, inputTokens, outputTokens };
      }

      if (response.status === 404) {
        consecutiveNetworkErrors = 0;
        notFoundCount++;
        console.warn(`[vertex-ai] 404 NOT FOUND: Project=${projectId}, Model=${mod}, Loc=${loc}, URL=${url}. Ensure Vertex AI API is enabled in this project.`);
        continue;
      }

      consecutiveNetworkErrors = 0;
      const errText = await response.text().catch(() => "unknown error");
      const statusMsg = `Vertex AI API error ${response.status}: ${errText}`;
      throw new VertexProviderError(
        statusMsg,
        response.status === 429 ? "rate_limited" : "server_error",
        response.status,
      );
    } catch (err) {
      lastError = err;
      if (err instanceof VertexProviderError) {
        // Already structured (429/5xx/budget_exhausted/auth from above) —
        // propagate as-is rather than re-classifying via string matching.
        throw err;
      }
      const msg = String(err?.message || "");
      const isNetworkError = msg.includes("connection") || msg.includes("network") || msg.includes("ECONNRESET") || msg.includes("reset");
      if (isNetworkError) {
        consecutiveNetworkErrors++;
        if (consecutiveNetworkErrors >= MAX_NETWORK_ERRORS) {
          // All Vertex AI regions share the same network path — if 2 consecutive
          // requests fail with connection reset, the endpoint is unreachable (likely
          // an IPv6 routing issue from the edge runtime). Give up so callers can
          // fall back to GEMINI_API_KEY instead of retrying all 32 combinations.
          const networkMsg = `Vertex AI unreachable after ${MAX_NETWORK_ERRORS} consecutive network errors (IPv6 routing issue likely). Configure GEMINI_API_KEY as fallback.`;
          console.error(`[vertex-ai] ${networkMsg}`);
          throw new VertexProviderError(networkMsg, "network_error");
        }
        console.warn(`[vertex-ai] Network error ${consecutiveNetworkErrors}/${MAX_NETWORK_ERRORS} for ${mod} in ${loc}: ${msg.slice(0, 120)}; trying next`);
        continue;
      }
      consecutiveNetworkErrors = 0;
      if (msg.includes("404") || err?.name === "TimeoutError" || err?.name === "AbortError") {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          console.warn(`[vertex-ai] Request to ${mod} in ${loc} timed out after 30s; trying next`);
        }
        continue;
      }
      throw err;
    }
  }

  if (lastError instanceof VertexProviderError) throw lastError;
  if (notFoundCount === attempts.length) {
    // Every model/location combination in the sweep was 404 -- this
    // deployment has no working model available at all, a distinct
    // condition from a single attempt's transient failure.
    throw new VertexProviderError(
      `All ${attempts.length} Vertex AI model/location combinations returned 404 — no configured model is available in this project`,
      "model_unavailable",
    );
  }
  const lastMsg = String(lastError?.message || "");
  const wasTimeout = lastError?.name === "TimeoutError" || lastError?.name === "AbortError" || lastMsg.includes("timed out");
  throw new VertexProviderError(
    lastError?.message || "All Vertex AI model attempts failed",
    wasTimeout ? "timeout" : "unknown",
  );
}

export type VertexAIDiagnosticStageName =
  | "auth_config_loaded"
  | "jwt_created"
  | "oauth_request_started"
  | "oauth_request_completed"
  | "vertex_request_started"
  | "vertex_response_received"
  | "response_parsed";

export interface VertexAIDiagnosticStageEvent {
  stage: VertexAIDiagnosticStageName;
  elapsedMs: number;
}

export class VertexAIDiagnosticError extends Error {
  category: string;
  status?: number;

  constructor(category: string, message: string, status?: number) {
    super(message);
    this.name = "VertexAIDiagnosticError";
    this.category = category;
    this.status = status;
  }
}

export interface VertexAISingleRequestDiagnosticOptions extends VertexAIOptions {
  /** Fixed model for the diagnostic request. Defaults to the primary Vertex model only. */
  model?: string;
  /** Fixed location for the diagnostic request. Defaults to VERTEX_LOCATION / GOOGLE_LOCATION / us-central1. */
  location?: string;
  /** Test-only escape hatch so unit tests never request an OAuth token. */
  accessToken?: string;
  /** Test-only fetch implementation for the Vertex generateContent request. */
  fetchImpl?: typeof fetch;
  /** Test-only fetch implementation for the OAuth token request. */
  oauthFetchImpl?: typeof fetch;
  /** Test-only JWT override so timeout/error paths can be tested without embedding a private key. */
  jwtForTest?: string;
  timeoutMs?: number;
  oauthTimeoutMs?: number;
  vertexTimeoutMs?: number;
  onStage?: (event: VertexAIDiagnosticStageEvent) => void;
}

function sanitizeDiagnosticProviderText(value: unknown): string {
  let text = String(value ?? "");
  const replacements = [
    /Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,
    /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/gi,
    /"private_key"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"client_email"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"access_token"\s*:\s*"(?:\\"|[^"])*"/gi,
    /"authorization"\s*:\s*"(?:\\"|[^"])*"/gi,
  ];
  for (const pattern of replacements) {
    text = text.replace(pattern, "[REDACTED]");
  }
  return text.slice(0, 500);
}
function emitDiagnosticStage(
  onStage: ((event: VertexAIDiagnosticStageEvent) => void) | undefined,
  stage: VertexAIDiagnosticStageName,
  start: number,
) {
  try {
    onStage?.({ stage, elapsedMs: Date.now() - start });
  } catch {
    // Stage callbacks are diagnostic-only and must never affect execution.
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  timeoutCategory: string,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    const message = String((error as Error)?.message ?? error ?? "");
    if ((error as Error)?.name === "AbortError" || /abort|timeout/i.test(message)) {
      throw new VertexAIDiagnosticError(timeoutCategory, `${timeoutCategory}: request exceeded ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestDiagnosticAccessToken(opts: VertexAISingleRequestDiagnosticOptions, start: number): Promise<string> {
  const candidates = getServiceAccountCandidates();
  emitDiagnosticStage(opts.onStage, "auth_config_loaded", start);
  if (candidates.length === 0) {
    throw new VertexAIDiagnosticError("auth_or_credentials", "Vertex AI service account is not configured");
  }

  const saKey = candidates[0].key;
  const now = Math.floor(Date.now() / 1000);
  const jwt = opts.jwtForTest ?? await signJWT({
    iss: saKey.client_email,
    sub: saKey.client_email,
    aud: "https://oauth2.googleapis.com/token",
    scope: "https://www.googleapis.com/auth/cloud-platform",
    iat: now,
    exp: now + 3600,
  }, saKey.private_key);
  emitDiagnosticStage(opts.onStage, "jwt_created", start);

  const oauthFetchImpl = opts.oauthFetchImpl || fetch;
  const oauthTimeoutMs = opts.oauthTimeoutMs ?? 5000;
  emitDiagnosticStage(opts.onStage, "oauth_request_started", start);
  assertExternalProviderCallsAllowed("Google OAuth token endpoint");
  const tokenRes = await fetchWithTimeout(
    oauthFetchImpl,
    "https://oauth2.googleapis.com/token",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    },
    oauthTimeoutMs,
    "oauth_timeout",
  );
  emitDiagnosticStage(opts.onStage, "oauth_request_completed", start);

  const tokenText = await tokenRes.text().catch(() => "");
  if (!tokenRes.ok) {
    throw new VertexAIDiagnosticError(
      "oauth_error",
      `OAuth token request failed with status ${tokenRes.status}: ${sanitizeDiagnosticProviderText(tokenText)}`,
      tokenRes.status,
    );
  }

  let tokenData: any = null;
  try {
    tokenData = tokenText ? JSON.parse(tokenText) : null;
  } catch {
    throw new VertexAIDiagnosticError("oauth_error", "OAuth token response was not valid JSON");
  }

  const token = tokenData?.access_token;
  if (!token) {
    throw new VertexAIDiagnosticError("oauth_error", "OAuth token response did not contain an access token");
  }
  return String(token);
}

/**
 * Phase 52B/52C diagnostic helper: one Vertex generateContent request, no
 * model fallback, no location fallback, no retry loop, no Gemini/OpenAI
 * fallback. This intentionally does not call callVertexAI(), whose production
 * behavior retries across model/location attempts.
 */
export async function callVertexAISingleRequestDiagnostic(
  opts: VertexAISingleRequestDiagnosticOptions,
): Promise<VertexAIResponse & { location: string; latencyMs: number; stages: VertexAIDiagnosticStageEvent[] }> {
  const start = Date.now();
  const stages: VertexAIDiagnosticStageEvent[] = [];
  const onStage = opts.onStage;
  const recordStage = (event: VertexAIDiagnosticStageEvent) => {
    stages.push(event);
    onStage?.(event);
  };

  const projectId = Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID");
  if (!projectId) {
    throw new VertexAIDiagnosticError("auth_or_credentials", "Neither VERTEX_PROJECT_ID nor GOOGLE_PROJECT_ID environment variable is set");
  }

  const location = opts.location || Deno.env.get("VERTEX_LOCATION") || Deno.env.get("GOOGLE_LOCATION") || "us-central1";
  const model = opts.model || Deno.env.get("VERTEX_MODEL") || Deno.env.get("GEMINI_MODEL") || DEFAULT_MODEL;
  const accessToken = opts.accessToken || await requestDiagnosticAccessToken({ ...opts, onStage: recordStage }, start);
  const fetchImpl = opts.fetchImpl || fetch;
  const vertexTimeoutMs = opts.vertexTimeoutMs ?? opts.timeoutMs ?? 30000;
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens ?? 1200,
      temperature: opts.temperature ?? 0,
      responseMimeType: opts.responseMimeType ?? "application/json",
    },
  };

  if (opts.systemPrompt) {
    requestBody.systemInstruction = { parts: [{ text: opts.systemPrompt }] };
  }

  emitDiagnosticStage(recordStage, "vertex_request_started", start);
  assertExternalProviderCallsAllowed("Vertex AI diagnostic endpoint");
  const response = await fetchWithTimeout(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
      },
      body: JSON.stringify(requestBody),
    },
    vertexTimeoutMs,
    "vertex_timeout",
  );
  emitDiagnosticStage(recordStage, "vertex_response_received", start);

  const textBody = await response.text().catch(() => "");
  let data: any = null;
  try {
    data = textBody ? JSON.parse(textBody) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new VertexAIDiagnosticError(
      "vertex_error",
      `Vertex AI single diagnostic request failed with status ${response.status}: ${sanitizeDiagnosticProviderText(textBody)}`,
      response.status,
    );
  }

  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data?.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data?.usageMetadata?.candidatesTokenCount ?? 0;
  emitDiagnosticStage(recordStage, "response_parsed", start);
  return { content, model, location, inputTokens, outputTokens, latencyMs: Date.now() - start, stages };
}
/**
 * Call Vertex AI and parse the response as JSON.
 * Strips markdown code fences if present.
 * Returns null if parsing fails.
 */
export async function callVertexAIJSON<T = unknown>(opts: VertexAIOptions): Promise<T | null> {
  const response = await callVertexAI(opts);

  let text = response.content.trim();
  // Strip markdown code fences if model added them despite responseMimeType
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  if (!text) {
    console.error(`[vertex-ai] Empty response from ${response.model} (in=${response.inputTokens} out=${response.outputTokens} tokens). Likely model refusal or safety filter.`);
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Try to repair common JSON truncation issues first.
    const repaired = tryRepairJson(text);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired) as T;
        console.warn(`[vertex-ai] Recovered from malformed JSON via repair (orig length ${text.length}). Prompt: "${opts.userPrompt.slice(0, 120)}…"`);
        return parsed;
      } catch {
        // fall through to error reporting
      }
    }
    console.error(
      `[vertex-ai] Failed to parse JSON from ${response.model} ` +
      `(out=${response.outputTokens} tokens, content length=${text.length}). ` +
      `First 400 chars: ${JSON.stringify(text.slice(0, 400))} ` +
      `Last 200 chars: ${JSON.stringify(text.slice(-200))} ` +
      `Parse error: ${err?.message || err}`,
    );
    return null;
  }
}

// Handles the common truncation case where Gemini hits maxOutputTokens mid-
// object — closes any open string + balances braces. Returns null when the
// text is too malformed to recover.
function tryRepairJson(text: string): string | null {
  let candidate = text;
  // If the last char is mid-string, drop everything after the last whole
  // value so we can close cleanly.
  const lastClose = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (lastClose < 0) return null;
  candidate = candidate.slice(0, lastClose + 1);
  return candidate;
}

/**
 * Sanitize literal control characters inside JSON string values.
 * Gemini sometimes includes literal \n, \r, \t characters verbatim inside
 * "text" fields when extracting document content. These make JSON.parse throw
 * a SyntaxError even though the rest of the JSON structure is valid.
 * This function replaces them with proper JSON escape sequences.
 */
function sanitizeJsonControlChars(text: string): string {
  let inString = false;
  let escaped = false;
  let result = "";
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && inString) {
      escaped = true;
      result += char;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }
    if (inString && char.charCodeAt(0) < 0x20) {
      if (char === "\n") { result += "\\n"; continue; }
      if (char === "\r") { result += "\\r"; continue; }
      if (char === "\t") { result += "\\t"; continue; }
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

/**
 * Call Vertex AI Gemini with a file (PDF, image, etc.) as an inline part.
 * Gemini 1.5 Pro natively understands PDFs, images, Word docs, and more.
 * Returns the text response.
 */
export async function callVertexAIWithFile(opts: VertexAIFileOptions): Promise<VertexAIResponse> {
  const projectId = Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID");
  const primaryLocation = Deno.env.get("VERTEX_LOCATION") || Deno.env.get("GOOGLE_LOCATION") || "us-central1";

  if (!projectId) {
    throw new Error("Neither VERTEX_PROJECT_ID nor GOOGLE_PROJECT_ID environment variable is set");
  }

  const primaryModel = opts.model ?? DEFAULT_MODEL;
  const accessToken = await getAccessToken();

  const filePart = buildFilePart(opts);

  const genConfig: Record<string, unknown> = {
    maxOutputTokens: opts.maxOutputTokens ?? 32768,
    temperature: opts.temperature ?? 0,
  };

  // Only set responseMimeType when JSON is requested (default).
  // For plain text (OCR), omitting it avoids Gemini wrapping text in JSON.
  const mimeTypeResp = opts.responseMimeType ?? "application/json";
  if (mimeTypeResp === "application/json") {
    genConfig.responseMimeType = "application/json";
  }

  const requestBody: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [
          {
            ...filePart,
          },
          { text: opts.userPrompt },
        ],
      },
    ],
    generationConfig: genConfig,
  };

  if (opts.systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  let lastError: Error | null = null;
  let consecutiveNetworkErrors = 0;
  const MAX_NETWORK_ERRORS = 2;
  for (const { loc, mod } of buildVertexAttempts(primaryLocation, primaryModel)) {
    const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${loc}/publishers/google/models/${mod}:generateContent`;
    try {
      console.log(`[vertex-ai] Trying file model ${mod} in ${loc}...`);
      assertExternalProviderCallsAllowed("Vertex AI file generateContent endpoint");
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(110000),
      });

      if (response.ok) {
        consecutiveNetworkErrors = 0;
        const data = await response.json();
        const candidate = data.candidates?.[0];
        const content = candidate?.content?.parts?.[0]?.text ?? "";
        const finishReason = candidate?.finishReason ?? "";
        const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
        console.log(`[vertex-ai] File success with ${mod} in ${loc} (finishReason=${finishReason || "STOP"})`);
        if (!content && finishReason && finishReason !== "STOP") {
          // Model refused or hit a limit — surface the reason so callers can report it
          lastError = new Error(`Gemini returned empty content (finishReason=${finishReason})`);
          continue;
        }
        return { content, model: mod, inputTokens, outputTokens };
      }

      const errText = await response.text().catch(() => "unknown error");
      lastError = new Error(`Vertex AI API error ${response.status}: ${errText}`);
      if (response.status === 404) {
        // 404 = model not available in this location; try the next combination
        consecutiveNetworkErrors = 0;
        console.warn(`[vertex-ai] File model 404 for ${mod} in ${loc}: ${errText.slice(0, 220)}`);
        continue;
      }
      if (response.status === 400) {
        // 400 = bad request. This usually means the file is too large, the MIME type
        // is unsupported, or the request format is wrong — none of which a different
        // model or location can fix. Throw immediately to surface the real error.
        throw lastError;
      }
      consecutiveNetworkErrors = 0;
      throw lastError;
    } catch (err) {
      lastError = err;
      const msg = String(err?.message || "");
      const isNetworkError = msg.includes("connection") || msg.includes("network") || msg.includes("ECONNRESET") || msg.includes("reset");
      if (isNetworkError) {
        consecutiveNetworkErrors++;
        if (consecutiveNetworkErrors >= MAX_NETWORK_ERRORS) {
          const networkMsg = `Vertex AI unreachable after ${MAX_NETWORK_ERRORS} consecutive network errors (IPv6 routing issue likely). Configure GEMINI_API_KEY as fallback.`;
          console.error(`[vertex-ai] ${networkMsg}`);
          throw new Error(networkMsg);
        }
        console.warn(`[vertex-ai] File network error ${consecutiveNetworkErrors}/${MAX_NETWORK_ERRORS} for ${mod} in ${loc}: ${msg.slice(0, 120)}; trying next`);
        continue;
      }
      consecutiveNetworkErrors = 0;
      if (
        msg.includes("404") ||
        err?.name === "TimeoutError" ||
        err?.name === "AbortError"
      ) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          console.warn(`[vertex-ai] File request to ${mod} in ${loc} timed out after 110s`);
          throw new Error(
            `Vertex AI file request timed out after 110s for ${mod} in ${loc}. ` +
            "Use a text-searchable PDF, configure GEMINI_API_KEY fallback, or move OCR to a longer-running worker.",
          );
        }
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All Vertex AI file model attempts failed");
}

function buildFilePart(opts: VertexAIFileOptions): Record<string, unknown> {
  if (opts.fileUri) {
    console.log(`[vertex-ai] Using fileData URI for ${opts.fileMimeType}`);
    return {
      fileData: {
        mimeType: opts.fileMimeType,
        fileUri: opts.fileUri,
      },
    };
  }

  let base64Data: string;
  if (opts.fileBase64) {
    base64Data = opts.fileBase64;
  } else if (opts.fileBytes) {
    base64Data = uint8ToBase64(opts.fileBytes);
  } else {
    throw new Error("Must provide fileUri, fileBase64, or fileBytes");
  }

  return {
    inlineData: {
      mimeType: opts.fileMimeType,
      data: base64Data,
    },
  };
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Supabase Edge isolates are memory constrained. Avoid Array.from(bytes)
  // and avoid creating one giant binary string before btoa().
  const chunkSize = 0x6000; // multiple of 3 so only the final chunk is padded
  const encodedChunks: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let chunkString = "";
    for (let j = 0; j < chunk.length; j++) {
      chunkString += String.fromCharCode(chunk[j]);
    }
    encodedChunks.push(btoa(chunkString));
  }
  return encodedChunks.join("");
}

function buildVertexAttempts(primaryLocation: string, primaryModel: string) {
  const locations = uniqueStrings([primaryLocation, "us-central1", "us-east4", "global"]);
  // Verified-available models first; deprecated/retired 1.5-series models
  // last, as a legacy fallback only — they 404 on current Vertex deployments.
  const models = uniqueStrings([
    primaryModel,
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash",
    "gemini-1.5-flash-002",
    "gemini-1.5-flash-001",
    "gemini-1.5-pro-002",
  ]);

  // Try each model across ALL locations before falling back to the next model.
  // This finds a working region for a given model before giving up on it entirely —
  // important for 404s where a model may be available in one region but not another.
  const attempts: Array<{ loc: string; mod: string }> = [];
  for (const mod of models) {
    for (const loc of locations) {
      attempts.push({ loc, mod });
    }
  }
  return attempts;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => String(value).trim()).filter(Boolean))];
}

// ---------------------------------------------------------------------------
// Google AI (Gemini API key) — simpler alternative to Vertex AI service account
// Uses GEMINI_API_KEY or GOOGLE_API_KEY with generativelanguage.googleapis.com
// No service account or project ID needed.
// ---------------------------------------------------------------------------

/**
 * Call Gemini via the Google AI Developer API (api.google.ai / generativelanguage).
 * Requires GEMINI_API_KEY or GOOGLE_API_KEY secret — no service account needed.
 */
export async function callGeminiWithAPIKey(opts: VertexAIOptions): Promise<VertexAIResponse> {
  const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.userPrompt }] }],
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
      temperature: opts.temperature ?? 0,
      responseMimeType: "application/json",
    },
  };

  if (opts.systemPrompt) {
    requestBody.system_instruction = { parts: [{ text: opts.systemPrompt }] };
  }

  assertExternalProviderCallsAllowed("Gemini Developer API endpoint");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(45000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "unknown");
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  return { content, model, inputTokens, outputTokens };
}

/**
 * Call Gemini via the Google AI Developer API with a file (PDF/image).
 * Requires GEMINI_API_KEY or GOOGLE_API_KEY — no service account needed.
 */
export async function callGeminiWithAPIKeyAndFile(opts: VertexAIFileOptions): Promise<VertexAIResponse> {
  const apiKey = Deno.env.get("GEMINI_API_KEY") || Deno.env.get("GOOGLE_API_KEY");
  if (!apiKey) throw new Error("GEMINI_API_KEY (or GOOGLE_API_KEY) is not set");

  const model = opts.model ?? DEFAULT_MODEL;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const filePart = buildFilePart(opts);

  const parts: unknown[] = [filePart, { text: opts.userPrompt }];
  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      temperature: opts.temperature ?? 0,
    },
  };

  if (opts.systemPrompt) {
    requestBody.system_instruction = { parts: [{ text: opts.systemPrompt }] };
  }

  assertExternalProviderCallsAllowed("Gemini Developer API endpoint");
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => "unknown");
    throw new Error(`Gemini API ${response.status}: ${err.slice(0, 300)}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
  return { content, model, inputTokens, outputTokens };
}

/**
 * Call Vertex AI with a file and parse the response as JSON.
 * Matches callVertexAIJSON: strips code fences, applies tryRepairJson on
 * truncation, logs detailed diagnostics on failure.
 */
export async function callVertexAIFileJSON<T = unknown>(opts: VertexAIFileOptions): Promise<T | null> {
  const response = await callVertexAIWithFile(opts);

  let text = response.content.trim();
  // Strip markdown code fences the model sometimes adds despite responseMimeType
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();

  if (!text) {
    const reason = response.outputTokens === 0
      ? "model returned 0 output tokens — likely a safety filter, unsupported content type, or billing issue"
      : "model returned empty text despite non-zero tokens — possible response format mismatch";
    console.error(
      `[vertex-ai] Empty file-mode response from ${response.model} ` +
      `(in=${response.inputTokens} out=${response.outputTokens} tokens): ${reason}.`,
    );
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch (err) {
    // Step 1: Sanitize literal control characters (e.g. newlines) inside strings.
    // Gemini occasionally returns verbatim document text with literal \n inside
    // JSON string values — valid in the document but illegal in JSON.
    const sanitized = sanitizeJsonControlChars(text);
    if (sanitized !== text) {
      try {
        const parsed = JSON.parse(sanitized) as T;
        console.warn(
          `[vertex-ai] File-mode: recovered from literal control chars in JSON strings ` +
          `(orig length ${text.length}, model=${response.model}).`,
        );
        return parsed;
      } catch {
        // fall through to truncation repair
      }
    }

    // Step 2: Attempt truncation repair on the (possibly sanitized) text.
    const repaired = tryRepairJson(sanitized !== text ? sanitized : text);
    if (repaired) {
      try {
        const parsed = JSON.parse(repaired) as T;
        console.warn(
          `[vertex-ai] File-mode: recovered from malformed JSON via repair ` +
          `(orig length ${text.length}, model=${response.model}). ` +
          `Prompt: "${opts.userPrompt.slice(0, 120)}…"`,
        );
        return parsed;
      } catch {
        // fall through to full error
      }
    }
    console.error(
      `[vertex-ai] File-mode: failed to parse JSON from ${response.model} ` +
      `(out=${response.outputTokens} tokens, content length=${text.length}). ` +
      `First 400 chars: ${JSON.stringify(text.slice(0, 400))} ` +
      `Last 200 chars: ${JSON.stringify(text.slice(-200))} ` +
      `Parse error: ${err?.message || err}`,
    );
    return null;
  }
}

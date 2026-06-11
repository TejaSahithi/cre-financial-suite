// @ts-nocheck
/**
 * Google Vertex AI (Gemini) helper for Supabase Edge Functions.
 *
 * Required env vars (set via `supabase secrets set`):
 *   VERTEX_PROJECT_ID          — GCP project ID (e.g. "my-project-123")
 *   VERTEX_LOCATION            — Region (e.g. "us-central1")
 *   GOOGLE_SERVICE_ACCOUNT_KEY — Full service account JSON as a single-line string
 *
 * Model: gemini-1.5-pro-002  (best accuracy for structured extraction)
 *
 * Usage:
 *   import { callVertexAI, callVertexAIJSON } from "../_shared/vertex-ai.ts";
 *   const result = await callVertexAIJSON({ systemPrompt, userPrompt });
 */

const DEFAULT_MODEL = "gemini-2.5-flash-lite";

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

/**
 * Get a Google OAuth2 access token from the service account key.
 * Caches the token until 5 minutes before expiry.
 */
async function getAccessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  if (_cachedToken && _cachedToken.expiresAt > now + 300) {
    return _cachedToken.token;
  }

  const saKeyRaw = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_KEY");
  let saKey: ServiceAccountKey;

  if (!saKeyRaw) {
    const fallbackKey = buildServiceAccountFromFallbackVars();
    if (!fallbackKey) throw new Error("Vertex AI service account is not configured");
    saKey = fallbackKey;
  } else {
    const parsedKey = parseServiceAccountKey(saKeyRaw) ?? buildServiceAccountFromFallbackVars(saKeyRaw);
    if (!parsedKey) throw new Error("Vertex AI service account configuration is invalid");
    saKey = parsedKey;
  }

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

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text().catch(() => "unknown");
    throw new Error(`Failed to get Google access token: ${tokenRes.status} ${err}`);
  }

  const tokenData = await tokenRes.json();
  _cachedToken = {
    token: tokenData.access_token,
    expiresAt: now + (tokenData.expires_in ?? 3600),
  };

  return _cachedToken.token;
}

// ---------------------------------------------------------------------------
// Vertex AI Gemini API call
// ---------------------------------------------------------------------------

export interface VertexAIOptions {
  systemPrompt?: string;
  userPrompt: string;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Response MIME type — "application/json" (default) or "text/plain" for raw text output */
  responseMimeType?: string;
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
    throw new Error("Neither VERTEX_PROJECT_ID nor GOOGLE_PROJECT_ID environment variable is set");
  }

  const primaryLocation = Deno.env.get("VERTEX_LOCATION") || Deno.env.get("GOOGLE_LOCATION") || "us-central1";
  const primaryModel = opts.model ?? DEFAULT_MODEL;

  // Ordered list of (location, model) to try if primary fails with 404
  const attempts = buildVertexAttempts(primaryLocation, primaryModel);

  const accessToken = await getAccessToken();
  let lastError: Error | null = null;

  for (const { loc, mod } of attempts) {
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

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(30000),
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
        console.log(`[vertex-ai] Success with ${mod} in ${loc}`);
        return { content, model: mod, inputTokens, outputTokens };
      }

      if (response.status === 404) {
        console.warn(`[vertex-ai] 404 NOT FOUND: Project=${projectId}, Model=${mod}, Loc=${loc}, URL=${url}. Ensure Vertex AI API is enabled in this project.`);
        continue;
      }

      const errText = await response.text().catch(() => "unknown error");
      throw new Error(`Vertex AI API error ${response.status}: ${errText}`);
    } catch (err) {
      lastError = err;
      if (
        err.message.includes("404") ||
        err?.name === "TimeoutError" ||
        err?.name === "AbortError"
      ) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          console.warn(`[vertex-ai] Request to ${mod} in ${loc} timed out after 30s; trying next`);
        }
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All Vertex AI model attempts failed with 404");
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
  for (const { loc, mod } of buildVertexAttempts(primaryLocation, primaryModel)) {
    const url = `https://${loc}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${loc}/publishers/google/models/${mod}:generateContent`;
    try {
      console.log(`[vertex-ai] Trying file model ${mod} in ${loc}...`);
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
        console.warn(`[vertex-ai] File model 404 for ${mod} in ${loc}: ${errText.slice(0, 220)}`);
        continue;
      }
      if (response.status === 400) {
        // 400 = bad request. This usually means the file is too large, the MIME type
        // is unsupported, or the request format is wrong — none of which a different
        // model or location can fix. Throw immediately to surface the real error.
        throw lastError;
      }
      throw lastError;
    } catch (err) {
      lastError = err;
      if (
        String(err.message || "").includes("404") ||
        err?.name === "TimeoutError" ||
        err?.name === "AbortError"
      ) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
          console.warn(`[vertex-ai] File request to ${mod} in ${loc} timed out after 60s; trying next`);
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
  const locations = uniqueStrings([primaryLocation, "global", "us-central1", "us-east4"]);
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

  const attempts: Array<{ loc: string; mod: string }> = [];
  for (const loc of locations) {
    for (const mod of models) {
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

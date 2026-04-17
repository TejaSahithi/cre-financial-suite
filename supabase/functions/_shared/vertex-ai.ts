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
      if (err.message.includes("404")) continue;
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

  try {
    return JSON.parse(text) as T;
  } catch {
    console.error("[vertex-ai] Failed to parse JSON response:", text.slice(0, 300));
    return null;
  }
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

  // Encode file bytes as base64 safely
  let base64Data: string;
  if (opts.fileBase64) {
    base64Data = opts.fileBase64;
  } else if (opts.fileBytes) {
    base64Data = uint8ToBase64(opts.fileBytes);
  } else {
    throw new Error("Must provide either fileBase64 or fileBytes");
  }

  const genConfig: Record<string, unknown> = {
    maxOutputTokens: opts.maxOutputTokens ?? 4096,
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
            inlineData: {
              mimeType: opts.fileMimeType,
              data: base64Data,
            },
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
      });

      if (response.ok) {
        const data = await response.json();
        const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
        const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;
        console.log(`[vertex-ai] File success with ${mod} in ${loc}`);
        return { content, model: mod, inputTokens, outputTokens };
      }

      const errText = await response.text().catch(() => "unknown error");
      lastError = new Error(`Vertex AI API error ${response.status}: ${errText}`);
      if (response.status === 404 || response.status === 400) {
        console.warn(`[vertex-ai] File model failed (${response.status}) ${mod} in ${loc}: ${errText.slice(0, 220)}`);
        continue;
      }
      throw lastError;
    } catch (err) {
      lastError = err;
      if (String(err.message || "").includes("404") || String(err.message || "").includes("400")) {
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("All Vertex AI file model attempts failed");
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Supabase Edge isolates are memory constrained. Avoid Array.from(bytes)
  // because it creates a second full-size JS number array before encoding.
  const chunkSize = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    let chunkString = "";
    for (let j = 0; j < chunk.length; j++) {
      chunkString += String.fromCharCode(chunk[j]);
    }
    binary += chunkString;
  }
  return btoa(binary);
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

/**
 * Call Vertex AI with a file and parse the response as JSON.
 */
export async function callVertexAIFileJSON<T = unknown>(opts: VertexAIFileOptions): Promise<T | null> {
  const response = await callVertexAIWithFile(opts);
  let text = response.content.trim();
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(text) as T;
  } catch {
    console.error("[vertex-ai] Failed to parse file JSON response:", text.slice(0, 300));
    return null;
  }
}

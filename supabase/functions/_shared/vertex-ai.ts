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

const DEFAULT_MODEL = "gemini-1.5-pro-002";

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
  if (!saKeyRaw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY environment variable is not set");
  }

  let saKey: ServiceAccountKey;
  try {
    saKey = JSON.parse(saKeyRaw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON");
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
 */
export async function callVertexAI(opts: VertexAIOptions): Promise<VertexAIResponse> {
  const projectId = Deno.env.get("VERTEX_PROJECT_ID") || Deno.env.get("GOOGLE_PROJECT_ID");
  const location = Deno.env.get("VERTEX_LOCATION") || Deno.env.get("GOOGLE_LOCATION") || "us-central1";

  if (!projectId) {
    throw new Error("Neither VERTEX_PROJECT_ID nor GOOGLE_PROJECT_ID environment variable is set");
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const accessToken = await getAccessToken();

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  // Build the request body
  const contents: unknown[] = [];

  // System instruction (Gemini 1.5 supports systemInstruction)
  const requestBody: Record<string, unknown> = {
    contents: [
      {
        role: "user",
        parts: [{ text: opts.userPrompt }],
      },
    ],
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
      temperature: opts.temperature ?? 0,
      responseMimeType: "application/json", // Request JSON output directly
    },
  };

  if (opts.systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    throw new Error(`Vertex AI API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

  return { content, model, inputTokens, outputTokens };
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
  const location = Deno.env.get("VERTEX_LOCATION") || Deno.env.get("GOOGLE_LOCATION") || "us-central1";

  if (!projectId) {
    throw new Error("Neither VERTEX_PROJECT_ID nor GOOGLE_PROJECT_ID environment variable is set");
  }

  const model = opts.model ?? DEFAULT_MODEL;
  const accessToken = await getAccessToken();

  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`;

  // Encode file bytes as base64 safely
  let base64Data: string;
  if (opts.fileBase64) {
    base64Data = opts.fileBase64;
  } else if (opts.fileBytes) {
    // Avoid "Maximum call stack size exceeded" by avoiding spread operator
    base64Data = btoa(Array.from(opts.fileBytes).map(b => String.fromCharCode(b)).join(""));
  } else {
    throw new Error("Must provide either fileBase64 or fileBytes");
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
    generationConfig: {
      maxOutputTokens: opts.maxOutputTokens ?? 4096,
      temperature: opts.temperature ?? 0,
      responseMimeType: "application/json",
    },
  };

  if (opts.systemPrompt) {
    requestBody.systemInstruction = {
      parts: [{ text: opts.systemPrompt }],
    };
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "unknown error");
    throw new Error(`Vertex AI API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const inputTokens = data.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = data.usageMetadata?.candidatesTokenCount ?? 0;

  return { content, model, inputTokens, outputTokens };
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

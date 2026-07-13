// @ts-nocheck

export interface AzureDocumentIntelligenceConfig {
  endpoint: string | null;
  keyPresent: boolean;
  apiVersion: string;
  modelId: string;
  configuredOutputFormat: string | null;
  outputFormat: string;
  effectiveOutputFormat: string;
  outputFormatWasForced: boolean;
}

export interface AzureAnalyzeLayoutArgs {
  fileBytes?: Uint8Array | null;
  fileUrl?: string | null;
  mimeType?: string | null;
}

const DEFAULT_API_VERSION = "2024-11-30";
const DEFAULT_MODEL_ID = "prebuilt-layout";
const DEFAULT_OUTPUT_FORMAT = "markdown";
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 1_000;

export function getAzureDocumentIntelligenceConfig(): AzureDocumentIntelligenceConfig {
  const configuredOutputFormat = Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_OUTPUT_FORMAT")?.trim() || null;
  const effectiveOutputFormat = getEffectiveAzureOutputFormat(configuredOutputFormat);
  return {
    endpoint: cleanEndpoint(Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT")),
    keyPresent: !!Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_KEY"),
    apiVersion: Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_API_VERSION") || DEFAULT_API_VERSION,
    modelId: Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID") || DEFAULT_MODEL_ID,
    configuredOutputFormat,
    outputFormat: effectiveOutputFormat,
    effectiveOutputFormat,
    outputFormatWasForced: !!configuredOutputFormat && configuredOutputFormat.toLowerCase() !== DEFAULT_OUTPUT_FORMAT,
  };
}

export function getEffectiveAzureOutputFormat(_configured?: string | null): string {
  return DEFAULT_OUTPUT_FORMAT;
}

export async function analyzeWithAzureLayout(args: AzureAnalyzeLayoutArgs): Promise<Record<string, unknown>> {
  const endpoint = cleanEndpoint(Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT"));
  const key = Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_KEY");
  const apiVersion = Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_API_VERSION") || DEFAULT_API_VERSION;
  const modelId = Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID") || DEFAULT_MODEL_ID;
  const outputFormat = getEffectiveAzureOutputFormat(Deno.env.get("AZURE_DOCUMENT_INTELLIGENCE_OUTPUT_FORMAT"));

  if (!endpoint) {
    throw new Error("Azure Document Intelligence endpoint is not configured");
  }
  if (!key) {
    throw new Error("Azure Document Intelligence key is not configured");
  }

  const submitUrl =
    `${endpoint}/documentintelligence/documentModels/${encodeURIComponent(modelId)}:analyze` +
    `?_overload=analyzeDocument` +
    `&api-version=${encodeURIComponent(apiVersion)}` +
    `&outputContentFormat=${encodeURIComponent(outputFormat)}`;

  let submitError: Error | null = null;
  if (args.fileUrl) {
    try {
      return await submitAndPoll({
        submitUrl,
        key,
        body: { urlSource: args.fileUrl },
        apiVersion,
        modelId,
      });
    } catch (error) {
      submitError = error;
      if (!args.fileBytes || args.fileBytes.length === 0) throw error;
      console.warn(`[azure-document-intelligence] urlSource failed; retrying with base64Source: ${error?.message ?? error}`);
    }
  }

  if (!args.fileBytes || args.fileBytes.length === 0) {
    throw submitError || new Error("Azure Document Intelligence requires fileUrl or fileBytes");
  }

  return await submitAndPoll({
    submitUrl,
    key,
    body: { base64Source: uint8ToBase64(args.fileBytes) },
    apiVersion,
    modelId,
  });
}

async function submitAndPoll(opts: {
  submitUrl: string;
  key: string;
  body: Record<string, unknown>;
  apiVersion: string;
  modelId: string;
}): Promise<Record<string, unknown>> {
  const submit = await fetch(opts.submitUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Ocp-Apim-Subscription-Key": opts.key,
    },
    body: JSON.stringify(opts.body),
    signal: AbortSignal.timeout(30_000),
  });

  if (!submit.ok) {
    const text = await submit.text().catch(() => "");
    throw new Error(`Azure Document Intelligence submit failed (${submit.status}): ${text.slice(0, 500)}`);
  }

  const operationLocation = submit.headers.get("operation-location") || submit.headers.get("Operation-Location");
  if (!operationLocation) {
    throw new Error("Azure Document Intelligence submit succeeded but Operation-Location header was missing");
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < DEFAULT_TIMEOUT_MS) {
    await delay(POLL_INTERVAL_MS);
    const poll = await fetch(operationLocation, {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": opts.key,
      },
      signal: AbortSignal.timeout(30_000),
    });

    const text = await poll.text().catch(() => "");
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw_response: text };
    }

    if (!poll.ok) {
      throw new Error(`Azure Document Intelligence polling failed (${poll.status}): ${text.slice(0, 500)}`);
    }

    const status = String(payload.status || "").toLowerCase();
    if (status === "succeeded") {
      const analyzeResult = payload.analyzeResult;
      if (!analyzeResult || typeof analyzeResult !== "object") {
        throw new Error("Azure Document Intelligence succeeded but analyzeResult was missing");
      }
      return analyzeResult as Record<string, unknown>;
    }
    if (status === "failed") {
      throw new Error(`Azure Document Intelligence analysis failed: ${JSON.stringify(payload.error || payload).slice(0, 500)}`);
    }
  }

  throw new Error(`Azure Document Intelligence analysis timed out after ${DEFAULT_TIMEOUT_MS / 1000}s`);
}

function cleanEndpoint(value: string | undefined | null): string | null {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  return endpoint || null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x6000;
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    let binary = "";
    for (let i = 0; i < chunk.length; i += 1) {
      binary += String.fromCharCode(chunk[i]);
    }
    chunks.push(btoa(binary));
  }
  return chunks.join("");
}
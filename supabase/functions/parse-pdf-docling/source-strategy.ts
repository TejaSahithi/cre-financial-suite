export const DEFAULT_LOCAL_AZURE_MAX_BYTES = 10 * 1024 * 1024;

export type SourceUrlCategory =
  | "localhost"
  | "127.0.0.1"
  | "kong"
  | "public_https"
  | "other"
  | "missing"
  | "invalid";

export interface AzureSourceStrategyInput {
  strictAzureMode: boolean;
  localSupabaseRuntime: boolean;
  sourceUrl?: string | null;
  fileSizeBytes?: number | null;
  maxLocalAzureBytes?: number;
}

export interface AzureSourceStrategy {
  category: SourceUrlCategory;
  loadBytesFromStorage: boolean;
  sendUrlToAzure: boolean;
  reason: string;
}

export function categorizeSourceUrl(sourceUrl?: string | null): SourceUrlCategory {
  const text = String(sourceUrl || "").trim();
  if (!text) return "missing";

  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    if (host === "localhost") return "localhost";
    if (host === "127.0.0.1") return "127.0.0.1";
    if (host === "kong") return "kong";
    if (url.protocol === "https:") return "public_https";
    return "other";
  } catch {
    return "invalid";
  }
}

export function shouldUseLocalAzureByteSource(input: AzureSourceStrategyInput): AzureSourceStrategy {
  const category = categorizeSourceUrl(input.sourceUrl);
  const maxBytes = input.maxLocalAzureBytes ?? DEFAULT_LOCAL_AZURE_MAX_BYTES;
  const localOnlyUrl = category === "localhost" || category === "127.0.0.1" || category === "kong";

  if (!input.strictAzureMode) {
    return { category, loadBytesFromStorage: false, sendUrlToAzure: true, reason: "not_strict_azure_mode" };
  }

  if (!input.localSupabaseRuntime) {
    return { category, loadBytesFromStorage: false, sendUrlToAzure: true, reason: "not_local_runtime" };
  }

  if (!localOnlyUrl) {
    return { category, loadBytesFromStorage: false, sendUrlToAzure: true, reason: "url_not_local_only" };
  }

  const fileSizeBytes = Number(input.fileSizeBytes || 0);
  if (fileSizeBytes <= 0) {
    throw new Error("Cannot use local Azure byte source without a known file size");
  }
  if (fileSizeBytes > maxBytes) {
    throw new Error(
      `Local Azure byte source size guard blocked ${fileSizeBytes} byte file; max ${maxBytes} bytes`,
    );
  }

  return { category, loadBytesFromStorage: true, sendUrlToAzure: false, reason: "local_runtime_local_url" };
}

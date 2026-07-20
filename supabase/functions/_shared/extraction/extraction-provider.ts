export type ExtractionProviderMode =
  | "legacy"
  | "azure_document_intelligence"
  | "azure_with_legacy_fallback"
  | "shadow_compare";

const SUPPORTED_PROVIDERS = new Set<ExtractionProviderMode>([
  "azure_document_intelligence",
]);

export function normalizeExtractionProvider(value: unknown): ExtractionProviderMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  return SUPPORTED_PROVIDERS.has(normalized as ExtractionProviderMode)
    ? normalized as ExtractionProviderMode
    : "azure_document_intelligence";
}

export function resolveExtractionProvider(providerOverride?: unknown): {
  mode: ExtractionProviderMode;
  source: "override" | "env" | "default";
} {
  if (providerOverride != null && String(providerOverride).trim()) {
    return { mode: normalizeExtractionProvider(providerOverride), source: "override" };
  }

  const envProvider = Deno.env.get("EXTRACTION_PROVIDER");
  if (envProvider && envProvider.trim()) {
    return { mode: normalizeExtractionProvider(envProvider), source: "env" };
  }

  return { mode: "azure_document_intelligence", source: "default" };
}

export function shouldUseAzureLayout(mode: ExtractionProviderMode): boolean {
  return mode === "azure_document_intelligence" ||
    mode === "azure_with_legacy_fallback" ||
    mode === "shadow_compare";
}

export function shouldFallbackToLegacy(mode: ExtractionProviderMode): boolean {
  return false;
}

export function isAzureLayoutOutput(doclingRaw: Record<string, unknown> | null | undefined): boolean {
  if (!doclingRaw) return false;
  const metadata = doclingRaw._metadata as Record<string, unknown> | undefined;
  return doclingRaw.extraction_method === "azure_layout" ||
    metadata?.provider === "azure_document_intelligence";
}

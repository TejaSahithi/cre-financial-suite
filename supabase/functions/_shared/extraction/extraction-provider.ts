/**
 * Azure Document Intelligence is the only supported document parser
 * backend. Provider selection fails closed: an explicitly supplied but
 * unsupported value (e.g. a deprecated "vertex_ai"/"docling"/"vision_only"
 * string) throws instead of being silently remapped to Azure.
 */
export type ExtractionProviderMode = "azure_document_intelligence";

const SUPPORTED_PROVIDERS = new Set<ExtractionProviderMode>([
  "azure_document_intelligence",
]);

export class UnsupportedExtractionProviderError extends Error {
  constructor(public readonly value: string, public readonly source: "override" | "env") {
    super(
      `Unsupported extraction provider "${value}" (from ${source}). Only ` +
        `"azure_document_intelligence" is supported. Deprecated/legacy provider ` +
        `values (e.g. vertex_ai, docling, vision_only, vision_first, gemini_vision, ` +
        `legacy, azure_with_legacy_fallback, shadow_compare) are not accepted.`,
    );
    this.name = "UnsupportedExtractionProviderError";
  }
}

function normalizeExplicitProvider(value: unknown, source: "override" | "env"): ExtractionProviderMode {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (SUPPORTED_PROVIDERS.has(normalized as ExtractionProviderMode)) {
    return normalized as ExtractionProviderMode;
  }
  throw new UnsupportedExtractionProviderError(normalized, source);
}

export function resolveExtractionProvider(providerOverride?: unknown): {
  mode: ExtractionProviderMode;
  source: "override" | "env" | "default";
} {
  if (providerOverride != null && String(providerOverride).trim()) {
    return { mode: normalizeExplicitProvider(providerOverride, "override"), source: "override" };
  }

  const envProvider = Deno.env.get("EXTRACTION_PROVIDER");
  if (envProvider && envProvider.trim()) {
    return { mode: normalizeExplicitProvider(envProvider, "env"), source: "env" };
  }

  return { mode: "azure_document_intelligence", source: "default" };
}

export function isAzureLayoutOutput(doclingRaw: Record<string, unknown> | null | undefined): boolean {
  if (!doclingRaw) return false;
  const metadata = doclingRaw._metadata as Record<string, unknown> | undefined;
  return doclingRaw.extraction_method === "azure_layout" ||
    metadata?.provider === "azure_document_intelligence";
}

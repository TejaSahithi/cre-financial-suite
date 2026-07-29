// @ts-nocheck

import { normalizeBusinessExtractionMode, type CanonicalBusinessExtractionMode } from "./business-extraction-provenance.ts";
import { isLeaseModuleType } from "./lease-module.ts";
import { isWholeDocumentLlmActive } from "./whole-document-llm/feature-mode.ts";

export const DEFAULT_LIVE_BUSINESS_EXTRACTION_PROVIDER = "openai_primary_legacy_fallback";

export function resolveBusinessExtractionProvider(
  internalDebugOverride?: string | null,
): CanonicalBusinessExtractionMode {
  const override = String(internalDebugOverride ?? "").trim().toLowerCase();
  if (override) return normalizeBusinessExtractionMode(override, { source: "override" });
  const envValue = Deno.env.get("BUSINESS_EXTRACTION_PROVIDER");
  return normalizeBusinessExtractionMode(
    envValue && envValue.trim() ? envValue : DEFAULT_LIVE_BUSINESS_EXTRACTION_PROVIDER,
    { source: "env" },
  );
}

/**
 * Lease extraction has one live strategy while whole-document extraction is
 * active: primary whole-document OpenAI, with sectioned LLM continuation for
 * oversize documents. The provider name remains `openai_primary_legacy_fallback`
 * for compatibility, but legacy_hybrid is a rollback switch, not the default.
 */
export function enforceLeaseExtractionArchitecture(
  moduleType: string,
  configuredProvider: CanonicalBusinessExtractionMode,
): CanonicalBusinessExtractionMode {
  return isLeaseModuleType(moduleType) && isWholeDocumentLlmActive()
    ? "openai_primary_legacy_fallback"
    : configuredProvider;
}

export function wholeDocumentExtractionMode(result: Record<string, any>): string | null {
  return result?.metadata?.extractionDebug?.openai_fact_ledger?.extraction_mode
    ?? result?.metadata?.extractionDebug?.vertex_fact_ledger?.extraction_mode
    ?? null;
}

function leaseTypescriptLegacyFallbackEnabled(): boolean {
  return ["1", "true", "yes", "on"].includes(
    String(Deno.env.get("LEASE_ENABLE_TYPESCRIPT_LEGACY_FALLBACK") ?? "").trim().toLowerCase(),
  );
}

export function assertAuthoritativeLeaseExtractionResult(
  moduleType: string,
  result: Record<string, any>,
): void {
  if (!isLeaseModuleType(moduleType) || !isWholeDocumentLlmActive()) return;
  const provenance = result?.metadata?.provenance ?? null;
  if (
    provenance?.fallback_used === true &&
    provenance?.effective_provider === "legacy_hybrid" &&
    leaseTypescriptLegacyFallbackEnabled()
  ) return;
  const actualMode = wholeDocumentExtractionMode(result);
  if (actualMode !== "whole_document_llm_v2") {
    throw new Error(
      `LEASE_EXTRACTION_ARCHITECTURE_VIOLATION: expected whole_document_llm_v2 but received ${actualMode ?? "no extraction_mode"}. ` +
      `Legacy fact-ledger/TypeScript field mapping is not permitted while LEASE_WHOLE_DOCUMENT_LLM_V1 is active.`,
    );
  }
}
